import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, wrapTool } from './context.js';

export function registerMailTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_mail_folders',
    {
      title: '列出邮箱文件夹',
      description: '列出当前用户飞书邮箱的文件夹（收件箱、已发送、草稿等）。',
      inputSchema: {},
    },
    wrapTool(ctx, 'list_mail_folders', async (_args, token) =>
      ctx.feishu.callAsUser(token, 'get', '/mail/v1/user_mailboxes/me/folders', {
        params: { page_size: 100 },
      }),
    ),
  );

  server.registerTool(
    'list_mail_messages',
    {
      title: '列出邮件',
      description: '列出当前用户飞书邮箱指定文件夹中的邮件列表，支持分页。',
      inputSchema: {
        folder_id: z
          .string()
          .optional()
          .describe('文件夹 ID（可用 list_mail_folders 获取），默认收件箱'),
        page_token: z.string().optional().describe('分页标记，首次调用不传'),
        page_size: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20'),
      },
    },
    wrapTool(ctx, 'list_mail_messages', async (args, token) =>
      ctx.feishu.callAsUser(token, 'get', '/mail/v1/user_mailboxes/me/messages', {
        params: {
          folder_id: args.folder_id,
          page_token: args.page_token,
          page_size: args.page_size ?? 20,
        },
      }),
    ),
  );

  server.registerTool(
    'get_mail_message',
    {
      title: '获取邮件详情',
      description: '根据邮件 ID 获取单封邮件的完整内容（主题、发件人、正文等）。',
      inputSchema: {
        message_id: z.string().describe('邮件消息 ID'),
      },
    },
    wrapTool(ctx, 'get_mail_message', async (args, token) =>
      ctx.feishu.callAsUser(
        token,
        'get',
        `/mail/v1/user_mailboxes/me/messages/${encodeURIComponent(args.message_id)}`,
      ),
    ),
  );
}
