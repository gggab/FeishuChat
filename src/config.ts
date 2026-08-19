import 'dotenv/config';

export interface AppConfig {
  appId: string;
  appSecret: string;
  tokenEncryptionKey: string;
  port: number;
  publicBaseUrl: string;
  dataDir: string;
  logDir: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`缺少必需的环境变量 ${name}，请检查 .env 配置`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tokenEncryptionKey = env.TOKEN_ENCRYPTION_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(tokenEncryptionKey)) {
    throw new Error(
      'TOKEN_ENCRYPTION_KEY 必须是 64 个十六进制字符（32 字节），' +
        '可用命令生成：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return {
    appId: requireEnv('APP_ID'),
    appSecret: requireEnv('APP_SECRET'),
    tokenEncryptionKey: tokenEncryptionKey.toLowerCase(),
    port: Number(env.PORT ?? 3000),
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? `http://127.0.0.1:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
    dataDir: env.DATA_DIR ?? './data',
    logDir: env.LOG_DIR ?? './logs',
  };
}
