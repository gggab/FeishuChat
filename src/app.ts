import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Express } from 'express';
import { AuditLogger } from './audit.js';
import { AppConfig } from './config.js';
import { randomToken } from './crypto.js';
import { FEISHU_AUTHORIZE_URL, FeishuClient } from './feishu.js';
import { OAuthStateStore } from './oauthState.js';
import { RateLimiter } from './rateLimit.js';
import { ToolContext } from './tools/context.js';
import { registerImTools } from './tools/im.js';
import { registerMailTools } from './tools/mail.js';
import { TokenStore } from './tokenStore.js';

export interface AppDeps {
  config: AppConfig;
  feishu: FeishuClient;
  tokenStore: TokenStore;
  stateStore: OAuthStateStore;
  audit: AuditLogger;
  rateLimiter: RateLimiter;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - 飞书 MCP 网关</title>
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 720px; margin: 48px auto; padding: 0 16px; color: #1f2329; }
  h1 { font-size: 22px; }
  .card { border: 1px solid #dee0e3; border-radius: 8px; padding: 20px; margin: 16px 0; }
  .btn { display: inline-block; background: #3370ff; color: #fff; padding: 10px 24px; border-radius: 6px; text-decoration: none; }
  code, pre { background: #f5f6f7; border-radius: 4px; }
  code { padding: 2px 6px; word-break: break-all; }
  pre { padding: 12px; overflow-x: auto; }
  .warn { color: #b71c1c; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function createApp(deps: AppDeps): Express {
  const { config, feishu, tokenStore, stateStore, audit, rateLimiter } = deps;
  const app = express();
  const redirectUri = `${config.publicBaseUrl}/oauth/callback`;

  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  app.get('/', (_req, res) => {
    res.send(
      page(
        '首页',
        `<h1>飞书多用户 MCP 网关</h1>
<div class="card">
  <p>这是公司内部的飞书 MCP 共享服务。点击下方按钮，使用你的飞书账号完成授权后，会生成一个<span>你个人专属</span>的 MCP URL，把它配置到你的 AI 客户端（Claude Code / Cursor / Kimi Code 等）即可让 AI 读取你的聊天消息、回复消息、读取你的飞书邮箱。</p>
  <p><a class="btn" href="/oauth/login">飞书授权登录</a></p>
  <p class="warn">注意：授权后生成的 MCP URL 等同于你的飞书身份凭证，请勿分享给他人。</p>
</div>`,
      ),
    );
  });

  app.get('/oauth/login', (_req, res) => {
    const state = stateStore.generate();
    const url =
      `${FEISHU_AUTHORIZE_URL}?app_id=${encodeURIComponent(config.appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}`;
    res.redirect(302, url);
  });

  app.get('/oauth/callback', async (req, res) => {
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) {
      res.status(400).send(page('授权失败', `<h1>授权失败</h1><p class="warn">${escapeHtml(error)}</p>`));
      return;
    }
    if (!state || !stateStore.consume(state)) {
      res
        .status(400)
        .send(
          page('授权失败', '<h1>授权失败</h1><p class="warn">state 校验失败或已过期（有效期 10 分钟），请重新<a href="/oauth/login">授权登录</a>。</p>'),
        );
      return;
    }
    if (!code) {
      res.status(400).send(page('授权失败', '<h1>授权失败</h1><p class="warn">缺少授权码 code。</p>'));
      return;
    }
    try {
      const tokenResp = await feishu.exchangeCode(code, redirectUri);
      const userInfo = await feishu.getUserInfo(tokenResp.access_token);
      const userToken = randomToken(32);
      const now = Date.now();
      tokenStore.saveUser(userToken, {
        openId: userInfo.open_id,
        name: userInfo.name,
        accessToken: tokenResp.access_token,
        refreshToken: tokenResp.refresh_token ?? '',
        accessTokenExpiresAt: now + tokenResp.expires_in * 1000,
        refreshTokenExpiresAt: now + (tokenResp.refresh_token_expires_in ?? 30 * 24 * 3600) * 1000,
      });
      const mcpUrl = `${config.publicBaseUrl}/mcp/${userToken}`;
      const clientConfig = JSON.stringify(
        { mcpServers: { feishu: { type: 'http', url: mcpUrl } } },
        null,
        2,
      );
      res.send(
        page(
          '授权成功',
          `<h1>授权成功，${escapeHtml(userInfo.name)}！</h1>
<div class="card">
  <p>你的专属 MCP URL：</p>
  <p><code>${escapeHtml(mcpUrl)}</code></p>
  <p>在你的 AI 客户端的 MCP 配置中加入：</p>
  <pre>${escapeHtml(clientConfig)}</pre>
  <p class="warn">该 URL 等同于你的飞书身份凭证，请勿分享给他人；如泄露请联系管理员在服务端删除对应令牌。</p>
</div>`,
        ),
      );
    } catch (err) {
      console.error('[oauth] 回调处理失败:', err);
      res
        .status(502)
        .send(
          page('授权失败', `<h1>授权失败</h1><p class="warn">${escapeHtml((err as Error).message)}</p><p><a href="/oauth/login">重新授权</a></p>`),
        );
    }
  });

  // 无状态 MCP Streamable HTTP 端点：每个请求独立 server + transport
  app.all('/mcp/:userToken', async (req, res) => {
    const { userToken } = req.params;
    if (!rateLimiter.allow(userToken)) {
      res.status(429).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '请求过于频繁（每用户每分钟 60 次上限），请稍后再试' },
        id: null,
      });
      return;
    }
    const user = tokenStore.getUser(userToken);
    if (!user) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: '无效的 MCP URL：用户不存在或已被删除，请重新授权' },
        id: null,
      });
      return;
    }

    const ctx: ToolContext = { feishu, tokenStore, userToken, openId: user.openId, audit };
    const mcpServer = new McpServer(
      { name: 'feishu-mcp-gateway', version: '1.0.0' },
      { instructions: '以当前授权用户的飞书身份读写消息与邮件。写操作（发送/回复消息）前必须先向用户展示内容并获得确认。' },
    );
    registerImTools(mcpServer, ctx);
    registerMailTools(mcpServer, ctx);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcpServer.close();
    });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error('[mcp] 请求处理失败:', err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: '网关内部错误' },
          id: null,
        });
      }
    }
  });

  return app;
}
