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
import {
  buildFeishuCard,
  parseSentryAlert,
  verifySentrySignature,
} from '../src/sentryAlert.js';
import { TokenStore } from '../src/tokenStore.js';

const KEY = 'd'.repeat(64);
const SENTRY_SECRET = 'sentry-client-secret';
const CHAT_ID = 'oc_alert_chat';

function sign(body: string, secret = SENTRY_SECRET): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifySentrySignature', () => {
  it('签名正确返回 true', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySentrySignature(body, sign('{"a":1}'), SENTRY_SECRET)).toBe(true);
  });

  it('签名错误 / 为空返回 false', () => {
    const body = Buffer.from('{"a":1}');
    expect(verifySentrySignature(body, sign('{"a":2}'), SENTRY_SECRET)).toBe(false);
    expect(verifySentrySignature(body, '', SENTRY_SECRET)).toBe(false);
  });
});

describe('parseSentryAlert', () => {
  it('event_alert：提取标题、级别、规则与详情链接', () => {
    const msg = parseSentryAlert('event_alert', {
      action: 'triggered',
      data: {
        triggered_rule: '生产错误告警',
        event: {
          title: 'TypeError: Cannot read properties of undefined',
          culprit: 'app.handler in process',
          level: 'error',
          web_url: 'https://sentry.example.com/issues/123/',
        },
      },
    });
    expect(msg.title).toContain('TypeError');
    expect(msg.color).toBe('red');
    expect(msg.fields).toContainEqual(['级别', 'error']);
    expect(msg.fields).toContainEqual(['触发规则', '生产错误告警']);
    expect(msg.detail).toBe('app.handler in process');
    expect(msg.url).toBe('https://sentry.example.com/issues/123/');
  });

  it('metric_alert：triggered 为红色，resolved 为绿色', () => {
    const triggered = parseSentryAlert('metric_alert', {
      action: 'critical',
      data: { metric_alert: { title: '接口错误率', web_url: 'https://sentry.example.com/alerts/1/' } },
    });
    expect(triggered.color).toBe('red');
    expect(triggered.title).toContain('接口错误率');

    const resolved = parseSentryAlert('metric_alert', {
      action: 'resolved',
      data: { metric_alert: { title: '接口错误率' } },
    });
    expect(resolved.color).toBe('green');
    expect(resolved.title).toContain('已恢复');
  });

  it('未知 resource 走兜底结构', () => {
    const msg = parseSentryAlert('error', { action: 'created' });
    expect(msg.title).toContain('error');
    expect(msg.color).toBe('grey');
  });
});

describe('buildFeishuCard', () => {
  it('生成 interactive 卡片，包含标题、字段、详情与按钮', () => {
    const card = buildFeishuCard({
      title: 'Sentry 告警：x',
      color: 'red',
      fields: [['级别', 'error']],
      detail: 'culprit 信息',
      url: 'https://sentry.example.com/issues/1/',
    });
    const json = JSON.stringify(card);
    expect(json).toContain('"template":"red"');
    expect(json).toContain('Sentry 告警');
    expect(json).toContain('culprit 信息');
    expect(json).toContain('https://sentry.example.com/issues/1/');
  });
});

describe('POST /webhooks/sentry', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let feishuPost: ReturnType<typeof vi.fn>;

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
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentry-test-'));
    config.dataDir = dir;
    config.logDir = dir;
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

  it('验签通过则以应用身份转发卡片到目标群', async () => {
    const resp = await postAlert(alertBody, sign(alertBody));
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);

    // 第一次调 tenant_access_token，第二次发消息
    const sendCall = feishuPost.mock.calls.find(([url]) => String(url).startsWith('/im/v1/messages'));
    expect(sendCall).toBeDefined();
    const [, payload, options] = sendCall!;
    expect(payload.receive_id).toBe(CHAT_ID);
    expect(payload.msg_type).toBe('interactive');
    expect(payload.content).toContain('NullPointerException');
    expect(payload.content).toContain('规则A');
    expect(options.headers.Authorization).toBe('Bearer t-1');
  });

  it('飞书发送失败时返回 502', async () => {
    feishuPost.mockImplementation((url: string) => {
      if (url === '/auth/v3/tenant_access_token/internal') {
        return Promise.resolve({ data: { code: 0, msg: 'ok', tenant_access_token: 't-1', expire: 7200 } });
      }
      return Promise.resolve({ data: { code: 230001, msg: 'bot is not in the chat' } });
    });
    const resp = await postAlert(alertBody, sign(alertBody));
    expect(resp.status).toBe(502);
    const body = await resp.json();
    expect(body.message).toContain('230001');
  });

  it('签名错误返回 401，不调用飞书接口', async () => {
    const resp = await postAlert(alertBody, sign(alertBody, 'wrong-secret'));
    expect(resp.status).toBe(401);
    expect(feishuPost).not.toHaveBeenCalled();
  });

  it('installation/uninstall 事件直接确认不转发', async () => {
    const body = JSON.stringify({ action: 'deleted' });
    const resp = await postAlert(body, sign(body), 'uninstall');
    expect(resp.status).toBe(200);
    expect(feishuPost).not.toHaveBeenCalled();
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
