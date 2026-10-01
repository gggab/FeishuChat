import { AxiosInstance } from 'axios';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createServer, Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { AuditLogger } from '../src/audit.js';
import { AppConfig } from '../src/config.js';
import { FeishuClient } from '../src/feishu.js';
import { OAuthStateStore } from '../src/oauthState.js';
import { RateLimiter } from '../src/rateLimit.js';
import { SentryProjectStore } from '../src/sentryProjectStore.js';
import { TokenStore } from '../src/tokenStore.js';

const KEY = 'd'.repeat(64);
const SENTRY_SECRET = 'sentry-client-secret';
const CHAT_ID = 'oc_alert_chat';

function sign(body: string, secret = SENTRY_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('POST /webhooks/sentry', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let feishuPost: ReturnType<typeof vi.fn>;
  let projectStore: SentryProjectStore;

  const config: AppConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    tokenEncryptionKey: KEY,
    port: 0,
    publicBaseUrl: 'http://public.example:3000',
    dataDir: '',
    logDir: '',
    sentryWebhookSecret: SENTRY_SECRET,
    feishuAlertChatId: CHAT_ID,
    adminToken: 'admin-test',
  };

  function buildTestApp(testConfig: AppConfig) {
    const feishu = new FeishuClient(testConfig.appId, testConfig.appSecret, {
      post: feishuPost,
      get: vi.fn(),
    } as unknown as AxiosInstance);
    return createApp({
      config: testConfig,
      feishu,
      tokenStore: new TokenStore({ filePath: path.join(dir, 'tokens.json'), encryptionKey: KEY }),
      stateStore: new OAuthStateStore(),
      audit: new AuditLogger(dir),
      rateLimiter: new RateLimiter(60, 60_000),
      sentryProjectStore: projectStore,
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-test-'));
    config.dataDir = dir;
    config.logDir = dir;
    projectStore = new SentryProjectStore(path.join(dir, 'sentryProjects.json'));
    feishuPost = vi.fn().mockImplementation((url: string) => {
      if (url === '/auth/v3/tenant_access_token/internal') {
        return Promise.resolve({ data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } });
      }
      return Promise.resolve({ data: { code: 0, msg: 'success', data: {} } });
    });
    server = createServer(buildTestApp(config));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function postAlert(body: string, signature: string, resource = 'event_alert') {
    return fetch(`${baseUrl}/webhooks/sentry`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Sentry-Hook-Signature': signature,
        'Sentry-Hook-Resource': resource,
      },
      body,
    });
  }

  const alertBody = JSON.stringify({
    action: 'triggered',
    data: {
      triggered_rule: '规则A',
      event: { title: 'NullPointerException', level: 'error', web_url: 'https://sentry.example.com/i/9/' },
    },
  });

  it('正文诊断按开关输出异常多行原文和当前摘要，不输出完整 payload', async () => {
    const previous = process.env.SENTRY_DEBUG_TEXT;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const title = 'ApiBusinessError: Unknown error';
    const value = 'Unknown error\nCode: 42\nURL: /api/example';
    const body = JSON.stringify({ action: 'triggered', data: { event: {
      title, exception: { values: [{ type: 'ApiBusinessError', value }] },
      request: { headers: { Authorization: 'must-not-be-logged' } },
    } } });
    try {
      process.env.SENTRY_DEBUG_TEXT = '0';
      expect((await postAlert(body, sign(body))).status).toBe(200);
      expect(log.mock.calls.some(([prefix]) => prefix === '[sentry:text-debug]')).toBe(false);
      process.env.SENTRY_DEBUG_TEXT = '1';
      expect((await postAlert(body, sign(body))).status).toBe(200);
      const debug = log.mock.calls.find(([prefix]) => prefix === '[sentry:text-debug]');
      expect(debug).toBeDefined();
      expect(JSON.parse(debug![1])).toMatchObject({
        title, cardSummary: title, exception: [{ type: 'ApiBusinessError', value }],
      });
      expect(debug![1]).not.toContain('must-not-be-logged');
    } finally {
      if (previous === undefined) delete process.env.SENTRY_DEBUG_TEXT;
      else process.env.SENTRY_DEBUG_TEXT = previous;
      log.mockRestore();
    }
  });

  it('验签通过则立即返回 200（不等飞书那一趟网络往返），随后异步转发卡片到目标群', async () => {
    const resp = await postAlert(alertBody, sign(alertBody));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);

    // 响应已经先发出去了，飞书发送是异步的：等它真正发生再断言，而不是假设已经完成
    await vi.waitFor(() => {
      expect(feishuPost.mock.calls.some(([url]) => String(url).startsWith('/im/v1/messages'))).toBe(true);
    });
    const sendCall = feishuPost.mock.calls.find(([url]) => String(url).startsWith('/im/v1/messages'));
    const [, payload, options] = sendCall!;
    expect(payload.receive_id).toBe(CHAT_ID);
    expect(payload.msg_type).toBe('interactive');
    expect(payload.content).toContain('NullPointerException');
    expect(payload.content).toContain('规则A');
    expect(options.headers.Authorization).toBe('Bearer t-1');
  });

  it('飞书发送失败（如群不存在/机器人不在群）时响应早已发出，失败只记日志不影响 Sentry 侧', async () => {
    feishuPost.mockImplementation((url: string) => {
      if (url === '/auth/v3/tenant_access_token/internal') {
        return Promise.resolve({ data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } });
      }
      return Promise.resolve({ data: { code: 230001, msg: 'bot is not in the chat' } });
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resp = await postAlert(alertBody, sign(alertBody));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    // 响应在飞书调用之前就已经发出，此时还不知道发送会不会失败，所以响应体里不再带 skipped
    expect(body).toEqual({ ok: true });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('发送到群'), expect.anything());
    });
    errorSpy.mockRestore();
  });

  it('项目映射带时区时，卡片时间按该项目专属的时区显示（不同项目/群各自独立，不是网关全局一个时区）', async () => {
    const projectStore = new SentryProjectStore(path.join(dir, 'perProjectTz.json'));
    projectStore.upsert('4', 'oc_china', 'Asia/Shanghai');
    projectStore.upsert('5', 'oc_riyadh', 'Asia/Riyadh');
    const feishu = new FeishuClient(config.appId, config.appSecret, { post: feishuPost, get: vi.fn() } as unknown as AxiosInstance);
    const testServer = createServer(
      createApp({
        config,
        feishu,
        tokenStore: new TokenStore({ filePath: path.join(dir, 'tokens.json'), encryptionKey: KEY }),
        stateStore: new OAuthStateStore(),
        audit: new AuditLogger(dir),
        rateLimiter: new RateLimiter(60, 60_000),
        sentryProjectStore: projectStore,
      }),
    );
    await new Promise<void>((resolve) => testServer.listen(0, '127.0.0.1', resolve));
    const testBase = `http://127.0.0.1:${(testServer.address() as AddressInfo).port}`;
    try {
      const bodyForProject = (projectId: number) =>
        JSON.stringify({
          action: 'triggered',
          data: { event: { title: 'x', level: 'error', project: projectId, datetime: '2026-09-09T10:05:18.224000Z', web_url: 'https://sentry.example.com/i/9/' } },
        });

      const chinaBody = bodyForProject(4);
      await fetch(`${testBase}/webhooks/sentry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sentry-Hook-Signature': sign(chinaBody), 'Sentry-Hook-Resource': 'event_alert' },
        body: chinaBody,
      });
      await vi.waitFor(() => {
        expect(feishuPost.mock.calls.some(([url, payload]: [string, any]) => url.startsWith('/im/v1/messages') && payload.receive_id === 'oc_china')).toBe(
          true,
        );
      });
      const chinaCall = feishuPost.mock.calls.find(([url, payload]: [string, any]) => url.startsWith('/im/v1/messages') && payload.receive_id === 'oc_china');
      expect(chinaCall![1].content).toContain('2026-09-09 18:05:18 (UTC+08:00)');

      const riyadhBody = bodyForProject(5);
      await fetch(`${testBase}/webhooks/sentry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sentry-Hook-Signature': sign(riyadhBody), 'Sentry-Hook-Resource': 'event_alert' },
        body: riyadhBody,
      });
      await vi.waitFor(() => {
        expect(
          feishuPost.mock.calls.some(([url, payload]: [string, any]) => url.startsWith('/im/v1/messages') && payload.receive_id === 'oc_riyadh'),
        ).toBe(true);
      });
      const riyadhCall = feishuPost.mock.calls.find(
        ([url, payload]: [string, any]) => url.startsWith('/im/v1/messages') && payload.receive_id === 'oc_riyadh',
      );
      expect(riyadhCall![1].content).toContain('2026-09-09 13:05:18 (UTC+03:00)');
    } finally {
      await new Promise<void>((resolve) => testServer.close(() => resolve()));
    }
  });

  it('未映射项目且默认群为空时跳过发送', async () => {
    const noDefault: AppConfig = { ...config, feishuAlertChatId: undefined };
    const noDefaultServer = createServer(buildTestApp(noDefault));
    await new Promise<void>((resolve) => noDefaultServer.listen(0, '127.0.0.1', resolve));
    const noDefaultBase = `http://127.0.0.1:${(noDefaultServer.address() as AddressInfo).port}`;
    try {
      const undiscoveredBody = JSON.stringify({ action: 'triggered', data: { event: { title: 'x', project: 9, environment: 'production' } } });
      const resp = await fetch(`${noDefaultBase}/webhooks/sentry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sentry-Hook-Signature': sign(undiscoveredBody),
          'Sentry-Hook-Resource': 'event_alert',
        },
        body: undiscoveredBody,
      });
      expect(resp.status).toBe(200);
      const body = await resp.json();
      expect(body.skipped).toBe('no_chat_id');
      expect(feishuPost).not.toHaveBeenCalled();
      expect(new SentryProjectStore(path.join(dir, 'sentryProjects.json')).list()).toEqual([
        expect.objectContaining({ projectId: '9', environment: 'production', chatId: '' }),
      ]);
    } finally {
      await new Promise<void>((resolve) => noDefaultServer.close(() => resolve()));
    }
  });

  it('自动发现并持久化待配置项目/环境，重复不新增，管理员补群后立即生效', async () => {
    projectStore.upsert('4', 'oc_project', 'Asia/Shanghai');
    projectStore.enrich('4', { name: 'Dashboard', slug: 'dashboard' });
    const event = { title: 'x', project: 4, environment: ' staging ', datetime: '2026-09-09T10:05:18Z' };
    const send = async (data: object, chatId: string, time?: string) => {
      feishuPost.mockClear();
      const body = JSON.stringify({ action: 'triggered', data: { event: data } });
      expect(await (await postAlert(body, sign(body))).json()).toEqual({ ok: true });
      await vi.waitFor(() => {
        const sends = feishuPost.mock.calls.filter(([url]) => String(url).startsWith('/im/v1/messages'));
        expect(sends).toHaveLength(1);
        expect(sends[0][1].receive_id).toBe(chatId);
        if (time) expect(sends[0][1].content).toContain(time);
      });
    };
    await send(event, 'oc_project', '2026-09-09 18:05:18 (UTC+08:00)');
    const pending = projectStore.list().find(record => record.environment === 'staging')!;
    expect(pending).toMatchObject({ projectId: '4', chatId: '', name: 'Dashboard', slug: 'dashboard' });
    const savedFile = fs.readFileSync(path.join(dir, 'sentryProjects.json'), 'utf8');
    await send(event, 'oc_project', '2026-09-09 18:05:18 (UTC+08:00)');
    expect(fs.readFileSync(path.join(dir, 'sentryProjects.json'), 'utf8')).toBe(savedFile);
    expect(projectStore.list()).toHaveLength(2);

    await send({ ...event, project: 5, environment: 'production' }, CHAT_ID);
    await send({ ...event, project: 6, environment: undefined }, CHAT_ID);
    const reloaded = new SentryProjectStore(path.join(dir, 'sentryProjects.json'));
    expect(reloaded.list()).toHaveLength(4);
    expect(reloaded.get('4', 'staging')?.chatId).toBe('oc_project');
    expect(reloaded.get('5', 'production')).toBeUndefined();
    expect(reloaded.list()).toContainEqual(expect.objectContaining({ projectId: '6', chatId: '' }));
    const headers = { 'X-Admin-Token': 'admin-test', 'Content-Type': 'application/json' };
    expect(await (await fetch(`${baseUrl}/admin/sentry-projects/api`, { headers })).json()).toEqual(reloaded.list());
    expect((await fetch(`${baseUrl}/admin/sentry-projects/api`, {
      method: 'POST', headers, body: JSON.stringify({ projectId: '4', environment: 'staging', chatId: 'oc_stage', timezone: 'UTC' }),
    })).status).toBe(200);
    await send(event, 'oc_stage', '2026-09-09 10:05:18 (UTC+00:00)');
    expect(projectStore.get('4', 'staging')).toMatchObject({ chatId: 'oc_stage', createdAt: pending.createdAt, name: 'Dashboard' });
  });

  it('保存待配置记录失败时仍转发告警，下一次告警重试保存', async () => {
    const failure = new Error('disk unavailable');
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw failure; });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const body = JSON.stringify({ action: 'triggered', data: { event: { title: 'x', project: 4, environment: 'staging' } } });
      expect(await (await postAlert(body, sign(body))).json()).toEqual({ ok: true });
      expect(error).toHaveBeenCalledWith('[sentry] 保存项目/环境配置失败：', failure);
      await vi.waitFor(() => expect(feishuPost.mock.calls.some(([url, payload]) => String(url).startsWith('/im/v1/messages') && payload.receive_id === CHAT_ID)).toBe(true));
      expect(projectStore.list()).toEqual([]);
      rename.mockRestore();
      expect((await postAlert(body, sign(body))).status).toBe(200);
      expect(new SentryProjectStore(path.join(dir, 'sentryProjects.json')).list()).toEqual([
        expect.objectContaining({ projectId: '4', environment: 'staging', chatId: '' }),
      ]);
    } finally {
      rename.mockRestore();
      error.mockRestore();
    }
  });

  it('按项目和环境路由，未匹配时逐级回退，卡片使用最终目标群的时区', async () => {
    projectStore.upsert('4', 'oc_project', 'UTC');
    projectStore.upsert('4', 'oc_prod', 'Asia/Riyadh', 'production');
    projectStore.upsert('4', 'oc_stage', 'Asia/Shanghai', 'staging');
    projectStore.upsert('5', 'oc_other_prod', 'UTC', 'production');
    const event = { title: 'x', project: 4, datetime: '2026-09-09T10:05:18Z' };
    const issue = { title: 'x', project: { id: 4, slug: 'dashboard', name: 'Dashboard' }, lastSeen: '2026-09-09T10:05:18Z' };
    const cases = [
      { resource: 'event_alert', data: { event: { ...event, environment: 'production' } }, chatId: 'oc_prod', time: '2026-09-09 13:05:18 (UTC+03:00)' },
      { resource: 'event_alert', data: { event: { ...event, tags: [['environment', 'staging']] } }, chatId: 'oc_stage', time: '2026-09-09 18:05:18 (UTC+08:00)' },
      { resource: 'error', data: { error: { ...event, tags: [{ key: 'environment', value: 'staging' }] } }, chatId: 'oc_stage', time: '2026-09-09 18:05:18 (UTC+08:00)' },
      { resource: 'issue', data: { issue: { ...issue, environment: 'production' } }, chatId: 'oc_prod' },
      { resource: 'activity_alert', data: { issue: { ...issue, tags: [['environment', 'staging']] }, activity: { type: 'status_resolved' } }, chatId: 'oc_stage', time: '2026-09-09 18:05:18 (UTC+08:00)' },
      { resource: 'activity_alert', data: { issue: { ...issue, environment: 'production' }, activity: { type: 'unknown' } }, chatId: 'oc_prod' },
      { resource: 'event_alert', data: { event: { ...event, environment: 'Production' } }, chatId: 'oc_project', time: '2026-09-09 10:05:18 (UTC+00:00)' },
      { resource: 'event_alert', data: { event }, chatId: 'oc_project' },
      { resource: 'event_alert', data: { event: { ...event, project: 5, environment: 'production' } }, chatId: 'oc_other_prod' },
      { resource: 'event_alert', data: { event: { ...event, project: 5, environment: 'staging' } }, chatId: CHAT_ID, time: '2026-09-09 13:05:18 (UTC+03:00)' },
      { resource: 'metric_alert', data: { metric_alert: { title: 'metric', alert_rule: { environment: 'production', projects: ['dashboard'] } } }, chatId: CHAT_ID },
    ];
    for (const testCase of cases) {
      feishuPost.mockClear();
      const body = JSON.stringify({ action: testCase.resource === 'issue' ? 'created' : testCase.resource === 'metric_alert' ? 'critical' : 'triggered', data: testCase.data });
      expect((await postAlert(body, sign(body), testCase.resource)).status).toBe(200);
      await vi.waitFor(() => {
        const sends = feishuPost.mock.calls.filter(([url]) => String(url).startsWith('/im/v1/messages'));
        expect(sends).toHaveLength(1);
        expect(sends[0][1].receive_id).toBe(testCase.chatId);
        if (testCase.time) expect(sends[0][1].content).toContain(testCase.time);
      });
    }
    expect(projectStore.list().filter(record => record.projectId === '4').every(record => record.name === 'Dashboard')).toBe(true);
  });

  it('签名错误返回 401，不调用飞书接口', async () => {
    const body = JSON.stringify({ action: 'triggered', data: { event: { title: 'x', project: 4, environment: 'production' } } });
    const resp = await postAlert(body, sign(body, 'wrong-secret'));
    expect(resp.status).toBe(401);
    expect(feishuPost).not.toHaveBeenCalled();
    expect(projectStore.list()).toEqual([]);
  });

  it('installation/uninstall 事件直接确认不转发', async () => {
    const body = JSON.stringify({ action: 'deleted', data: { event: { project: 4, environment: 'production' } } });
    const resp = await postAlert(body, sign(body), 'uninstall');
    expect(resp.status).toBe(200);
    expect(feishuPost).not.toHaveBeenCalled();
    expect(projectStore.list()).toEqual([]);
  });

  it('未配置 Sentry 相关环境变量时返回 503', async () => {
    const bareConfig: AppConfig = { ...config, sentryWebhookSecret: undefined, feishuAlertChatId: undefined };
    const bareServer = createServer(buildTestApp(bareConfig));
    await new Promise<void>((resolve) => bareServer.listen(0, '127.0.0.1', resolve));
    const bareBase = `http://127.0.0.1:${(bareServer.address() as AddressInfo).port}`;
    try {
      const resp = await fetch(`${bareBase}/webhooks/sentry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sentry-Hook-Resource': 'event_alert' },
        body: alertBody,
      });
      expect(resp.status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => bareServer.close(() => resolve()));
    }
  });
});
