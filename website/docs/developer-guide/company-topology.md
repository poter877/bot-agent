---
sidebar_position: 2
title: "Company Topology"
description: "三件套公司架构总览：hermes（唯一 agent 大脑）、bot-backend（模型网关）、ai-drama（领域服务）——模型面与编排面的契约、关联 id 与联调"
---

# Company Topology（公司架构总览）

这个仓库不再是一台机器上的单机开源 agent：它是一个三件套（trio）拓扑中的一环。
本页给出公司架构的叙事总览——谁负责什么、跨服务的契约长什么样、一个请求怎么穿
过三层——读完你就知道一段代码该改在哪一侧、一次失败该去哪一层查。

各层内部结构仍以本站其余文档为准（如 [Architecture](./architecture.md)、
[Gateway Internals](./gateway-internals.md)）；编排装配的**权威文档**是
[`ai-drama/docs/hermes-integration.md`](https://github.com/poter877/bot-agent/blob/main/ai-drama/docs/hermes-integration.md)
（drama profile 装配指南），本页不复制其内容，只链接。

## 三件套拓扑

```text
┌──────────────────────────┐   领域工具 (MCP /mcp)    ┌──────────────────────────┐
│  ai-drama                │◄─────────────────────────│  hermes                  │
│  影视领域服务 + 显示面     │                          │  唯一 agent 大脑 + 显示面  │
│  任务队列 / 剧本 / 分镜    │──────chat/completions───►│  CLI / TUI / 桌面 / 消息  │
│  媒体生成任务             │  (system=指令, Bearer     │  gateway: drama profile  │
└──────────┬───────────────┘   API_SERVER_KEY)        └──────────┬───────────────┘
           │                                                       │ 模型调用 (公司模式)
           │ 媒体/语音/转写直连模型面                                 │ POST /api/llm/stream
           │ (COMPANY_SERVICE_TOKEN)                                ▼
           └────────────────────────────────────►┌──────────────────────────┐
                                              │  bot-backend (Hono)      │
                                              │  模型网关：目录 / 配额 /   │
                                              │  计量 / 厂商密钥          │
                                              └──────────────────────────┘
```

| 服务 | 职责 | 不是什么 |
|---|---|---|
| **hermes** | 唯一的 agent 大脑：工具循环、记忆、技能、子代理都在这里跑；同时是所有显示面（CLI、TUI、桌面、20+ 消息平台）的宿主。对外以 gateway 的 api_server 暴露编排接口 | 不做模型路由，不持有厂商密钥 |
| **bot-backend** | 全仓唯一的模型出入口（Hono 模型网关）：服务端模型目录、按用户配额与并发、每请求计量、厂商密钥只落在这里 | 不是 agent，没有工具循环 |
| **ai-drama** | 影视领域服务 + 自己的显示面：剧本/分镜/任务队列等领域逻辑，领域工具经 MCP 暴露给 hermes；媒体类生成任务直连模型面 | 不再选择文本模型、不再自跑 agent 循环 |

工具循环**只在 hermes**：模型要调工具时，hermes 经 MCP 调 ai-drama 的领域工具
（读剧本、存分镜、提交生成任务……），结果回喂给模型继续推理。

## 模型面契约（bot-backend）

所有模型请求（文本与媒体）都落在 bot-backend 的两组路由上。主体有两种：Better Auth
**用户会话**（cookie），或**内部服务主体**（服务令牌，见下文）——同一套目录、配额
与用量账本。

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/llm/models` | GET | 文本模型目录（只回目录 id、显示名、capabilities 等；厂商真实 model 串不回传） |
| `/api/llm/stream` | POST | 文本模型流：**AI SDK Core 全事件流** over SSE——每个 Core part 一帧 `event: ai-sdk`（`id: <requestId>:<seq>` 供排序去重），结尾显式 `{request_id, status: complete\|failed}` 哨兵帧；心跳是 SSE 注释行；每用户并发受 `LLM_STREAM_MAX_CONCURRENT_PER_USER` 约束 |
| `/api/media/models` | GET | 媒体模型目录（按 kind 区分） |
| `/api/media/image` `/video` `/speech` `/transcription` | POST | 媒体生成（图片/视频/语音/转写；生成失败答 502） |
| `/api/media/queue` | POST | 公司侧内化的轮询：一次请求 = 一次生成结果查询 |

关键不变量：

- **目录单源。** 客户端只报**目录 id**；id → 厂商与真实 model 串的映射只存在服务端
  （`llm_models` / `media_models` 表，见 `bot-backend/src/db/schema.ts`）。运营后台
  （`/admin`）对这两张表做 CRUD；`LLM_MODEL_CATALOG` / `LLM_IMAGE_CATALOG` /
  `LLM_VIDEO_CATALOG` 等 env 只是**空表种子**，不是目录本身。
- **配额分层。** 服务默认（env：并发、`RATE_LIMIT_LLM_STREAM_*` 限流等）可被运营后台
  的每用户覆盖（`user_quotas`：日额度 / 并发 / 模型 allowlist）覆盖。
- **计量落库。** 每个模型流请求一行 `llm_request_log`（成功、失败、被配额拒绝都记），
  运营后台的"失败请求"页以此为准。
- **内部服务主体。** `INTERNAL_SERVICE_TOKEN`（正名；`MEDIA_SERVICE_TOKEN` 是已部署
  的别名）以 `Bearer` 呈现时，请求被归账到服务用户（`MEDIA_SERVICE_USER_ID`）——
  ai-drama 的服务端调用走这条路，且服务主体不受浏览器同源约束。

hermes 侧对应的是 **company mode**（`agent/company_backend_policy.py` +
`plugins/model-providers/hono/`）：`HERMES_BOT_BACKEND_URL`（或桌面运行时）一旦生效，
模型客户端强制走公司后端、鉴权用 profile 的 Better Auth 会话 cookie
（`<HERMES_HOME>/account-auth-cookies.txt`），**没有厂商回落**；模型选择器投影公司目录，
`hono` provider 对选择器隐藏、仅显式 opt-in。

## 编排面契约（hermes gateway ↔ ai-drama）

### `/v1/chat/completions`（gateway api_server）

ai-drama 后端作为客户端调用 gateway 的 OpenAI 兼容端点（`Authorization: Bearer
<API_SERVER_KEY>`，即 ai-drama 侧的 `HERMES_AGENT_KEY`）：

- **system 消息 = agent 指令。** gateway 把 system 消息折叠为叠加在核心提示词之上的
  临时系统提示词（ephemeral system prompt）——ai-drama 用它下发"你是编剧/分镜师"式
  的角色指令。
- **会话派生规则。** 未显式带 `X-Hermes-Session-Id` 时，会话 id 由
  （system 指令, 首条 user 消息）指纹派生（`_derive_chat_session_id`，按 profile
  命名空间隔离）——**每条不同的 agent 指令天然是独立会话**，同一指令的多轮复用同一
  会话。显式 `X-Hermes-Session-Id`（需配 API key）则续既有会话。

### MCP `/mcp`（ai-drama 后端）

ai-drama 的领域工具经 streamable HTTP 的无状态 MCP 端点暴露
（`ai-drama/backend/src/mcp/route.ts`）：

- 鉴权 `Authorization: Bearer <AI_DRAMA_MCP_TOKEN>`——这是 hermes↔ai-drama 之间的
  令牌，与 bot-backend 的服务令牌**无关**；env 未配置或不匹配一律 403（fail-closed）。
- **工具结果图片回喂。** 工具返回的 MCP `ImageContent` 由 hermes 缓存为 `MEDIA:` 标签，
  并至多 4 张以原生 `image_url` 部件回喂模型（`tools/mcp_tool_content.py`）——渲染
  自检类工具（如"渲染当前工程并返回 JPEG"）靠这条通路闭环。

### drama profile 装配

编排装配（三方环境变量表、drama profile `config.yaml` 的 `mcp_servers.ai_drama`、
部署顺序、并发标定旋钮）以
[`ai-drama/docs/hermes-integration.md`](https://github.com/poter877/bot-agent/blob/main/ai-drama/docs/hermes-integration.md)
为**权威**，此处不复制。要点：模型配置按 company mode 指向 bot-backend；drama
profile 默认仍带 hermes 内建工具（作用域是该 profile 自己的 HOME），要收窄到仅
ai-drama 领域工具需用该 profile 的 toolsets 配置，集成本身不要求。

## 关联 id：`X-Correlation-Id` 三层贯穿

一次 ai-drama 影片任务触发的整条链路，用同一个关联 id 串起来（形状约束
`[A-Za-z0-9._:-]{1,128}`，不合规静默丢弃，三层规则一致）：

1. **ai-drama** 把 film 任务 / run id 盖在发给 gateway 的 `X-Correlation-Id` 头上；
   `/mcp` 收到带该头的工具调用也落一行日志。
2. **hermes gateway** 的 api_server 中间件把该头绑定进请求作用域
   （`request_correlation_scope`），turn 内的所有模型调用都携带它转发。
3. **bot-backend** 的 `correlationIdMiddleware` 原样记录，落到
   `llm_request_log.correlation_id`；运营后台的"失败请求"页按它把
   **ai-drama 任务 → gateway turn → 模型请求日志**三层拼在一起——排查失败不再对
   时间戳。

## 联调：`deploy/trio/`

仓库自带三件套联调编排：

- `deploy/trio/docker-compose.yml`——postgres + redis + bot-backend + ai-drama；
  hermes gateway 放在 `hermes` profile 下（`docker compose --profile hermes up -d`），
  drama profile 的 `HERMES_HOME` 挂在命名卷上，首次启动后放入 config.yaml 再重启。
- `deploy/trio/smoke.sh`——逐环冒烟：① bot-backend 健康 + 服务令牌可读模型目录 →
  ② `/mcp` tools/list 与无令牌 403（fail-closed）→ ③ gateway `/v1/models` →
  ④ 可选端到端一次真实 turn（设 `DRAMA_ACCOUNT_EMAIL/PASSWORD`：脚本登录 bot-backend
  并把会话写进 drama home 的 `account-auth-cookies.txt`）。

## 术语表

| 术语 | 含义 |
|---|---|
| **company mode** | hermes 的强制公司模型路由：`HERMES_BOT_BACKEND_URL` / 桌面运行时 / `model.provider: hono` 任一生效即激活；模型请求必须走 bot-backend，无厂商回落 |
| **drama profile** | hermes 的一个 profile（独立 HERMES_HOME）：模型指向 bot-backend（company mode）、`mcp_servers` 注册 ai-drama 的 `/mcp`、`API_SERVER_KEY` 供 ai-drama 回调；是 ai-drama 编排的运行载体 |
| **服务主体**（service principal） | bot-backend 的服务器间调用身份：`INTERNAL_SERVICE_TOKEN`（别名 `MEDIA_SERVICE_TOKEN`）→ 归账到服务用户，与用户会话共用目录/配额/账本 |
| **目录 id**（catalog id） | 客户端可见的模型名（`llm_models.id` / `media_models.id`）；厂商与真实 model 串只在服务端目录里，运营后台 CRUD 管理 |
