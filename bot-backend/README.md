# bot-backend — ToC 统一业务后端（Better Auth 账号认证）

Hono / Node.js / TypeScript / PostgreSQL (Drizzle) / Redis 的按业务分模块单体服务。
认证完全委托 **Better Auth**（注册 / 登录 / 会话生命周期由库拥有，服务端不自建密码哈希、
JWT 签发或刷新令牌）。架构依据飞书文档《后端服务》（2026-10-14，rev 21，Better Auth 方案），
配套文档《用户认证》。工程是 bot-agent 仓库内的独立 TS 子工程。

## 快速开始（开发）

```bash
npm ci                        # 锁定版本安装
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 18 + Redis 7（无 Docker 时自备两者）
cp .env.example .env          # 填好 DATABASE_URL / REDIS_URL / BETTER_AUTH_SECRET / BETTER_AUTH_URL
npm run db:migrate            # 应用审核过的 SQL 迁移（独立步骤，API 启动不改 Schema）
npm run dev                   # tsx watch 启动
```

生产构建：`npm ci && npm run build && node dist/index.js`。配置全部来自环境变量，
缺失关键项启动即失败。

## 认证接口（Better Auth 拥有，服务端不重复实现）

| 方法与路径 | 说明 |
|---|---|
| POST /api/auth/sign-up/email | 注册（name + email + password），成功即建立会话（Cookie） |
| POST /api/auth/sign-in/email | 登录，建立会话 |
| POST /api/auth/sign-out | 撤销当前会话（携带会话 Cookie 时库强制 Origin 校验） |
| GET /api/auth/get-session | 查询当前会话与用户 |

错误码由库返回（如重复注册 422、密码错误 401）。邮箱验证、找回密码、社交登录、
消息认证不在当前范围。服务端绝不新增自研账号端点——未知 /v1 路径一律要求认证（401）。

**受保护业务路由**：`GET /v1/users/me`（示例），经 `getSession`（禁用 Cookie 缓存，每次
回源权威会话存储）校验；身份只来自服务端验证结果，Body 里的 user_id/role/owner_id 一律
不采信。`GET /healthz`、`GET /readyz`（探测 PG + Redis，不披露秘密）。

## 模型流：POST /api/llm/stream（文档《流式服务端重构》§4）

模型请求统一收口到本服务：厂商地址、厂商密钥与真实模型字符串只在服务端，客户端只能
点名目录里的模型 id。认证复用 Better Auth 会话 Cookie（Agent 子进程携带；Cookie 鉴权的
变更请求强制 `Origin: <BETTER_AUTH_URL>`，缺失/不匹配 403）。**响应头建立前**完成认证、
目录、参数与并发校验：未登录 401、未知模型 404、模型停用 403、厂商密钥未配置 503、
参数非法 400、超限 429（`rate_limited` / `concurrency_limit`）——不发起任何上游调用；
流建立后的失败经 SSE `error` 部件与终止 `end` 事件报告，绝不改写 HTTP 状态。

请求体 = AI SDK 输入格式（Python 客户端负责内部 OpenAI 格式到此格式的映射）：

```jsonc
{
  "model": "目录 id",                       // 服务端 LLM_MODEL_CATALOG 条目
  "system": "可选系统提示",                  // 系统提示专用字段；messages 里禁止 system 角色
  "messages": [                             // AI SDK ModelMessage：user / assistant / tool
    {"role": "user", "content": "你好"},
    {"role": "assistant", "content": [
      {"type": "reasoning", "text": "…", "providerMetadata": {"hono": {"details": "…回放状态"}}},
      {"type": "text", "text": "…"},
      {"type": "tool-call", "toolCallId": "c1", "toolName": "get_weather", "input": {"city": "北京"}}
    ]},
    {"role": "tool", "content": [
      {"type": "tool-result", "toolCallId": "c1", "toolName": "get_weather", "output": {"type": "text", "value": "晴"}}
    ]}
  ],
  "tools": [{"name": "get_weather", "description": "…", "inputSchema": {"type": "object"}}],
  "toolChoice": "auto",                     // auto | none | required | {"tool": "name"}
  "temperature": 0.7, "topP": 0.9, "maxOutputTokens": 4096,
  "stopSequences": ["END"], "seed": 7
}
```

未知字段一律 400（参数白名单，静默丢弃会改变模型行为）。`maxOutputTokens` 受目录
上限钳制。工具只传 JSON Schema、无 execute，服务端绝不执行工具——tool-call 事件之后
由本地 Python Agent 执行并把结果作为下一条请求再次发来。

响应为 SSE（`text/event-stream`、`cache-control: no-cache`、`X-Model-Stream-Version: 1`、
`X-Request-Id`），AI SDK **Core 完整事件流**逐帧转发（不是纯文本流，不是 UI Message Stream）：

```
event: ai-sdk
id: <request_id>:<序号>            // 顺序校验与去重；不代表断线后续传
data: {"type":"start"}
event: ai-sdk
id: <request_id>:4
data: {"type":"text-delta","id":"text_1","text":"你好"}
event: ai-sdk
id: <request_id>:8
data: {"type":"finish","finishReason":"stop","totalUsage":{…}}
event: end
id: <request_id>:9
data: {"request_id":"…","status":"complete"}     // 或 status:"failed" + error
```

规则：完整流必须含生命周期（start/start-step/finish-step/finish）、用量与错误；`text-delta`
字段是 `text`、`tool-input-delta` 是 `delta`（固定 ai@7.0.140，升级不得静默改变字段）。
心跳是 SSE 注释行（`: …`），不代表模型进展。服务端独立超时：首事件 / 流空闲 / 最长请求，
超时即取消上游并发 `end{failed}`。`file`/`raw`/审批等 v1 未开放类型转成显式
`{"type":"unsupported","originalType":…}`——不丢弃、不伪装。`error` 部件脱敏为
`{"message","status?"}`。取消贯通：客户端断开 → 请求 signal → `streamText` AbortSignal →
上游终止。用量以服务端上游回报为准记录（按用户/日，Redis + 结构化日志），缺失标 unknown，
绝不算 0，也不以客户端提交数为结算依据。

模型目录 `LLM_MODEL_CATALOG`（JSON 数组：`id/provider/model/enabled/maxOutputTokens`），
厂商密钥 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` 只在目录引用其 provider 时必需。
Python 侧接入：`agent/hono_stream_client.py` + `plugins/model-providers/hono/`
（`providers.hono.base_url` + `HERMES_BOT_BACKEND_URL`，会话 Cookie 与 accountAuth 共享）。

## 请求边界（共同安全配置，两棵树都生效）

请求 ID（服务端生成，不采信外部 X-Request-Id）→ 安全响应头 + no-store → CORS
（精确 Origin 白名单 + credentials，默认关闭）→ 可信代理解析真实 IP → 10s 处理预算 →
16 KiB 体积 / JSON 媒体类型（畸形 400 / 415 / 413）→ Redis 入口限流（按真实 IP，Redis
不可用 fail-closed 503）→ 登录/注册端点按规范化账号（SHA-256）限流 → Better Auth handler →
getSession 认证 → 按 user_id 限流 → 业务归属 → `app.onError` 统一错误（错误响应带同一套
安全头）→ JSON 访问日志（request_id/路由模板/状态/耗时/IP，不记录头、正文与凭据）。

完整 16 项生产中间件链（§5）是后续完整后端的蓝图；本装配保留认证所需子集。

## 数据模型

Better Auth 生成并管理的四张表（`src/db/schema.ts`，迁移在 `drizzle/`）：
`user` / `session` / `account`（含库哈希的凭据）/ `verification`。
**不要**在旁边维护自研 users.password_hash 或刷新令牌表。

改表流程：编辑 `schema.ts` → `npm run db:generate` → 人工审核 SQL → 发布步骤执行
`npm run db:migrate`。多副本不在启动时竞争迁移。

## 测试

```bash
npm run typecheck   # src + tests 双重严格类型检查
npm test            # 真实集成测试
```

测试自备基础设施：`tests/global-setup.ts` 在临时目录 `initdb` 一次性 PostgreSQL 集群
（不改系统），并用 redis-memory-server 拉起**真实 Redis**；CI 可用
`BOT_BACKEND_TEST_DATABASE_URL` / `BOT_BACKEND_TEST_REDIS_URL` 跳过自备流程。
22 个用例覆盖：注册→会话→登出闭环、重复注册 422、弱密码 400、密码错误 401、会话服务端
撤销后立即失效（禁 Cookie 缓存）、身份只来自服务端会话、伪造 Cookie 拒绝、按账号限流 429、
Redis 故障 fail-closed 503、413/415/400 边界、安全头与请求 ID、配置启动校验、
`/v1` 下无自研账号端点。

## 部署要点

`Dockerfile`（多阶段、非 root、HEALTHCHECK 打 /healthz）+ `deploy/nginx.conf.example`。
上线前固定 Node 24 LTS 补丁版本与基础镜像 digest；`BETTER_AUTH_SECRET` 与
`BETTER_AUTH_URL` 必须与实际入口一致；跨域浏览器客户端需配置 `CORS_ALLOWED_ORIGINS` +
`BETTER_AUTH_TRUSTED_ORIGINS`。桌面端（下一步）经 Better Auth 的 Electron 集成处理认证，
敏感会话凭据留在主进程。

## 明确不在本期范围

消息/agent-bridge 模块、WebSocket、邮箱验证、找回密码、社交登录、完整 16 项中间件、
桌面强制登录接入。代码中无占位实现。
