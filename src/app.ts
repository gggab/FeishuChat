import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Express } from 'express';
import { AuditLogger } from './audit.js';
import { AppConfig } from './config.js';
import { randomToken } from './crypto.js';
import { FEISHU_AUTHORIZE_URL, FeishuClient } from './feishu.js';
import { OAuthStateStore } from './oauthState.js';
import { RateLimiter } from './rateLimit.js';
import { buildFeishuCard, parseSentryAlert, verifySentrySignature } from './sentryAlert.js';
import { SentryProjectStore } from './sentryProjectStore.js';
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
  const { config, feishu, tokenStore, stateStore, audit, rateLimiter, sentryProjectStore } = deps;
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
  app.post('/webhooks/sentry', async (req, res) => {
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
    const alert = parseSentryAlert(resource, req.body);
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
    try {
      await feishu.sendCardMessage(chatId, buildFeishuCard(alert));
      console.log(`[sentry] 已转发告警到飞书群：resource=${resource} project=${alert.projectId ?? '-'} chatId=${chatId}`);
      res.json({ ok: true });
    } catch (err) {
      // 目标群不存在/机器人不在群里等发送失败，不当作网关故障处理（避免 Sentry 重试风暴），仅记录日志后跳过
      console.error(`[sentry] 发送到群 ${chatId} 失败，跳过：`, err);
      res.json({ ok: true, skipped: 'send_failed' });
    }
  });

  // 管理页面鉴权：query ?token= 或 X-Admin-Token 头，任一匹配 ADMIN_TOKEN 即可
  function checkAdminToken(req: express.Request): boolean {
    if (!config.adminToken) return false;
    const token = (req.query.token as string | undefined) ?? req.get('X-Admin-Token') ?? '';
    return token === config.adminToken;
  }

  // Sentry 项目 → 飞书群映射管理页（新增/删除；slug、项目名收到该项目真实告警后自动回填）
  app.get('/admin/sentry-projects', (req, res) => {
    if (!config.adminToken) {
      res.status(503).send(page('未开放', '<h1>未开放</h1><p class="warn">未配置 ADMIN_TOKEN，管理页面已关闭。</p>'));
      return;
    }
    if (!checkAdminToken(req)) {
      res
        .status(401)
        .send(page('需要口令', '<h1>需要访问口令</h1><p>请在链接后加上 <code>?token=你的ADMIN_TOKEN</code> 后重新访问。</p>'));
      return;
    }
    const token = req.query.token as string;
    res.send(
      page(
        'Sentry 项目路由',
        `<h1>Sentry 项目 → 飞书群映射</h1>
<div class="card">
  <p>项目 ID 是 Sentry 里的数字项目 ID；slug / 项目名会在该项目产生第一条真实告警后自动回填，新增时不用填。</p>
  <table id="tbl" style="width:100%; border-collapse: collapse;">
    <thead><tr>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">项目 ID</th>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">项目名 / slug</th>
      <th style="text-align:left; border-bottom:1px solid #dee0e3; padding:6px;">飞书群 chat_id</th>
      <th style="border-bottom:1px solid #dee0e3; padding:6px;"></th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<div class="card">
  <p>新增映射：</p>
  <p>
    <input id="pid" placeholder="Sentry 项目 ID，如 4" style="padding:6px; margin-right:8px;">
    <input id="cid" placeholder="飞书群 chat_id，oc_ 开头" style="padding:6px; width:280px; margin-right:8px;">
    <button id="add" class="btn" style="padding:8px 20px;">新增</button>
  </p>
</div>
<script>
const TOKEN = ${JSON.stringify(token)};
async function api(path, opts) {
  const resp = await fetch(path, { ...opts, headers: { ...(opts && opts.headers), 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' } });
  if (!resp.ok) throw new Error('请求失败：' + resp.status);
  return resp.json();
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
async function refresh() {
  const list = await api('/admin/sentry-projects/api');
  document.getElementById('rows').innerHTML = list.map(r =>
    '<tr>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;">' + esc(r.projectId) + '</td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;">' + (esc(r.name) || esc(r.slug) || '<span style="color:#999">（等待第一条告警）</span>') + '</td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;"><code>' + esc(r.chatId) + '</code></td>' +
    '<td style="padding:6px; border-bottom:1px solid #f0f0f0;"><button data-id="' + esc(r.projectId) + '" class="del">删除</button></td>' +
    '</tr>'
  ).join('') || '<tr><td colspan="4" style="padding:12px; color:#999;">暂无映射，未映射的项目会发到默认群</td></tr>';
  document.querySelectorAll('.del').forEach(btn => btn.onclick = async () => {
    if (!confirm('删除项目 ' + btn.dataset.id + ' 的映射？')) return;
    await api('/admin/sentry-projects/api/' + encodeURIComponent(btn.dataset.id), { method: 'DELETE' });
    refresh();
  });
}
document.getElementById('add').onclick = async () => {
  const projectId = document.getElementById('pid').value.trim();
  const chatId = document.getElementById('cid').value.trim();
  if (!projectId || !chatId) { alert('项目 ID 和 chat_id 都要填'); return; }
  await api('/admin/sentry-projects/api', { method: 'POST', body: JSON.stringify({ projectId, chatId }) });
  document.getElementById('pid').value = '';
  document.getElementById('cid').value = '';
  refresh();
};
refresh();
</script>`,
      ),
    );
  });

  app.get('/admin/sentry-projects/api', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: '口令错误或未配置 ADMIN_TOKEN' });
      return;
    }
    res.json(sentryProjectStore.list());
  });

  app.post('/admin/sentry-projects/api', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: '口令错误或未配置 ADMIN_TOKEN' });
      return;
    }
    const { projectId, chatId } = req.body ?? {};
    if (!projectId || !chatId || typeof projectId !== 'string' || typeof chatId !== 'string') {
      res.status(400).json({ ok: false, message: '需要 projectId 和 chatId（均为字符串）' });
      return;
    }
    res.json({ ok: true, record: sentryProjectStore.upsert(projectId.trim(), chatId.trim()) });
  });

  app.delete('/admin/sentry-projects/api/:projectId', (req, res) => {
    if (!checkAdminToken(req)) {
      res.status(401).json({ ok: false, message: '口令错误或未配置 ADMIN_TOKEN' });
      return;
    }
    res.json({ ok: sentryProjectStore.remove(req.params.projectId) });
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
