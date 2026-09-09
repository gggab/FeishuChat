import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Express } from 'express';
import { AuditLogger } from './audit.js';
import { AppConfig } from './config.js';
import { randomToken } from './crypto.js';
import { FEISHU_AUTHORIZE_URL, FeishuClient } from './feishu.js';
import { buildFeishuCard } from './feishuCard.js';
import { escapeHtml, page } from './htmlPage.js';
import { OAuthStateStore } from './oauthState.js';
import { RateLimiter } from './rateLimit.js';
import { registerSentryProjectsAdminRoutes } from './routes/sentryProjectsAdmin.js';
import { parseSentryAlert, verifySentrySignature } from './sentryAlert.js';
import { SentryProjectStore } from './sentryProjectStore.js';
import { SentrySettingsStore } from './sentrySettingsStore.js';
import { ToolContext } from './tools/context.js';
import { registerCalendarTools } from './tools/calendar.js';
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
  sentryProjectStore: SentryProjectStore;
  sentrySettingsStore: SentrySettingsStore;
}

export function createApp(deps: AppDeps): Express {
  const { config, feishu, tokenStore, stateStore, audit, rateLimiter, sentryProjectStore, sentrySettingsStore } = deps;
  const app = express();
  const redirectUri = `${config.publicBaseUrl}/oauth/callback`;

  app.use(
    express.json({
      limit: '1mb',
      // 保留原始请求体：Sentry webhook 验签需要对原文做 HMAC
      verify: (req, _res, buf) => {
        (req as typeof req & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );

  app.get('/healthz', (_req, res) => {
    res.json({ ok: true, uptime: process.uptime() });
  });

  // Sentry Internal Integration webhook：验签后以应用身份转发告警卡片到飞书群
  //
  // Sentry 的 webhook 客户端读超时只有 1 秒（实测 error_type=readtimeout），比一次完整的
  // 飞书 API 往返（必要时先换 tenant_access_token，再发卡片）更容易超。所以这里在确定好
  // 目标群之后立刻给 Sentry 回 200，飞书发送放到响应之后异步进行，不让 Sentry 等我们和飞书
  // 之间的网络往返，否则偶发的网络抖动就会被 Sentry 判定为投递失败且不重试。
  app.post('/webhooks/sentry', (req, res) => {
    const { sentryWebhookSecret, feishuAlertChatId } = config;
    if (!sentryWebhookSecret) {
      res.status(503).json({ ok: false, message: '未配置 SENTRY_WEBHOOK_SECRET' });
      return;
    }
    const rawBody = (req as typeof req & { rawBody?: Buffer }).rawBody;
    const signature = req.get('Sentry-Hook-Signature') ?? '';
    if (!rawBody || !verifySentrySignature(rawBody, signature, sentryWebhookSecret)) {
      res.status(401).json({ ok: false, message: '签名校验失败' });
      return;
    }
    const resource = req.get('Sentry-Hook-Resource') ?? 'unknown';
    // 集成被删除 / 安装事件：直接确认，不转发
    if (resource === 'installation' || resource === 'uninstall') {
      res.json({ ok: true, skipped: resource });
      return;
    }
    const alert = parseSentryAlert(resource, req.body, sentrySettingsStore.getTimezone());
    // 项目已配了专属映射就发到对应群，否则退回默认群（.env 里的 FEISHU_ALERT_CHAT_ID）；两者都没有就不发
    const projectMapping = alert.projectId ? sentryProjectStore.get(alert.projectId) : undefined;
    const chatId = projectMapping?.chatId || feishuAlertChatId;
    // 收到真实告警时，为已存在的项目映射自动回填 slug/name，方便管理页面展示
    if (alert.projectId && (alert.projectSlug || alert.projectName)) {
      sentryProjectStore.enrich(alert.projectId, { slug: alert.projectSlug, name: alert.projectName });
    }
    if (!chatId) {
      console.log(`[sentry] 未找到可用的飞书群（项目=${alert.projectId ?? '-'} 且默认群未配置），跳过发送`);
      res.json({ ok: true, skipped: 'no_chat_id' });
      return;
    }
    // 已经决定了目标群，先回应 Sentry，飞书发送异步进行，不占用 Sentry 那 1 秒超时
    res.json({ ok: true });
    feishu
      .sendCardMessage(chatId, buildFeishuCard(alert))
      .then(() => {
        console.log(`[sentry] 已转发告警到飞书群：resource=${resource} project=${alert.projectId ?? '-'} chatId=${chatId}`);
      })
      .catch((err: unknown) => {
        // 目标群不存在/机器人不在群里等发送失败，响应已经发给 Sentry 了，这里只记录日志
        console.error(`[sentry] 发送到群 ${chatId} 失败：`, err);
      });
  });

  registerSentryProjectsAdminRoutes(app, { config, sentryProjectStore, sentrySettingsStore });

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
    // 显式声明所需的用户身份 scope：未传 scope 时飞书只授予已发布版本中的权限，
    // 排查权限问题（99991679）时显式声明可以让飞书直接报出缺失的权限名。
    // offline_access：v2 授权必须显式声明，否则换令牌时不返回 refresh_token（无法自动续期）。
    const scopes = [
      'offline_access',
      'im:chat:readonly',
      'im:message',
      'im:message:readonly',
      'mail:user_mailbox.folder:read',
      'mail:user_mailbox.message:readonly',
      'mail:user_mailbox.message:modify',
      'calendar:calendar:readonly',
      'calendar:calendar.event:read',
    ].join(' ');
    const url =
      `${FEISHU_AUTHORIZE_URL}?app_id=${encodeURIComponent(config.appId)}` +
      `&redirect_uri=${encodeURIComponent(redirectUri)}` +
      `&state=${encodeURIComponent(state)}` +
      `&scope=${encodeURIComponent(scopes)}`;
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
      // 记录飞书实际授予的 scope（仅权限名，不含令牌），用于排查 99991679 类权限问题
      console.log(`[oauth] ${userInfo.name}(${userInfo.open_id}) 授权 scope: ${tokenResp.scope ?? '(未返回)'}`);
      if (!tokenResp.refresh_token) {
        console.warn(
          `[oauth] 警告：飞书未返回 refresh_token，令牌过期后需重新授权。` +
            `请确认授权 URL 已携带 offline_access scope。`,
        );
      }
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
    registerCalendarTools(mcpServer, ctx);

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
