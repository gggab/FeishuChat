import { describe, expect, it } from 'vitest';
import { OAuthStateStore, STATE_TTL_MS } from '../src/oauthState.js';

describe('OAuthStateStore', () => {
  it('生成的 state 可校验通过（一次性）', () => {
    const store = new OAuthStateStore();
    const state = store.generate();
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(store.consume(state)).toBe(true);
    // 一次性：第二次消费失败
    expect(store.consume(state)).toBe(false);
  });

  it('不存在的 state 校验失败', () => {
    const store = new OAuthStateStore();
    expect(store.consume('nonexistent-state')).toBe(false);
  });

  it('state 10 分钟后过期', () => {
    let now = 1_000_000;
    const store = new OAuthStateStore(() => now);
    const state = store.generate();
    now += STATE_TTL_MS + 1;
    expect(store.consume(state)).toBe(false);
  });

  it('state 在有效期内可消费', () => {
    let now = 1_000_000;
    const store = new OAuthStateStore(() => now);
    const state = store.generate();
    now += STATE_TTL_MS - 1;
    expect(store.consume(state)).toBe(true);
  });

  it('generate 时清理已过期的 state', () => {
    let now = 1_000_000;
    const store = new OAuthStateStore(() => now);
    store.generate();
    expect(store.size).toBe(1);
    now += STATE_TTL_MS + 1;
    store.generate();
    expect(store.size).toBe(1); // 旧的已被清理，只剩新生成的
  });
});
