# 飞书多用户 MCP 网关

公司内部的飞书共享 MCP 服务：每位同事用自己的飞书账号 OAuth 授权一次，获得一个**个人专属 MCP URL**，配置到自己的 AI 客户端（Claude Code / Cursor / Kimi Code 等）后，AI 即可以该同事本人的飞书身份：

- 读取群聊列表与聊天消息
- 发送 / 回复飞书消息（工具描述中已要求 AI 先向你展示内容并确认）
- 读取飞书邮箱（文件夹、邮件列表、邮件详情）

> 为什么不用官方 `@larksuiteoapi/lark-mcp`？其 OAuth 模式只支持 localhost 单用户，本项目实现了多用户网关：一个内网部署实例，服务全组同事。

## 架构

```
GET  /              → 说明页 + 「飞书授权登录」入口
GET  /oauth/login   → 生成 state（内存，10 分钟过期），302 到飞书授权页
GET  /oauth/callback→ 校验 state，授权码换 user_access_token + refresh_token，
                      拉取用户信息，AES-256-GCM 加密落盘，生成 user_token，
                      返回成功页展示个人 MCP URL 和客户端配置 JSON
ANY  /mcp/:userToken→ MCP Streamable HTTP 端点（无状态模式），按 userToken 找到
                      用户令牌（距过期 <5 分钟自动用 refresh_token 刷新），以该用户身份调飞书 API
POST /webhooks/sentry→ Sentry Internal Integration webhook：验签后以应用身份把告警
                      卡片发到指定飞书群（tenant_access_token 自动缓存刷新）
GET  /healthz       → 健康检查
```

- 令牌存储：`DATA_DIR/tokens.json`，access_token / refresh_token 均以 AES-256-GCM 加密（密钥来自环境变量），原子写入（临时文件 + rename）。
- 审计日志：`logs/audit.log`，只记录时间、open_id、工具名、参数键名，绝不记录消息/邮件正文和 token。
- 限流：每 userToken 每分钟 60 次（内存滑动窗口）。

## 一、飞书开放平台配置清单

1. 登录 [飞书开放平台](https://open.feishu.cn/)，**开发者后台 → 创建企业自建应用**，记录 `App ID` / `App Secret`。
2. **安全设置 → 重定向 URL**，添加回调地址：
   `http://<内网服务器IP或域名>:3000/oauth/callback`（须与 `PUBLIC_BASE_URL` 拼出的地址完全一致）。
3. **权限管理**，为应用开通以下 scope：

   | scope | 用途 |
   |---|---|
   | `im:message` | 发送 / 回复消息 |
   | `im:message:readonly` | 读取消息 |
   | `im:chat:readonly` | 读取群列表（只读） |
   | `im:chat` | 群信息读写 |
   | `mail:user_mailbox.folder:read` | 读取邮箱文件夹 |
   | `mail:user_mailbox.message:readonly` | 读取邮件列表与详情 |
   | `mail:user_mailbox.message:modify` | 移动邮件到文件夹（batch_modify） |
   | `contact:user.id:readonly` | 读取用户 ID（获取用户信息） |
   | `calendar:calendar:readonly` | 读取用户主日历 |
   | `calendar:calendar.event:read` | 读取用户日程（list_calendar_events） |

   > 全部加在「**用户身份**」下。授权 URL 会显式携带 scope（不传时飞书只授予 `auth:user.id:read`），因此**新增权限后必须：创建版本并发布 → 用户重新授权**，否则工具调用报 99991679。

   > 建议同时开启「获取用户 user ID」类基础权限；若调用时返回 99991672/99991679 等权限错误，按报错提示补开对应权限并重新发布版本。
4. **版本管理与发布 → 创建版本并发布**（企业自建应用提交后由管理员审核通过即生效）。后续每次改权限都要重新发布。

## 二、部署步骤（内网服务器）

环境要求：Node.js ≥ 20（无原生编译依赖，无需 sqlite）。

```bash
# 1. 安装依赖并构建
npm install
npm run build

# 2. 配置环境变量
cp .env.example .env
# 生成加密密钥并填入 .env 的 TOKEN_ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# 填写 APP_ID / APP_SECRET，把 PUBLIC_BASE_URL 改成 http://<内网IP>:3000

# 3. 启动（三选一）
npm start                 # 直接运行
# 用 PM2：
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
# 或用 systemd（无需装 PM2，Ubuntu 自带）：
sudo cp deploy/feishu-mcp-gateway.service /etc/systemd/system/
# 按需修改 Unit 文件中的 WorkingDirectory / ExecStart（node 路径）/ User
sudo systemctl daemon-reload
sudo systemctl enable --now feishu-mcp-gateway
systemctl status feishu-mcp-gateway          # 查看状态
journalctl -u feishu-mcp-gateway -f          # 跟踪日志
```

Docker 方式：

```bash
docker build -t feishu-mcp-gateway .
docker run -d --name feishu-mcp-gateway \
  -p 3000:3000 \
  --env-file .env \
  -v $(pwd)/data:/app/data -v $(pwd)/logs:/app/logs \
  feishu-mcp-gateway
```

验证：`curl http://127.0.0.1:3000/healthz` 返回 `{"ok":true,...}`。

## 三、同事使用指南

1. 浏览器打开 `http://<内网IP>:3000/`，点击「飞书授权登录」，用飞书扫码/确认授权。
2. 授权成功页会展示你的**专属 MCP URL** 和配置 JSON，例如：

   ```json
   {
     "mcpServers": {
       "feishu": {
         "type": "http",
         "url": "http://192.168.x.x:3000/mcp/<你的userToken>"
       }
     }
   }
   ```

3. 把它加入自己 AI 客户端的 MCP 配置（Claude Code 的 `~/.claude.json` / Cursor 的 `mcp.json` / Kimi Code 的 MCP 配置），重启客户端即可。
4. **注意：该 URL 等同于你的飞书身份凭证，不要分享给他人。** 若泄露，联系管理员删除 `data/tokens.json` 中对应条目并重启（或直接编辑删除该 userToken 条目）。

## 四、Sentry 告警接入（可选）

把 Sentry 告警以**当前飞书应用（机器人）身份**推送到飞书群：

1. **飞书侧**：
   - 确认应用已开启**机器人能力**（开发者后台 → 应用能力 → 机器人），并把机器人拉进目标群；
   - `im:message` 权限需对**应用身份**生效（如权限只加在「用户身份」下，需在权限管理中补开并重新发布版本）；
   - 拿到目标群的 `chat_id`（`oc_` 开头，可通过 `list_chats` 工具或 `im/v1/chats` 接口查到），填入 `.env` 的 `FEISHU_ALERT_CHAT_ID`。
2. **Sentry 侧**：Settings → Developer Settings → New Internal Integration：
   - Webhook URL 填 `http://<内网IP>:3000/webhooks/sentry`；
   - 勾选 **Alert Rule Action**（issue 告警）或订阅 **Metric Alert** webhook；
   - 保存后复制集成的 **Client Secret**，填入 `.env` 的 `SENTRY_WEBHOOK_SECRET`。
3. 在 Sentry 告警规则（Alerts → Create Alert）的 action 中选择该内部集成即可。

网关用 `Sentry-Hook-Signature`（HMAC-SHA256）验签，伪造请求会被 401 拒绝；`SENTRY_WEBHOOK_SECRET` 缺失时端点整体返回 503，不影响其他功能。发送用的是 `tenant_access_token`（应用身份），网关内缓存、距过期 5 分钟自动重取。

**按项目路由到不同群（可选）**：访问 `http://<网关地址>:3000/admin/sentry-projects?token=<ADMIN_TOKEN>`（先在 `.env` 配好 `ADMIN_TOKEN`）管理"项目 → 群"映射：

- 新增映射只需填 **Sentry 项目 ID**(数字，Sentry 项目设置页能看到) 和目标群 `chat_id`；
- 项目名 / slug 不用手填，会在**该项目第一次真实告警到达后自动回填**，方便核对填的项目 ID 对不对；
- 命中映射的项目发到对应群；没配映射的项目发到 `.env` 的 `FEISHU_ALERT_CHAT_ID` 默认群；如果默认群也没配（留空），未映射项目的告警会被跳过、不发送；
- 目标群不存在 / 机器人不在群里导致发送失败时，也只是记日志跳过，不会当作网关故障返回错误（避免 Sentry 触发重试风暴）。

`metric_alert` 类型的 payload 没有数字项目 ID，无法参与按项目路由，始终发到默认群。

**卡片时间显示时区（可选，按项目/群单独配置）**：飞书卡片没有"按查看者本地时区显示"的概念，只能固定选一个时区渲染成文本。在同一个新增映射的表单里可以给每条"项目 → 群"映射额外填一个 IANA 时区名（如 `Asia/Shanghai`），面向不同地区的群就配不同的时区——比如中国群配 `Asia/Shanghai`（UTC+8），利雅得群配 `Asia/Riyadh`（UTC+3），互不影响。留空则该项目沿用默认时区 `Asia/Riyadh`（UTC+3），没有任何项目映射的默认群也用这个默认值。

## 五、开发

```bash
npm run dev        # tsx 热启动
npm test           # vitest 单元测试（不依赖真实飞书凭证）
npm run typecheck  # 类型检查
npm run build      # 编译到 dist/
```

## 六、端到端联调步骤（需要真实飞书应用后执行）

1. 按第一节完成飞书应用配置并发布，`.env` 填入真实 `APP_ID` / `APP_SECRET`。
2. 启动服务后走一遍完整授权流程，确认成功页能拿到 MCP URL。
3. 用支持 MCP 的客户端配置该 URL，依次验证：
   - `list_chats` 能列出自己加入的群；
   - `list_messages` / `get_message` 能读到群消息；
   - `send_message` / `reply_message` 能发出消息（AI 应先展示内容并请你确认）；
   - `list_mail_folders` / `list_mail_messages` / `get_mail_message` 能读邮箱（需邮箱权限已发布；`get_mail_message` 默认 metadata 格式，需要主题/发件人/正文时传 `format: "full"`）；
   - `search_mail_messages` 能按关键词和 from/to/folder 等条件搜索邮件；
   - `move_mail_messages` 能把邮件批量移入指定文件夹（AI 应先展示并请你确认）。
4. 观察 `logs/audit.log` 是否按预期记录调用（无正文、无 token）。
5. 令牌过期场景：user_access_token 有效期约 2 小时，网关会在距过期 <5 分钟时自动刷新；refresh_token（约 30 天）过期后工具会返回错误，提示重新访问 `/oauth/login` 授权。

## 安全说明

- `TOKEN_ENCRYPTION_KEY` 只存在服务器 `.env` 中，请妥善保管；丢失后已加密令牌无法解密，所有人需重新授权。
- `data/` 与 `logs/` 已在 `.gitignore` 中排除，不要提交到仓库。
- 审计日志刻意只记参数键名，正文内容不落盘。
