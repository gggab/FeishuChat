import { AuditLogger } from '../audit.js';
import { FeishuClient } from '../feishu.js';
import { TokenStore } from '../tokenStore.js';

/** 每个 MCP 请求的上下文：以哪个用户身份调飞书 */
export interface ToolContext {
  feishu: FeishuClient;
  tokenStore: TokenStore;
  userToken: string;
  openId: string;
  audit: AuditLogger;
}

export type ToolHandler<T> = (args: T) => Promise<{
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}>;

/** 统一包装：取有效令牌 → 调飞书 → 审计 → 组装 MCP 返回 */
export function wrapTool<T extends Record<string, unknown>>(
  ctx: ToolContext,
  toolName: string,
  handler: (args: T, userAccessToken: string) => Promise<unknown>,
): ToolHandler<T> {
  return async (args: T) => {
    let ok = true;
    let errorMsg: string | undefined;
    try {
      const token = await ctx.tokenStore.getValidToken(ctx.userToken);
      const result = await handler(args, token);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      ok = false;
      errorMsg = (err as Error).message;
      return {
        content: [{ type: 'text' as const, text: `错误：${errorMsg}` }],
        isError: true,
      };
    } finally {
      ctx.audit.log({
        openId: ctx.openId,
        tool: toolName,
        params: args ?? {},
        ok,
        error: errorMsg,
      });
    }
  };
}
