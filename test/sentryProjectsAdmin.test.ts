import { AxiosInstance } from 'axios';
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
const ADMIN_TOKEN = 'admin-secret';

describe('/admin/sentry-projects/api (per-project chat_id + timezone mapping)', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;

  function api(pathSuffix: string, opts?: RequestInit) {
    return fetch(`${baseUrl}${pathSuffix}`, {
      ...opts,
      headers: { ...(opts?.headers as Record<string, string>), 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
    });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-projects-test-'));
    const config: AppConfig = {
      appId: 'cli_test',
      appSecret: 'secret',
      tokenEncryptionKey: KEY,
      port: 0,
      publicBaseUrl: 'http://public.example:3000',
      dataDir: dir,
      logDir: dir,
      adminToken: ADMIN_TOKEN,
    };
    const feishu = new FeishuClient(config.appId, config.appSecret, { post: vi.fn(), get: vi.fn() } as unknown as AxiosInstance);
    const app = createApp({
      config,
      feishu,
      tokenStore: new TokenStore({ filePath: path.join(dir, 'tokens.json'), encryptionKey: KEY }),
      stateStore: new OAuthStateStore(),
      audit: new AuditLogger(dir),
      rateLimiter: new RateLimiter(60, 60_000),
      sentryProjectStore: new SentryProjectStore(path.join(dir, 'sentryProjects.json')),
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('POST without a timezone creates a mapping with no per-project override', async () => {
    const resp = await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '4', chatId: 'oc_a' }) });
    expect(resp.status).toBe(200);
    const { record } = await resp.json();
    expect(record).toMatchObject({ projectId: '4', chatId: 'oc_a' });
    expect(record.timezone).toBeUndefined();

    const list = await (await api('/admin/sentry-projects/api')).json();
    expect(list).toHaveLength(1);
    expect(list[0].timezone).toBeUndefined();
  });

  it('POST with a valid IANA timezone stores it on that project mapping only', async () => {
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '4', chatId: 'oc_china', timezone: 'Asia/Shanghai' }) });
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '5', chatId: 'oc_riyadh', timezone: 'Asia/Riyadh' }) });

    const list = await (await api('/admin/sentry-projects/api')).json();
    expect(list).toContainEqual(expect.objectContaining({ projectId: '4', chatId: 'oc_china', timezone: 'Asia/Shanghai' }));
    expect(list).toContainEqual(expect.objectContaining({ projectId: '5', chatId: 'oc_riyadh', timezone: 'Asia/Riyadh' }));
  });

  it('POST with an invalid timezone name is rejected with 400 and nothing is saved', async () => {
    const resp = await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '4', chatId: 'oc_a', timezone: 'Not/AZone' }) });
    expect(resp.status).toBe(400);
    const list = await (await api('/admin/sentry-projects/api')).json();
    expect(list).toEqual([]);
  });

  it('re-POSTing with timezone="" clears a previously-set override back to the default', async () => {
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '4', chatId: 'oc_a', timezone: 'Asia/Shanghai' }) });
    await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId: '4', chatId: 'oc_a', timezone: '' }) });
    const list = await (await api('/admin/sentry-projects/api')).json();
    expect(list).toHaveLength(1);
    expect(list[0].projectId).toBe('4');
    expect(list[0].timezone).toBeUndefined();
  });

  it('wrong/missing admin token is rejected with 401', async () => {
    const resp = await fetch(`${baseUrl}/admin/sentry-projects/api`);
    expect(resp.status).toBe(401);
  });
});
