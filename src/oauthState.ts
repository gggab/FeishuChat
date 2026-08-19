import { randomToken } from './crypto.js';

export const STATE_TTL_MS = 10 * 60 * 1000; // state 有效期 10 分钟

interface StateEntry {
  expiresAt: number;
}

/**
 * OAuth state 防 CSRF：内存 Map，10 分钟过期，一次性使用。
 * 单实例部署足够；如需多实例需改为共享存储。
 */
export class OAuthStateStore {
  private readonly states = new Map<string, StateEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** 生成新 state 并登记 */
  generate(): string {
    this.cleanup();
    const state = randomToken(16);
    this.states.set(state, { expiresAt: this.now() + STATE_TTL_MS });
    return state;
  }

  /** 校验并消费 state（一次性；过期或不存在返回 false） */
  consume(state: string): boolean {
    this.cleanup();
    const entry = this.states.get(state);
    if (!entry) return false;
    this.states.delete(state);
    return entry.expiresAt > this.now();
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, entry] of this.states) {
      if (entry.expiresAt <= now) this.states.delete(key);
    }
  }

  get size(): number {
    return this.states.size;
  }
}
