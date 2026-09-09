import fs from 'node:fs';
import path from 'node:path';

/**
 * Sentry 告警卡片相关的全局设置（目前只有时区），跟按项目路由的 SentryProjectStore 分开存一个文件。
 * 卡片上的事件时间/首次-最近出现时间都用这个时区显示——Feishu 卡片没有"按查看者本地时区显示"的概念，
 * 只能网关这边固定选一个时区渲染成文本。默认沿用之前硬编码的 UTC+3（利雅得），避免升级后行为突变。
 */
export const DEFAULT_TIMEZONE = 'Asia/Riyadh';

export interface SentrySettings {
  /** IANA 时区名（如 "Asia/Shanghai"），必须是 Intl 认识的合法时区 */
  timezone: string;
}

interface StoreFile {
  settings: SentrySettings;
}

/** Intl 认不认识这个时区名；无效的话 `new Intl.DateTimeFormat` 会抛 RangeError */
export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

export class SentrySettingsStore {
  private readonly filePath: string;
  private data: StoreFile;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.data = this.loadFromDisk();
  }

  private loadFromDisk(): StoreFile {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreFile>;
      const timezone = parsed?.settings?.timezone;
      if (!timezone || !isValidTimeZone(timezone)) {
        return { settings: { timezone: DEFAULT_TIMEZONE } };
      }
      return { settings: { timezone } };
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { settings: { timezone: DEFAULT_TIMEZONE } };
      throw new Error(`读取 Sentry 设置文件失败：${this.filePath}，${(err as Error).message}`);
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

  getTimezone(): string {
    return this.data.settings.timezone;
  }

  /** 抛错而不是静默忽略——管理页面提交了非法时区名时，调用方应该把错误原样回给用户 */
  setTimezone(timezone: string): SentrySettings {
    if (!isValidTimeZone(timezone)) {
      throw new Error(`不是有效的 IANA 时区名称：${timezone}`);
    }
    this.data.settings = { timezone };
    this.saveToDisk();
    return this.data.settings;
  }
}
