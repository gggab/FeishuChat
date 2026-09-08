import fs from 'node:fs';
import path from 'node:path';

/**
 * Sentry 项目 ID → 飞书群 chat_id 的映射，用于按项目路由告警。
 * 通过管理页面手动新增（projectId + chatId），slug/name 在收到该项目
 * 第一条真实告警后自动回填，不会覆盖已有值、也不会自动新增映射。
 */
export interface SentryProjectRecord {
  projectId: string;
  chatId: string;
  slug?: string;
  name?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  projects: Record<string, SentryProjectRecord>;
}

export class SentryProjectStore {
  private readonly filePath: string;
  private data: StoreFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoreFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as StoreFile;
      if (!parsed || typeof parsed !== 'object' || typeof parsed.projects !== 'object') {
        return { projects: {} };
      }
      return parsed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} };
      throw new Error(`读取 Sentry 项目映射文件失败：${this.filePath}，${(err as Error).message}`);
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

  list(): SentryProjectRecord[] {
    return Object.values(this.data.projects).sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  get(projectId: string): SentryProjectRecord | undefined {
    return this.data.projects[projectId];
  }

  /** 管理页面新增/覆盖一条映射（保留已回填的 slug/name） */
  upsert(projectId: string, chatId: string): SentryProjectRecord {
    const now = Date.now();
    const existing = this.data.projects[projectId];
    const record: SentryProjectRecord = {
      projectId,
      chatId,
      slug: existing?.slug,
      name: existing?.name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.projects[projectId] = record;
    this.saveToDisk();
    return record;
  }

  remove(projectId: string): boolean {
    if (!this.data.projects[projectId]) return false;
    delete this.data.projects[projectId];
    this.saveToDisk();
    return true;
  }

  /** 收到真实告警后为已存在的映射补充 slug/name；映射不存在时不做任何事 */
  enrich(projectId: string, info: { slug?: string; name?: string }): void {
    const record = this.data.projects[projectId];
    if (!record) return;
    let changed = false;
    if (info.slug && record.slug !== info.slug) {
      record.slug = info.slug;
      changed = true;
    }
    if (info.name && record.name !== info.name) {
      record.name = info.name;
      changed = true;
    }
    if (changed) {
      record.updatedAt = Date.now();
      this.saveToDisk();
    }
  }
}
