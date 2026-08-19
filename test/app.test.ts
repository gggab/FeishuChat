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
import { TokenStore } from '../src/tokenStore.js';

const KEY = 'd'.repeat(64);
const USER_TOKEN = 'e'.repeat(64);

describe('HTTP 应用', () => {
  let dir: string;
  let server: Server;
  let baseUrl: string;
  let tokenStore: TokenStore;
  let feishuPost: ReturnType<typeof vi.fn>;
  let feishuGet: ReturnType<typeof vi.fn>;
  let stateStore: OAuthStateStore;

  const config: AppConfig = {
    appId: 'cli_test',
    appSecret: 'secret',
    tokenEncryptionKey: KEY,
    port: 0,
    publicBaseUrl: 'http://public.example:3000',
    dataDir: '',
    logDir: '',
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-test-'));
    config.dataDir = dir;
    config.logDir = dir;
    feishuPost = vi.fn();
    feishuGet = vi.fn();
    const feishu = new FeishuClient(config.appId, config.appSecret, {
      post: feishuPost,
      get: feishuGet,
    } as unknown as AxiosInstance);
    tokenStore = new TokenStore({
      filePath: path.join(dir, 'tokens.json'),
      encryptionKey: KEY,
    });
    stateStore = new OAuthStateStore();
    const app = createApp({
      config,
      feishu,
      tokenStore,
      stateStore,
      audit: new AuditLogger(dir),
      rateLimiter: new RateLimiter(60, 60_000),
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('GET /healthz 返回 ok', async () => {
    const resp = await fetch(`${baseUrl}/healthz`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.ok).toBe(true);
  });

  it('GET / 返回说明页和授权入口', async () => {
    const resp = await fetch(`${baseUrl}/`);
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('/oauth/login');
  });

  it('GET /oauth/login 302 到飞书授权页并带 state', async () => {
    const resp = await fetch(`${baseUrl}/oauth/login`, { redirect: 'manual' });
    expect(resp.status).toBe(302);
    const location = resp.headers.get('location')!;
    expect(location).toContain('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
    expect(location).toContain(`app_id=${config.appId}`);
    expect(location).toContain(
      `redirect_uri=${encodeURIComponent('http://public.example:3000/oauth/callback')}`,
    );
    expect(location).toMatch(/state=[0-9a-f]{32}/);
  });

  it('oauth/callback 非法 state 返回 400', async () => {
    const resp = await fetch(`${baseUrl}/oauth/callback?code=x&state=bad`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(400);
  });

  it('oauth/callback 完整流程：换 token、拉用户信息、落盘并展示 MCP URL', async () => {
    const state = stateStore.generate();
    feishuPost.mockResolvedValue({
      data: {
        access_token: 'u-at-callback',
        refresh_token: 'u-rt-callback',
        expires_in: 7200,
        refresh_token_expires_in: 2592000,
      },
    });
    feishuGet.mockResolvedValue({
      data: { code: 0, msg: 'success', data: { open_id: 'ou_cb', name: '王五' } },
    });

    const resp = await fetch(`${baseUrl}/oauth/callback?code=auth-code&state=${state}`, {
      redirect: 'manual',
    });
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain('授权成功');
    expect(html).toContain('王五');
    const match = html.match(/http:\/\/public\.example:3000\/mcp\/([0-9a-f]{64})/);
    expect(match).not.toBeNull();
    const userToken = match![1];

    // 令牌已落盘且可用
    expect(tokenStore.getUser(userToken)?.openId).toBe('ou_cb');
    await expect(tokenStore.getValidToken(userToken)).resolves.toBe('u-at-callback');
  });

  it('未知 userToken 的 MCP 请求返回 404', async () => {
    const resp = await fetch(`${baseUrl}/mcp/${'f'.repeat(64)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    expect(resp.status).toBe(404);
  });

  it('MCP initialize 请求可正常建立（无状态模式）', async () => {
    tokenStore.saveUser(USER_TOKEN, {
      openId: 'ou_mcp',
      name: '赵六',
      accessToken: 'at',
      refreshToken: 'rt',
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 86400_000,
    });
    const resp = await fetch(`${baseUrl}/mcp/${USER_TOKEN}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.0.1' },
        },
      }),
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    expect(text).toContain('feishu-mcp-gateway');
  });
});
