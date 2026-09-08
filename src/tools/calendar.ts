import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, wrapTool } from './context.js';

export function registerCalendarTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_calendar_events',
    {
      title: '列出日程',
      description:
        '列出当前用户飞书主日历中指定时间范围内的日程（会议、评审等），按开始时间排序。' +
        '只能读取当前授权用户自己的日程。',
      inputSchema: {
        start_time: z.string().describe('起始时间（Unix 秒级时间戳字符串），如 "1700000000"'),
        end_time: z.string().describe('结束时间（Unix 秒级时间戳字符串）'),
        page_token: z.string().optional().describe('分页标记，首次调用不传'),
        page_size: z.number().int().min(1).max(100).optional().describe('每页数量，默认 50'),
      },
    },
    wrapTool(ctx, 'list_calendar_events', async (args, token) =>
      ctx.feishu.callAsUser(token, 'get', '/calendar/v4/calendars/primary/events', {
        params: {
          start_time: args.start_time,
          end_time: args.end_time,
          page_token: args.page_token,
          page_size: args.page_size ?? 50,
        },
      }),
    ),
  );
}
