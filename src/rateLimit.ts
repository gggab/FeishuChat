/**
 * 简单内存滑动窗口限流：每 userToken 每分钟最多 maxPerWindow 次请求。
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxPerWindow: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(maxPerWindow = 60, windowMs = 60_000, now: () => number = () => Date.now()) {
    this.maxPerWindow = maxPerWindow;
    this.windowMs = windowMs;
    this.now = now;
  }

  /** 返回 true 表示放行，false 表示超限 */
  allow(key: string): boolean {
    const now = this.now();
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.maxPerWindow) {
      this.hits.set(key, list);
      return false;
    }
    list.push(now);
    this.hits.set(key, list);
    return true;
  }
}
