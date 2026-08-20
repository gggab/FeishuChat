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
      description:
        '根据邮件 ID 获取单封邮件的内容。format 默认 metadata（不含主题和发件人），' +
        '需要主题、发件人、正文时传 full 或 plain_text_full。',
      inputSchema: {
        message_id: z.string().describe('邮件消息 ID'),
        format: z
          .enum(['metadata', 'full', 'plain_text_full'])
          .optional()
          .describe('返回内容格式，默认 metadata'),
      },
    },
    wrapTool(ctx, 'get_mail_message', async (args, token) =>
      ctx.feishu.callAsUser(
        token,
        'get',
        `/mail/v1/user_mailboxes/me/messages/${encodeURIComponent(args.message_id)}`,
        { params: { format: args.format } },
      ),
    ),
  );

  server.registerTool(
    'search_mail_messages',
    {
      title: '搜索邮件',
      description:
        '按关键词和过滤条件搜索当前用户的邮件，返回邮件 ID 及摘要信息。' +
        'filter 支持 from、to、folder、is_unread、create_time 等条件。',
      inputSchema: {
        query: z.string().optional().describe('搜索关键词，如 "Login OTP"'),
        filter: z
          .record(z.unknown())
          .optional()
          .describe('过滤条件，原样传给飞书，如 {"from": "noreply@example.com"}'),
        page_token: z.string().optional().describe('分页标记，首次调用不传'),
        page_size: z.number().int().min(1).max(15).optional().describe('每页数量，最大 15，默认 15'),
      },
    },
    wrapTool(ctx, 'search_mail_messages', async (args, token) =>
      ctx.feishu.callAsUser(token, 'post', '/mail/v1/user_mailboxes/me/search', {
        params: { page_size: args.page_size ?? 15, page_token: args.page_token },
        body: { query: args.query, filter: args.filter },
      }),
    ),
  );

  server.registerTool(
    'move_mail_messages',
    {
      title: '移动邮件到文件夹',
      description:
        '以当前用户身份将一封或多封邮件移入指定文件夹。注意：调用前先向用户展示要移动的邮件 ID 和目标文件夹并获得确认，确认后才能调用本工具。',
      inputSchema: {
        message_ids: z
          .array(z.string())
          .min(1)
          .max(20)
          .describe('要移动的邮件消息 ID 列表（可用 list_mail_messages 获取），单次最多 20 条'),
        folder_id: z.string().describe('目标文件夹 ID（可用 list_mail_folders 获取）'),
      },
    },
    wrapTool(ctx, 'move_mail_messages', async (args, token) =>
      ctx.feishu.callAsUser(token, 'post', '/mail/v1/user_mailboxes/me/messages/batch_modify', {
        body: { message_ids: args.message_ids, add_folder: args.folder_id },
      }),
    ),
  );
}
