import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ToolContext, wrapTool } from './context.js';

export function registerImTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    'list_chats',
    {
      title: '列出群聊',
      description: '列出当前用户加入的飞书群聊列表，支持分页。',
      inputSchema: {
        page_token: z.string().optional().describe('分页标记，首次调用不传'),
        page_size: z.number().int().min(1).max(100).optional().describe('每页数量，默认 50'),
      },
    },
    wrapTool(ctx, 'list_chats', async (args, token) =>
      ctx.feishu.callAsUser(token, 'get', '/im/v1/chats', {
        params: { page_token: args.page_token, page_size: args.page_size ?? 50 },
      }),
    ),
  );

  server.registerTool(
    'list_messages',
    {
      title: '列出群消息',
      description: '按创建时间倒序列出指定群聊的消息，支持时间范围过滤和分页。',
      inputSchema: {
        chat_id: z.string().describe('群聊 ID（可用 list_chats 获取）'),
        page_token: z.string().optional().describe('分页标记，首次调用不传'),
        page_size: z.number().int().min(1).max(50).optional().describe('每页数量，默认 20'),
        start_time: z
          .string()
          .optional()
          .describe('起始时间（Unix 秒级时间戳字符串），如 "1700000000"'),
        end_time: z.string().optional().describe('结束时间（Unix 秒级时间戳字符串）'),
      },
    },
    wrapTool(ctx, 'list_messages', async (args, token) =>
      ctx.feishu.callAsUser(token, 'get', '/im/v1/messages', {
        params: {
          container_id_type: 'chat',
          container_id: args.chat_id,
          sort_type: 'ByCreateTimeDesc',
          page_token: args.page_token,
          page_size: args.page_size ?? 20,
          start_time: args.start_time,
          end_time: args.end_time,
        },
      }),
    ),
  );

  server.registerTool(
    'get_message',
    {
      title: '获取消息详情',
      description: '根据消息 ID 获取单条消息的完整内容与元信息。',
      inputSchema: {
        message_id: z.string().describe('消息 ID，如 om_xxxx'),
      },
    },
    wrapTool(ctx, 'get_message', async (args, token) =>
      ctx.feishu.callAsUser(token, 'get', `/im/v1/messages/${encodeURIComponent(args.message_id)}`),
    ),
  );

  server.registerTool(
    'send_message',
    {
      title: '发送消息',
      description:
        '以当前用户身份向指定用户或群聊发送飞书消息。注意：调用前先向用户展示要发送的内容并获得确认，确认后才能调用本工具。',
      inputSchema: {
        receive_id_type: z
          .enum(['open_id', 'user_id', 'union_id', 'email', 'chat_id'])
          .describe('接收者 ID 类型'),
        receive_id: z.string().describe('接收者 ID，与 receive_id_type 对应'),
        msg_type: z.string().default('text').describe('消息类型，常用 text（文本）、post（富文本）'),
        content: z
          .string()
          .describe('消息内容 JSON 字符串，文本消息如 {"text":"你好"}，需先向用户展示并确认'),
      },
    },
    wrapTool(ctx, 'send_message', async (args, token) =>
      ctx.feishu.callAsUser(token, 'post', '/im/v1/messages', {
        params: { receive_id_type: args.receive_id_type },
        body: {
          receive_id: args.receive_id,
          msg_type: args.msg_type,
          content: args.content,
        },
      }),
    ),
  );

  server.registerTool(
    'reply_message',
    {
      title: '回复消息',
      description:
        '以当前用户身份回复指定飞书消息。注意：调用前先向用户展示要发送的内容并获得确认，确认后才能调用本工具。',
      inputSchema: {
        message_id: z.string().describe('要回复的消息 ID，如 om_xxxx'),
        msg_type: z.string().default('text').describe('消息类型，常用 text（文本）、post（富文本）'),
        content: z
          .string()
          .describe('消息内容 JSON 字符串，文本消息如 {"text":"收到"}，需先向用户展示并确认'),
      },
    },
    wrapTool(ctx, 'reply_message', async (args, token) =>
      ctx.feishu.callAsUser(
        token,
        'post',
        `/im/v1/messages/${encodeURIComponent(args.message_id)}/reply`,
        {
          body: { msg_type: args.msg_type, content: args.content },
        },
      ),
    ),
  );
}
