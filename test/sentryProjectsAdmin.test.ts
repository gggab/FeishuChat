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
import { SentrySettingsStore } from '../src/sentrySettingsStore.js';
import { TokenStore } from '../src/tokenStore.js';

const KEY = 'd'.repeat(64);
const ADMIN_TOKEN = 'admin-secret';

describe('GET/PUT /admin/sentry-projects/api/settings', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admin-settings-test-'));
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
      sentrySettingsStore: new SentrySettingsStore(path.join(dir, 'sentrySettings.json')),
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET returns the default timezone before anything is configured', async () => {
    const resp = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ timezone: 'Asia/Riyadh' });
  });

  it('PUT with a valid IANA timezone saves it, and a later GET reflects it', async () => {
    const putResp = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, {
      method: 'PUT',
      headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Asia/Shanghai' }),
    });
    expect(putResp.status).toBe(200);
    expect((await putResp.json()).settings).toEqual({ timezone: 'Asia/Shanghai' });

    const getResp = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
    expect(await getResp.json()).toEqual({ timezone: 'Asia/Shanghai' });
  });

  it('PUT with an invalid timezone name is rejected with 400 and does not change the stored value', async () => {
    const resp = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, {
      method: 'PUT',
      headers: { 'X-Admin-Token': ADMIN_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timezone: 'Not/AZone' }),
    });
    expect(resp.status).toBe(400);
    const getResp = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, { headers: { 'X-Admin-Token': ADMIN_TOKEN } });
    expect(await getResp.json()).toEqual({ timezone: 'Asia/Riyadh' });
  });

  it('wrong/missing admin token is rejected with 401', async () => {
    const noToken = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`);
    expect(noToken.status).toBe(401);
    const wrongToken = await fetch(`${baseUrl}/admin/sentry-projects/api/settings`, { headers: { 'X-Admin-Token': 'wrong' } });
    expect(wrongToken.status).toBe(401);
  });
});
