import path from 'node:path';
import { createApp } from './app.js';
import { AuditLogger } from './audit.js';
import { loadConfig } from './config.js';
import { FeishuClient } from './feishu.js';
import { OAuthStateStore } from './oauthState.js';
import { RateLimiter } from './rateLimit.js';
import { TokenStore } from './tokenStore.js';

const config = loadConfig();

const feishu = new FeishuClient(config.appId, config.appSecret);
const tokenStore = new TokenStore({
  filePath: path.join(config.dataDir, 'tokens.json'),
  encryptionKey: config.tokenEncryptionKey,
  refreshFn: async (refreshToken) => {
    const resp = await feishu.refreshToken(refreshToken);
    return {
      accessToken: resp.access_token,
      refreshToken: resp.refresh_token,
      expiresIn: resp.expires_in,
      refreshTokenExpiresIn: resp.refresh_token_expires_in,
    };
  },
});

const app = createApp({
  config,
  feishu,
  tokenStore,
  stateStore: new OAuthStateStore(),
  audit: new AuditLogger(config.logDir),
  rateLimiter: new RateLimiter(60, 60_000),
});

app.listen(config.port, () => {
  console.log(`飞书 MCP 网关已启动：${config.publicBaseUrl}（端口 ${config.port}）`);
  console.log(`授权入口：${config.publicBaseUrl}/oauth/login`);
});
