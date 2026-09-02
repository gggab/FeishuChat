// 模拟 Sentry 发一条验签正确的 webhook 请求到本地网关，验证「验签 → 转发 → 飞书群」完整链路。
// 密钥从 .env 读取，不打印。用法：npx tsx scripts/simulateSentryAlert.ts
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
if (!config.sentryWebhookSecret) {
  throw new Error('未配置 SENTRY_WEBHOOK_SECRET，请检查 .env');
}

const body = JSON.stringify({
  action: 'triggered',
  data: {
    triggered_rule: '端到端联调规则',
    event: {
      title: '模拟告警：端到端联调（verify → forward → feishu）',
      culprit: 'scripts/simulateSentryAlert.ts',
      level: 'error',
      web_url: 'https://sentry.io/',
    },
  },
});

const signature = crypto.createHmac('sha256', config.sentryWebhookSecret).update(body, 'utf8').digest('hex');

const resp = await fetch(`http://127.0.0.1:${config.port}/webhooks/sentry`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Sentry-Hook-Signature': signature,
    'Sentry-Hook-Resource': 'event_alert',
  },
  body,
});
console.log(`网关响应：HTTP ${resp.status}`, await resp.json());
