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
等账号扩展不在当前范围。模型目录、模型请求和业务路由均要求认证。
服务端绝不新增自研账号端点——未知 /v1 路径一律要求认证（401）。

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
      {"type": "reasoning", "text": "…", "providerOptions": {"anthropic": {"signature": "…原始签名"}}},
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

模型目录 `LLM_MODEL_CATALOG` 是 JSON 数组，每项包含 `id/provider/model`，可选
`enabled/displayName/default/contextLength/maxOutputTokens/capabilities`。
厂商密钥 `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GOOGLE_GENERATIVE_AI_API_KEY`
只在目录引用对应的 `openai` / `anthropic` / `google` provider 时必需。
Python 侧接入：`agent/hono_stream_client.py` + `plugins/model-providers/hono/`
（`providers.hono.base_url` + `HERMES_BOT_BACKEND_URL`，会话 Cookie 与 accountAuth 共享）。

### 公司模型目录与桌面选择

`GET /api/llm/models` 使用同一 Better Auth 认证，返回 `Cache-Control: private, no-store`。
仅包含已启用且服务端配置了对应厂商密钥的模型；不返回厂商密钥、上游地址或真实模型名。
响应为 `{models: [{id, displayName, capabilities, contextLength?, maxOutputTokens?}], defaultModel}`。
`defaultModel` 优先取标记 `default: true` 的可用条目，否则取首个；空目录返回 `null`。
模型 id 忽略大小写匹配且不能重复，最多指定一个默认模型。

```json
[
  {
    "id": "company-video",
    "displayName": "公司多模态助手",
    "provider": "google",
    "model": "gemini-2.5-flash",
    "default": true,
    "contextLength": 1048576,
    "maxOutputTokens": 8192,
    "capabilities": {"tools": true, "vision": true, "video": true, "reasoning": true}
  }
]
```

能力声明应与公司实际开放的模型一致。公共目录 `text` 固定为 true；兼容旧目录，
未填写 `tools/vision` 时默认为 true，`video/reasoning` 默认为 false。
桌面的聊天模型选择、模型设置与辅助模型选择都读取此目录。加载失败时显示错误并可重试，
不会展示本地缓存的厂商目录或提供自定义厂商密钥入口。
首次登录或恢复旧厂商会话时使用公司默认模型；已选择的公司别名失效时明确报错。
启动引导也遵守公司模式：服务或目录故障只提供错误提示与重试，不引导用户填写厂商密钥。
目录的上下文长度、输出 token 上限以及工具/视觉能力同步到本地 Agent 的实际运行配置。

### 统一路由与登录生命周期

桌面进程、配置了公司后端地址的 Python 进程，以及显式选择 Hono 的配置，均使用公司路由。
主模型、标题、压缩、视觉等辅助调用都由 Hono 发起；旧会话的厂商 URL、密钥和备用直连配置
不能覆盖它。未知目录 id 会报错，不会转向其他厂商。通用 CLI 未启用公司配置时保留原路由。

桌面未确认登录时仅挂载登录/注册界面；每 30 秒及窗口重新聚焦时向账号服务复核。
登录失效、断网或退出会收回业务界面，清空内存状态；Python 中断该 profile 的活动任务并
清理模型客户端。退出即使遇到远端不可达也清除本地会话凭据。账号与密码的权威存储始终
在服务端；本地仅保留权限为 0600 的会话 Cookie 和工作数据。
本地业务 RPC 也校验公司登录状态，模型请求仍由 Hono 在每次请求时独立认证。

### 多轮工具调用回放

Python 接收 AI SDK 完整事件流，并按原顺序保存文本、推理和工具调用。厂商元数据经
`reasoning_details` → `NormalizedResponse.provider_data` → 本地会话历史持久化；下一轮
转换为 AI SDK 部件的 `providerOptions`。保留 Anthropic 签名及 redactedData、Google
thoughtSignature、OpenAI itemId/encrypted reasoning。服务端兼容输入的
`providerMetadata` 并规范化为 `providerOptions`，不会将这些状态降成纯文本。
回放匹配当前保留的工具调用 id；已被历史裁剪移除的工具不会重新出现。
Agent 循环、工具执行和工作文件继续留在本地。

### 图片、视频与工具截图输入

用户 `content` 支持字符串或文本与文件部件数组。图片、视频、音频和文档沿用 AI SDK 7 的
`file` 格式；工具截图放在 `tool-result.output: {type: "content", value: [...]}`，不能转成
JSON 字符串代替媒体。`assistant.content` 也接受文件回放，所选 provider 必须支持该角色。

```json
{
  "model": "company-video",
  "messages": [{
    "role": "user",
    "content": [
      {"type": "text", "text": "分析这段视频"},
      {"type": "file", "mediaType": "video/mp4", "filename": "clip.mp4", "data": {"type": "data", "data": "<纯 base64，实际请求需替换>"}}
    ]
  }]
}
```

`data.type=data` 是纯 base64（data URL 由 Python 拆分 MIME 和数据）；`data.type=url`
使用公开 HTTP(S) URL 字符串，后端转为 AI SDK 要求的 `URL` 实例。只允许模型原生接收的
URL 直传，后端禁用 SDK 自动下载；需要下载的 URL 返回 `media_inline_required`，请发送
文件字节。Google 的工具结果和 assistant 文件使用 inline 数据，避免 SDK 将 URL 文本化。
`providerOptions` 保留图片精度等部件参数，例如 `openai.imageDetail`。

当前固定依赖 `ai@7.0.140`、`@ai-sdk/google@4.0.96`、`@ai-sdk/openai@4.0.94`、
`@ai-sdk/anthropic@4.0.80`。图片由支持视觉的模型处理；原生视频使用 Google provider 中
支持视频的 Gemini 模型。OpenAI/Anthropic 原生视频、以及其 SDK 无法回放的 assistant
文件会在 SSE 开始前明确返回 `unsupported_media`，不会悄悄丢掉媒体。目录按公司授权配置，
例如 `{"id":"company-video","provider":"google","model":"gemini-2.5-flash"}`。

桌面 Agent 的普通及辅助视觉调用都配置 Hono，密钥留在后端；本地 `config.yaml` 例如：

```yaml
providers:
  hono:
    base_url: https://api.example.com
model:
  provider: hono
  default: company-video
  supports_vision: true
auxiliary:
  vision:
    provider: hono
    model: company-video
```

模型路由的 JSON 请求上限默认 64 MiB，可用 `LLM_STREAM_BODY_LIMIT_BYTES` 调整，最大
256 MiB，计入 base64 约 4/3 的膨胀；超限返回 413。反向代理模型路径需配置相同上限，
账号接口仍使用原来的 16 KiB 限制。大视频优先用模型支持的文件 URL，避免重复内联。
本节针对媒体输入与理解；图片／视频生成输出仍遵循 v1 的显式 unsupported 事件约定。

## 媒体生成：POST /api/media/image、POST /api/media/video

图像/视频生成与模型流同一准入梯：Better Auth 会话 + `Origin` 校验 + 服务端目录
（`LLM_IMAGE_CATALOG` / `LLM_VIDEO_CATALOG`，形状同 llm 目录）+ 每用户媒体预算
（`RATE_LIMIT_MEDIA_*`）+ 每媒体树独立处理预算（`MEDIA_REQUEST_TIMEOUT_MS`，默认 10 分钟，
视频生成合法耗时远超普通请求）。厂商密钥（`FAL_KEY` / `XAI_API_KEY` /
`GOOGLE_GENERATIVE_AI_API_KEY` / `OPENAI_API_KEY`）只在服务端；client 只能点名目录 id。
响应为普通 JSON（非流式）：`{ok, images|videos: [{media_type, base64}]}`；目录/参数错误
在响应头前以 400/403/404/503 拒绝，厂商失败以 502 返回（错误信息脱敏）。
每次请求按用户/日计入 `media:usage:*`（Redis），生成的字节不落服务端存储——
调用方收 base64 自行落盘。视频当前仅 fal（队列轮询由 SDK 内部处理）；
图像支持 fal/openai/google/xai。

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
测试覆盖：注册→会话→登出闭环、重复注册 422、弱密码 400、密码错误 401、会话服务端
撤销后立即失效（禁 Cookie 缓存）、身份只来自服务端会话、伪造 Cookie 拒绝、按账号限流 429、
Redis 故障 fail-closed 503、413/415/400 边界、安全头与请求 ID、配置启动校验、
`/v1` 下无自研账号端点；模型目录授权、流式取消、图片/视频与工具截图、以及三家厂商
SDK 的两轮签名回放；运营后台的管理员门槛、停用闭环（立即掉线+拒重登）、额度强制
（quota_exceeded / model_not_allowed）、目录 CRUD 联动网关、请求日志。厂商请求使用模拟
HTTP 响应，不消耗真实模型额度。

## 运营管理后台（/admin，SSR，中文界面）

浏览器打开 `https://<后端>/admin`，用 Better Auth 账号登录（同源 Cookie）。首次开通：把运营
人员的邮箱写进 `BOT_BACKEND_ADMIN_EMAILS`，该邮箱**注册即成为管理员**（`role=admin`）；之后的
角色管理都在后台内完成。身份与停用全部走 Better Auth 官方 admin 插件——服务端不自建角色表、
不自建封禁逻辑。

| 页面 | 能做什么 |
|---|---|
| 用户 | 搜索/列出用户；**停用**（填原因，库同时吊销其全部会话——立即掉线且无法重登）/ **启用**；设为/取消管理员（不能操作自己）；进入个人页 |
| 个人页（额度并入用户） | 每日 token 上限、并发流上限、可用模型白名单（留空=跟随服务默认/不限制）；当日已知用量；该用户最近 20 条请求 |
| 模型 | 目录 CRUD（新增/编辑/启停/删除、默认模型唯一）——**改目录不再动配置文件**：`llm_models` 表是唯一事实源，`LLM_MODEL_CATALOG` 仅在空表时播种一次；15 秒内对全部实例生效 |
| 请求 | 每条已归属的模型流请求（完成/失败/拒绝）——错误信息、用量、耗时，按状态筛选，失败请求排查的入口 |
| 状态 | PostgreSQL / Redis 连通、进行中的模型流数、运行时长、用户与目录统计、24h 请求量与失败率 |

约束：所有表单 POST 重新校验 `Origin`（CSRF）；每页都回源校验会话角色（禁 Cookie 缓存）；
拒绝服务路径：非管理员一律 403。额度生效点在模型流的**响应头建立前**（`quota_exceeded` /
`model_not_allowed` / 并发上限），拒绝同样落请求日志。

## 部署要点

`Dockerfile`（多阶段、非 root、HEALTHCHECK 打 /healthz）+ `deploy/nginx.conf.example`。
上线前固定 Node 24 LTS 补丁版本与基础镜像 digest；`BETTER_AUTH_SECRET` 与
`BETTER_AUTH_URL` 必须与实际入口一致；跨域浏览器客户端需配置 `CORS_ALLOWED_ORIGINS` +
`BETTER_AUTH_TRUSTED_ORIGINS`。桌面经本地 Python 网关访问 Better Auth，敏感会话凭据
保存在 profile 的 Cookie 文件中，不传给 renderer。

## 明确不在本期范围

服务端 Agent 执行、业务 WebSocket、邮箱验证、找回密码、
社交登录、完整 16 项中间件。真实公司环境的部署、证书与厂商账号联调需单独验收。

## 账号专属云电脑（公司服务器自建）

已增加 Better Auth 账号归属、每账号一台桌面、异步创建/启动/停止/恢复、持久化 home、
截图、鼠标/键盘操作与人工接管租约。桌面新增“云电脑”入口，经本地 Python 转发；
Agent 使用现有 `computer_use` provider 接口，模型调用和 Agent 循环仍按前述架构运行。
本地 terminal/browser 工具不会因为打开云电脑而被重定向。

Hono 只连接私有 worker；worker 在专用 Linux 宿主机管理 Docker，公开 API 不挂载 Docker
socket。功能默认关闭，配置好 worker 后启用。数据库迁移新增 `cloud_computer`。
首版画面为约每秒截图刷新，支持坐标操作、拖动、滚动、快捷键和 Unicode 文本粘贴，
不宣称实时视频或 noVNC 流。停止保留文件和浏览器资料，正在运行的进程不做内存快照。

部署步骤、接口和验收边界见 [cloud-computer.md](cloud-computer.md)。
