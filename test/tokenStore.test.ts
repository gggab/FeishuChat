import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { REFRESH_THRESHOLD_MS, TokenStore } from '../src/tokenStore.js';

const KEY = 'c'.repeat(64);
const USER_TOKEN = 'u'.repeat(64);

describe('TokenStore', () => {
  let dir: string;
  let filePath: string;
  let now: number;
  const NOW_START = 1_700_000_000_000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-store-test-'));
    filePath = path.join(dir, 'tokens.json');
    now = NOW_START;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeStore(refreshFn?: () => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn: number;
    refreshTokenExpiresIn?: number;
  }>) {
    return new TokenStore({ filePath, encryptionKey: KEY, refreshFn, now: () => now });
  }

  function saveUser(store: TokenStore, expiresInMs = 2 * 3600 * 1000) {
    store.saveUser(USER_TOKEN, {
      openId: 'ou_test_001',
      name: '张三',
      accessToken: 'plain-access-token',
      refreshToken: 'plain-refresh-token',
      accessTokenExpiresAt: now + expiresInMs,
      refreshTokenExpiresAt: now + 30 * 24 * 3600 * 1000,
    });
  }

  it('保存后可读取，且磁盘文件不含明文 token', async () => {
    const store = makeStore();
    saveUser(store);
    const token = await store.getValidToken(USER_TOKEN);
    expect(token).toBe('plain-access-token');

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('plain-access-token');
    expect(raw).not.toContain('plain-refresh-token');
    expect(raw).toContain('ou_test_001');
  });

  it('重新实例化后可从磁盘加载（持久化）', async () => {
    const store1 = makeStore();
    saveUser(store1);
    const store2 = makeStore();
    expect(store2.getUser(USER_TOKEN)?.name).toBe('张三');
    await expect(store2.getValidToken(USER_TOKEN)).resolves.toBe('plain-access-token');
  });

  it('token 未临期时不触发刷新', async () => {
    const refreshFn = vi.fn();
    const store = makeStore(refreshFn);
    saveUser(store, REFRESH_THRESHOLD_MS + 60_000); // 距过期 > 5 分钟
    await store.getValidToken(USER_TOKEN);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('token 临期时自动刷新并落盘，refresh_token 一并轮换', async () => {
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
      expiresIn: 7200,
      refreshTokenExpiresIn: 30 * 24 * 3600,
    });
    const store = makeStore(refreshFn);
    saveUser(store, REFRESH_THRESHOLD_MS - 1000); // 距过期 < 5 分钟

    const token = await store.getValidToken(USER_TOKEN);
    expect(token).toBe('new-access-token');
    expect(refreshFn).toHaveBeenCalledTimes(1);

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw).not.toContain('new-access-token');

    // 刷新后再次获取不应重复刷新（新 token 未临期）
    const token2 = await store.getValidToken(USER_TOKEN);
    expect(token2).toBe('new-access-token');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('并发获取时同一 userToken 只刷新一次（去重）', async () => {
    let resolveRefresh: (v: { accessToken: string; expiresIn: number }) => void;
    const refreshFn = vi.fn(
      () =>
        new Promise<{ accessToken: string; expiresIn: number }>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const store = makeStore(refreshFn);
    saveUser(store, 0); // 已临期

    const p1 = store.getValidToken(USER_TOKEN);
    const p2 = store.getValidToken(USER_TOKEN);
    const p3 = store.getValidToken(USER_TOKEN);
    resolveRefresh!({ accessToken: 'dedup-token', expiresIn: 7200 });
    const [t1, t2, t3] = await Promise.all([p1, p2, p3]);
    expect(t1).toBe('dedup-token');
    expect(t2).toBe('dedup-token');
    expect(t3).toBe('dedup-token');
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it('刷新失败抛出带重新授权指引的错误', async () => {
    const refreshFn = vi.fn().mockRejectedValue(new Error('invalid refresh_token'));
    const store = makeStore(refreshFn);
    saveUser(store, 0);
    await expect(store.getValidToken(USER_TOKEN)).rejects.toThrow(/\/oauth\/login/);
  });

  it('refresh_token 过期时提示重新授权，不再调用刷新', async () => {
    const refreshFn = vi.fn();
    const store = makeStore(refreshFn);
    saveUser(store, 0);
    // 手动把 refresh_token 过期时间改到过去
    store.saveUser(USER_TOKEN, {
      openId: 'ou_test_001',
      name: '张三',
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: now - 1000,
      refreshTokenExpiresAt: now - 1000,
    });
    await expect(store.getValidToken(USER_TOKEN)).rejects.toThrow(/refresh_token 已过期/);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it('未知 userToken 抛错', async () => {
    const store = makeStore();
    await expect(store.getValidToken('nonexistent')).rejects.toThrow(/未找到该用户/);
  });

  it('deleteUser 删除后无法再获取', async () => {
    const store = makeStore();
    saveUser(store);
    expect(store.deleteUser(USER_TOKEN)).toBe(true);
    expect(store.getUser(USER_TOKEN)).toBeUndefined();
    expect(store.deleteUser(USER_TOKEN)).toBe(false);
  });

  it('写入采用临时文件 + rename，不残留临时文件', async () => {
    const store = makeStore();
    saveUser(store);
    const files = fs.readdirSync(dir);
    expect(files).toEqual(['tokens.json']);
  });
});
