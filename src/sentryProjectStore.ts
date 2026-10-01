import fs from 'node:fs';
import path from 'node:path';

/**
 * Sentry 项目 ID + 可选 environment → 飞书群 chat_id 的映射。
 * 未匹配环境专属映射时回退到项目默认映射。slug/name 在收到该项目
 * 第一条真实告警后自动回填，不会覆盖已有值、也不会自动新增映射。
 *
 * timezone 是这条映射（也就是目标群）专属的卡片时间显示时区——飞书卡片没有"按查看者
 * 本地时区显示"的概念，只能网关侧固定选一个；不同群面向不同地区的人，就需要能各配各的
 * （比如中国群配 Asia/Shanghai，利雅得群配 Asia/Riyadh），而不是整个网关只有一个全局时区。
 * 没配就用 DEFAULT_TIMEZONE 兜底（也是没有任何项目映射的默认群所使用的时区）。
 */
export interface SentryProjectRecord {
  projectId: string;
  /** Sentry environment 原值，区分大小写；未设置则为项目默认映射 */
  environment?: string;
  chatId: string;
  slug?: string;
  name?: string;
  /** IANA 时区名（如 "Asia/Shanghai"），未设置时该项目的告警卡片时间用 DEFAULT_TIMEZONE 显示 */
  timezone?: string;
  createdAt: number;
  updatedAt: number;
}

interface StoreFile {
  projects: Record<string, SentryProjectRecord>;
}

/** 没有项目专属映射时（含默认群）的兜底显示时区，也是之前版本硬编码的固定偏移 */
export const DEFAULT_TIMEZONE = 'Asia/Riyadh';

/** Intl 认不认识这个时区名；无效的话 `new Intl.DateTimeFormat` 会抛 RangeError */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
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
      if (!parsed || typeof parsed !== 'object' || !parsed.projects || typeof parsed.projects !== 'object') {
        return { projects: {} };
      }
      // 旧文件按 projectId 存储；统一重建索引，无需手动迁移。
      return { projects: Object.fromEntries(Object.values(parsed.projects).map(record => [this.key(record.projectId, record.environment), record])) };
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
    return Object.values(this.data.projects).sort((a, b) => a.projectId.localeCompare(b.projectId) || (a.environment ?? '').localeCompare(b.environment ?? ''));
  }

  private key(projectId: string, environment?: string): string {
    return JSON.stringify([projectId, typeof environment === 'string' ? environment.trim() : '']);
  }

  get(projectId: string, environment?: string): SentryProjectRecord | undefined {
    return this.data.projects[this.key(projectId, environment)] ?? this.data.projects[this.key(projectId)];
  }

  /**
   * 管理页面新增/覆盖一条映射（保留已回填的 slug/name）。
   * `timezone` 未传（undefined）时保留原有值；传空字符串表示清空（改回用 DEFAULT_TIMEZONE 兜底）；
   * 传非空字符串时必须是 Intl 认识的合法 IANA 时区名，否则抛错，不会静默存一个坏值进去。
   */
  upsert(projectId: string, chatId: string, timezone?: string, environment?: string): SentryProjectRecord {
    projectId = projectId.trim();
    chatId = chatId.trim();
    environment = environment?.trim() || undefined;
    if (!projectId || !chatId) throw new Error('projectId and chatId must not be blank');
    const key = this.key(projectId, environment);
    const now = Date.now();
    const existing = this.data.projects[key];
    const projectInfo = existing ?? this.list().find(record => record.projectId === projectId);
    let resolvedTimezone = existing?.timezone;
    if (timezone !== undefined) {
      const trimmed = timezone.trim();
      if (!trimmed) {
        resolvedTimezone = undefined;
      } else if (!isValidTimeZone(trimmed)) {
        throw new Error(`不是有效的 IANA 时区名称：${timezone}`);
      } else {
        resolvedTimezone = trimmed;
      }
    }
    const record: SentryProjectRecord = {
      projectId,
      environment,
      chatId,
      slug: projectInfo?.slug,
      name: projectInfo?.name,
      timezone: resolvedTimezone,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.data.projects[key] = record;
    this.saveToDisk();
    return record;
  }

  remove(projectId: string, environment?: string): boolean {
    const key = this.key(projectId, environment);
    if (!this.data.projects[key]) return false;
    delete this.data.projects[key];
    this.saveToDisk();
    return true;
  }

  /** 收到真实告警后为已存在的映射补充 slug/name；映射不存在时不做任何事 */
  enrich(projectId: string, info: { slug?: string; name?: string }): void {
    let changed = false;
    for (const record of Object.values(this.data.projects)) {
      if (record.projectId !== projectId) continue;
      if ((info.slug && record.slug !== info.slug) || (info.name && record.name !== info.name)) {
        if (info.slug) record.slug = info.slug;
        if (info.name) record.name = info.name;
        record.updatedAt = Date.now();
        changed = true;
      }
    }
    if (changed) this.saveToDisk();
  }
}
