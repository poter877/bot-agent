# hermes 编排集成（drama profile 装配指南）

统一后的编排拓扑：**hermes 是唯一 agent 大脑，ai-drama 是领域服务 + 显示面**。

```
ai-drama 前端 ──HTTP──→ ai-drama 后端（领域服务 + 任务队列 + MCP 工具服务）
                          │  chat/completions（system=agent 指令，Bearer HERMES_AGENT_KEY）
                          ▼
                    hermes gateway（drama profile：模型=company，工具=ai_drama MCP）
                          │  模型调用
                          ▼
                    bot-backend /api/llm/stream（模型网关，全仓唯一模型出入口）
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

### 宿主机 dev 网关（不走 trio 容器时）

trio 之外，宿主机直跑（本机现状，端口 30179）：

```bash
# 1. drama profile home（~/hermes-dev-data/drama-home）：
#    config.yaml → model.provider=hono + mcp_servers.ai_drama(localhost:30172/mcp)
#    .env → API_SERVER_KEY=<key>、API_SERVER_PORT=30179、HERMES_BOT_BACKEND_URL
HERMES_HOME=~/hermes-dev-data/drama-home hermes gateway
# 2. bot-backend/.env：HERMES_AGENT_URL=http://127.0.0.1:30179 + HERMES_AGENT_KEY=<同 key>
```

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

