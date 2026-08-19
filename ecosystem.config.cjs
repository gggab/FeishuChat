module.exports = {
  apps: [
    {
      name: 'feishu-mcp-gateway',
      script: 'dist/index.js',
      instances: 1, // 令牌存储为本地 JSON 文件 + 内存 state/限流，须保持单实例
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
      },
      // 其余配置（APP_ID/APP_SECRET/TOKEN_ENCRYPTION_KEY/...）走项目根目录 .env
    },
  ],
};
