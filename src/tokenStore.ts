import fs from 'node:fs';
import path from 'node:path';
import { decrypt, encrypt } from './crypto.js';

/** access_token 剩余有效期不足该毫秒数时触发刷新（5 分钟） */
export const REFRESH_THRESHOLD_MS = 5 * 60 * 1000;

export interface UserRecord {
  openId: string;
  name: string;
  /** AES-256-GCM 加密后的 access_token */
  accessToken: string;
  /** AES-256-GCM 加密后的 refresh_token */
  refreshToken: string;
  /** access_token 过期时间（epoch 毫秒） */
  accessTokenExpiresAt: number;
  /** refresh_token 过期时间（epoch 毫秒） */
  refreshTokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  users: Record<string, UserRecord>;
}

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  /** access_token 有效期（秒） */
  expiresIn: number;
  /** refresh_token 有效期（秒），飞书一般约 30 天 */
  refreshTokenExpiresIn?: number;
}

export type RefreshFn = (refreshToken: string) => Promise<RefreshResult>;

export interface TokenStoreOptions {
  filePath: string;
  encryptionKey: string;
  refreshFn?: RefreshFn;
  now?: () => number;
}

export class TokenStore {
  private readonly filePath: string;
  private readonly encryptionKey: string;
  private readonly refreshFn?: RefreshFn;
  private readonly now: () => number;
  private data: StoreFile;
  /** 同一 userToken 并发刷新去重 */
  private readonly inflightRefreshes = new Map<string, Promise<string>>();

  constructor(options: TokenStoreOptions) {
    this.filePath = options.filePath;
    this.encryptionKey = options.encryptionKey;
    this.refreshFn = options.refreshFn;
    this.now = options.now ?? (() => Date.now());
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoreFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.users !== 'object') {
        return { users: {} };
      }
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { users: {} };
      throw new Error(`读取令牌存储文件失败：${this.filePath}，${(err as Error).message}`);
    }
  }

  /** 原子写入：先写临时文件再 rename，避免进程中断留下半截 JSON */
  private saveToDisk(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
  }

  /**
   * OAuth 回调成功后保存/覆盖用户令牌（userToken 由调用方生成）。
   * 传入明文 access_token / refresh_token，本方法负责加密后落盘。
   */
  saveUser(
    userToken: string,
    record: {
      openId: string;
      name: string;
      accessToken: string;
      refreshToken: string;
      accessTokenExpiresAt: number;
      refreshTokenExpiresAt: number;
    },
  ): void {
    const now = this.now();
    const existing = this.data.users[userToken];
    this.data.users[userToken] = {
      openId: record.openId,
      name: record.name,
      accessToken: encrypt(record.accessToken, this.encryptionKey),
      refreshToken: encrypt(record.refreshToken, this.encryptionKey),
      accessTokenExpiresAt: record.accessTokenExpiresAt,
      refreshTokenExpiresAt: record.refreshTokenExpiresAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.saveToDisk();
  }

  getUser(userToken: string): UserRecord | undefined {
    return this.data.users[userToken];
  }

  listUsers(): Array<{ userToken: string; openId: string; name: string }> {
    return Object.entries(this.data.users).map(([userToken, u]) => ({
      userToken,
      openId: u.openId,
      name: u.name,
    }));
  }

  deleteUser(userToken: string): boolean {
    if (!this.data.users[userToken]) return false;
    delete this.data.users[userToken];
    this.saveToDisk();
    return true;
  }

  /**
   * 获取可用的 access_token：距过期不足 5 分钟时自动用 refresh_token 刷新并落盘。
   * 刷新失败抛出带重新授权指引的错误。
   */
  async getValidToken(userToken: string): Promise<string> {
    const record = this.data.users[userToken];
    if (!record) {
      throw new Error('未找到该用户，请检查 MCP URL 是否正确，或重新访问 /oauth/login 完成授权');
    }
    if (record.accessTokenExpiresAt - this.now() >= REFRESH_THRESHOLD_MS) {
      return decrypt(record.accessToken, this.encryptionKey);
    }
    return this.refreshWithDedup(userToken);
  }

  private refreshWithDedup(userToken: string): Promise<string> {
    const inflight = this.inflightRefreshes.get(userToken);
    if (inflight) return inflight;
    const promise = this.doRefresh(userToken).finally(() => {
      this.inflightRefreshes.delete(userToken);
    });
    this.inflightRefreshes.set(userToken, promise);
    return promise;
  }

  private async doRefresh(userToken: string): Promise<string> {
    const record = this.data.users[userToken];
    if (!record) throw new Error('用户不存在');
    if (!this.refreshFn) throw new Error('令牌已过期且未配置刷新函数');
    if (record.refreshTokenExpiresAt <= this.now()) {
      throw new Error('refresh_token 已过期，请重新访问 /oauth/login 完成飞书授权后再使用');
    }
    const refreshToken = decrypt(record.refreshToken, this.encryptionKey);
    let result: RefreshResult;
    try {
      result = await this.refreshFn(refreshToken);
    } catch (err) {
      throw new Error(
        `刷新飞书令牌失败（${(err as Error).message}），请重新访问 /oauth/login 完成飞书授权后再使用`,
      );
    }
    const now = this.now();
    record.accessToken = encrypt(result.accessToken, this.encryptionKey);
    record.accessTokenExpiresAt = now + result.expiresIn * 1000;
    // 飞书在刷新时会轮换 refresh_token，需一并更新
    if (result.refreshToken) {
      record.refreshToken = encrypt(result.refreshToken, this.encryptionKey);
    }
    if (result.refreshTokenExpiresIn) {
      record.refreshTokenExpiresAt = now + result.refreshTokenExpiresIn * 1000;
    }
    record.updatedAt = now;
    this.saveToDisk();
    return result.accessToken;
  }
}
