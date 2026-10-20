# hermes 编排集成（drama profile 装配指南）

统一后的编排拓扑（《重构》2026-10-20 定稿）：**hermes 是唯一 agent 大脑——视频工厂
的 Agent 会话跑在桌面 app 的本地 serve 里；bot-backend 不再调用 Hermes**。

```
视频工厂页面（桌面 app 内嵌）
  ├─ 业务/媒体/上传 → serve 的 video-studio 插件 → 账号桥 → bot-backend
  └─ Agent 会话 → 本地 serve（session/prompt/event 流）
        ├─ 模型调用 → bot-backend /api/llm/stream（当前用户）
        └─ 领域工具 → MCP 桥（插件 /mcp）→ bot-backend /mcp（用户会话鉴权）
bot-backend（服务器）：模型出口 + 账号库 + 领域数据 + 媒体作业（纯后端，不调 Hermes）
```

- **工具循环在 hermes**：模型要调工具时，hermes 经 MCP（streamable HTTP）调
  ai-drama 的领域工具（读剧本、存分镜、提交生成任务……）。
- **会话隔离**：gateway 按（system 指令, 首条 user 消息）派生会话——每个
  agent 指令天然是独立会话；ai-drama 客户端（`backend/src/services/hermes-agent.ts`
  的 `runHermesAgent`）还会在 system 尾部统一拼 `[task: <correlationId>]` 标识行：
  同指令不同任务（如两个 film run 用同一主题）不再命中同一会话（上下文/记忆串扰），
  同一任务的连续轮次（correlationId 相同，如 creative-chat 多轮对话）仍归同一会话。
- **模型单一来源**：文本模型由 drama profile 的模型配置决定（公司模式，
  指向 bot-backend）；ai-drama 不再选择文本模型。

## 三方环境变量

| 侧 | 变量 | 说明 |
|---|---|---|
| ai-drama | `HERMES_AGENT_URL` | hermes gateway 的 api_server 基址（如 `http://hermes:30175`，多 profile 复用时为 `http://hermes:30175/p/drama`） |
| ai-drama | `HERMES_AGENT_KEY` | gateway 的 `API_SERVER_KEY` |
| ai-drama | `AI_DRAMA_API_TOKEN` | ai-drama 自身 HTTP API 的共享令牌（浏览器/外部调用方用 `Authorization: Bearer`；未配置时仅放行回环来源，容器/公网部署必配。与 MCP 令牌分开命名，可同值部署） |
| ai-drama | `AI_DRAMA_MCP_TOKEN` | hermes↔ai-drama 之间的 MCP 令牌（与 bot-backend 的服务令牌无关） |
| hermes (drama profile) | `API_SERVER_KEY` | api_server 鉴权；与 ai-drama 的 `HERMES_AGENT_KEY` 同值 |

未配置 `HERMES_AGENT_URL`/`HERMES_AGENT_KEY` 时，ai-drama 的 agent 调用直接报错
（不回落本地循环——公司模式先例）。

## drama profile 的 config.yaml

在 drama profile 的 `config.yaml` 中注册 ai-drama 的 MCP 工具服务：

```yaml
# 公司模式默认模型（model 段的 provider 必须是 hono/company-backend，否则
# gateway 回落 config 里的厂商默认并在公司目录中找不到）：
model:
  provider: "hono"
  model: "<目录里的模型别名>"
mcp_servers:
  ai_drama:
    url: http://bot-backend:30172/mcp   # drama 子应用挂在 bot-backend 上 + /mcp
    headers:
      Authorization: Bearer <AI_DRAMA_MCP_TOKEN>
    # 可选：只暴露部分工具（详见 hermes 工具配置）
    # tools:
    #   exclude: []
```

模型配置按公司模式指向 bot-backend（`HERMES_BOT_BACKEND_URL` 等既有约定）。

**工具面提醒**：drama profile 默认仍带 hermes 内建工具（终端/文件等，作用域是该
profile 自己的 HOME）。要收窄到仅 ai-drama 领域工具，用该 profile 的 toolsets/
工具选择配置限制——按运营安全偏好决定，集成本身不要求。

## 部署顺序

1. bot-backend（目录/密钥就绪，含 `INTERNAL_SERVICE_TOKEN`）。
2. ai-drama 后端（`AI_DRAMA_MCP_TOKEN` + `HERMES_AGENT_URL/KEY` + `COMPANY_*`
   用于媒体/语音/转写直连模型面；容器/公网部署另配 `AI_DRAMA_API_TOKEN`
   保护自身 HTTP API，未配置时仅回环可访问）。
3. hermes drama profile（`API_SERVER_KEY`、config.yaml 的 `mcp_servers.ai_drama`、
   模型指向公司后端），起 gateway。
4. 验证：ai-drama 前端发起一次编剧/规划请求 → 观察 hermes gateway 日志出现该会话
   的 turn、ai-drama `/mcp` 收到 tools/call、bot-backend 请求日志出现模型调用。

### 一键联调（deploy/trio）

仓库带三件套联调编排：`deploy/trio/docker-compose.yml`（postgres + redis +
bot-backend + ai-drama，hermes gateway 在 `hermes` profile 下）与
`deploy/trio/smoke.sh`（逐环冒烟：bot-backend 健康/目录 → `/mcp` 工具清单与
fail-closed → gateway `/v1/models` → 可选端到端一次真实 turn，需提供
`DRAMA_ACCOUNT_EMAIL/PASSWORD`，脚本会登录 bot-backend 并把会话写进 drama home
的 `account-auth-cookies.txt`）。

### 桌面 app 入口（视频工厂页，原生挂载）

hermes 桌面 app（`apps/desktop`）侧边栏有「视频工厂」入口，打开 `/drama` 工作区页面。
页面**原生挂载** ai-drama 前端的 React 树（同一份代码，不用 webview/iframe）：

- **嵌入方式**：`ai-drama/frontend-react/src/embed.tsx`（`DramaApp`：memory router +
  embed 模式 Provider 栈）；桌面端 `apps/desktop/src/app/drama/page.tsx` 在**独立
  React root** 中渲染它（react-router 拒绝在宿主 `<Routes>` 子树里再嵌 Router）。
  vite 的 `hermes:drama-source` resolver 把 `@drama/...` 与 drama 源内的 `@/...`
  指到 drama 源码树；react/react-dom 单份共享（alias + dedupe）。
- **API 通道（dev）**：drama 客户端全是同源相对路径（`/api/v1`、`/api/auth`、
  `/static`）；桌面 dev server 把这两个前缀代理到 bot-backend（30172），Better Auth
  cookie 落在渲染进程 origin 上——无 CORS。bot-backend 需把渲染 origin 加入
  `BETTER_AUTH_TRUSTED_ORIGINS`（本地 dev `.env` 已配 `http://127.0.0.1:5174`）。
- **登录**：drama 自己的登录页在页面内完成（probeSession 守卫），与桌面 app 自身的
  账号门（gateway 的 Better Auth 桥）互不影响，同一 bot-backend 账号体系。
- **样式**：drama 的 Tailwind v4 样式随页面 chunk 编译（无 preflight、分层加载）；
  两个设计系统仅 `--color-input` 一个变量重名——页面容器内联重申 drama 值，桌面
  `styles.css` 用 unlayered `html:root` 重申桌面值。
- **布局**：drama 两个布局根是 `h-full`（独立 SPA 与嵌入通吃，standalone 由
  `#root{height:100%}` 撑起）。
- **生产模式注意**：`/api`、`/static` 代理只存在于 `vite dev`；打包后的桌面 app
  需要给嵌入页另一条传输通道（计划：经本地 gateway 转发到 bot-backend，与
  accountAuth 桥同一条"桌面只跟 gateway 说话"的车道）。
- **实现**：`apps/desktop/src/app/drama/`（页面 + 贡献注册），仿 `cloud-computer`
  的 ROUTES_AREA/SIDEBAR_NAV_AREA 模式。

### 部署模型：客户端与服务端

```
客户端（用户机器）                     服务端（我们的服务器）
┌──────────────────────┐             ┌────────────────────────────────┐
│ 桌面 app（Hermes）      │             │ bot-backend（:30172）            │
│  ├ 聊天 → 本地 serve    │             │  ├ 模型出口（全仓唯一）            │
│  │   （app 私随，随开关） │             │  ├ 账号库（Better Auth）          │
│  └ 视频工厂（原生内嵌）   │──HTTPS────→ │  └ 视频工厂领域服务               │
└──────────────────────┘             │ hermes gateway（drama profile）  │
                                     │  └ 编排大脑（:30179）             │
                                     │ PostgreSQL / Redis              │
                                     └────────────────────────────────┘
```

- **客户端组件**（桌面 app、它的 serve）：随 app 开关生灭——serve 负责"在用户机器上
  执行工具"（读写本地文件、跑终端），这是桌面聊天的产品特性，必须在用户侧。
- **服务端组件**（bot-backend、drama gateway、数据库）：部署在服务器，7×24 常驻是
  服务器的本性，与任何人的 app 开关无关。视频工厂的编排大脑属于这一层——
  bot-backend 只经 `HERMES_AGENT_URL` 调它（容器间地址），**绝不在 bot-backend
  进程里拉起任何东西**（bot-backend 是纯后端项目）。
- **部署产物**：`deploy/trio/docker-compose.yml`（postgres + redis + bot-backend +
  hermes-gateway），上服务器即此拓扑。gateway 是核心服务（随堆必起）；drama-home
  由一次性 `drama-home-init` 播种（config.yaml 模板 + 服务令牌凭据，幂等）；
  `smoke.sh` 全链路冒烟（含真实 turn），无需账号密码。
- **开发机**：客户端在本地跑（桌面 app dev），服务端组件的本地替身 =
  bot-backend（tsx watch）+ drama gateway（systemd 用户服务）。替身与服务器组件
  同构，切换到真服务器只需改桌面 app 与 bot-backend 的指向。

### 宿主机 dev 网关（不走 trio 容器时）

trio 之外，宿主机直跑。**网关是 systemd 用户服务**（`~/.config/systemd/user/
hermes-drama-gateway.service`），开机自起、崩溃自动拉起，端口固定 30179：

```
后端分层（"一套后端"的落法）：
  bot-backend(:30172) —— 唯一模型出口 + 唯一账号库（Better Auth）
  hermes gateway(:30179) —— 唯一编排大脑的 OpenAI 兼容面（drama agent 走这里）
  hermes serve(桌面 app 私有) —— 桌面 UI 的 ws 后端（app 自己 spawn，架构钦定）
两个 hermes 进程是两个协议面（/v1 vs /api/ws），serve 不装配 messaging 平台、
gateway 不带 web server——合并不了；但模型、账号、凭据、配置全部收敛在
bot-backend + 各 home 的 config/.env，只有一份真相。
```

drama profile home（`~/hermes-dev-data/drama-home`）：config.yaml → `model.provider:
hono` + `mcp_servers.ai_drama`（127.0.0.1:30172/mcp）；.env → `API_SERVER_KEY`、
`API_SERVER_PORT=30179`、`HERMES_BOT_BACKEND_URL`。bot-backend/.env →
`HERMES_AGENT_URL=http://127.0.0.1:30179` + `HERMES_AGENT_KEY`（同 key）。

三个踩过的坑（2026-10-20 排障记录）：

- **`HERMES_BOT_BACKEND_URL` 只读进程 env**（secret_scope 的 `_GLOBAL_ENV_EXACT`，
  不读 home 的 .env）；桌面 app spawn 的 serve 拿不到启动 shell 的 env 时，回退
  `config.yaml providers.hono.base_url` —— 那里钉 `http://127.0.0.1:30172` 最稳。
- **Python cookiejar 不给 `localhost` 发 host-only cookie**（单标签字母域），
  服务端 Better Auth 的 set-cookie 域跟随请求 host —— 所以 hermes→bot-backend 的
  URL 一律用 `127.0.0.1`（IP 域 cookie 正常收发）。smoke 时代 jar 里的
  `localhost.local` 域就是同一个坑的历史 workaround。
- **`account-auth-token.txt`（Bearer）优先于 cookie jar 且劫持整条账号线**：
  网关只需要模型目录时可以放服务令牌（`INTERNAL_SERVICE_TOKEN`，`/api/llm/models`
  收它）；但需要 Better Auth 登录态的进程（桌面 serve 的 accountAuth 桥）**不能放**，
  否则 signIn 成功而 get-session 判空，登录永远失败。网关（drama-home）放 token、
  桌面 serve（hermes-dev-data）只放 cookie jar，各用各的 home。

### 并发标定（drama 账号是所有 agent turn 的主体）

| 旋钮 | 位置 | 默认 | 说明 |
|---|---|---|---|
| `LLM_STREAM_MAX_CONCURRENT_PER_USER` | bot-backend env | 2 | **必调**：drama 账号承载全部任务，默认 2 会卡住并行 film 任务；按预期并行任务数 × 每任务单 turn 设（compose 里默认给 8） |
| `RATE_LIMIT_LLM_STREAM_*` | bot-backend env | 60/min | 同理放大（compose 给 240/min） |
| 每用户额度覆盖 | 运营后台 用户页 | 服务默认 | 目录/并发/额度的按账号覆盖，比 env 更细 |
| agent 缓存容量 | `gateway/agent_cache_pressure.py`（`AgentCacheBounds`） | 为会话聊天设计 | 长任务（分钟级）大量驻留时按负载调 LRU 上限；改代码，无 env |
| 任务派发并发 | ai-drama 任务队列 | — | 瞬时大批任务时的准入控制放这里，避免全压进 gateway |

