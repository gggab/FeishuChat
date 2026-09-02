// Sentry 告警链路冒烟测试：用真实应用凭证把一条模拟告警卡片发到 FEISHU_ALERT_CHAT_ID 指定的群。
// 用法：npx tsx scripts/sendTestAlert.ts
import { loadConfig } from '../src/config.js';
import { FeishuClient } from '../src/feishu.js';
import { buildFeishuCard, parseSentryAlert } from '../src/sentryAlert.js';

const config = loadConfig();
if (!config.feishuAlertChatId) {
  throw new Error('未配置 FEISHU_ALERT_CHAT_ID，请检查 .env');
}

const feishu = new FeishuClient(config.appId, config.appSecret);
const msg = parseSentryAlert('event_alert', {
  action: 'triggered',
  data: {
    triggered_rule: '网关冒烟测试规则',
    event: {
      title: '冒烟测试：这是一条模拟的 Sentry 告警',
      culprit: 'scripts/sendTestAlert.ts',
      level: 'warning',
      web_url: 'https://sentry.io/',
    },
  },
});

await feishu.sendCardMessage(config.feishuAlertChatId, buildFeishuCard(msg));
console.log(`发送成功，请到群 ${config.feishuAlertChatId} 查看卡片消息`);
