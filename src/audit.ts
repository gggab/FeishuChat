import fs from 'node:fs';
import path from 'node:path';

/**
 * 审计日志：只记录时间、open_id、工具名、参数键名摘要和调用结果。
 * 绝不记录消息/邮件正文、token 等敏感内容。
 */
export class AuditLogger {
  private readonly filePath: string;

  constructor(logDir: string) {
    this.filePath = path.join(logDir, 'audit.log');
  }

  log(entry: {
    openId: string;
    tool: string;
    params: Record<string, unknown>;
    ok: boolean;
    error?: string;
  }): void {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      open_id: entry.openId,
      tool: entry.tool,
      // 只保留参数键名，避免正文等敏感内容落盘
      param_keys: Object.keys(entry.params).sort(),
      ok: entry.ok,
      ...(entry.error ? { error: entry.error.slice(0, 200) } : {}),
    });
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, line + '\n', 'utf8');
    } catch {
      // 审计日志写入失败不影响主流程，但输出到 stderr 便于排查
      console.error('[audit] 写入审计日志失败:', this.filePath);
    }
  }
}
