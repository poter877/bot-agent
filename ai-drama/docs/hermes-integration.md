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
  agent 指令天然是独立会话。
- **模型单一来源**：文本模型由 drama profile 的模型配置决定（公司模式，
  指向 bot-backend）；ai-drama 不再选择文本模型。

## 三方环境变量

| 侧 | 变量 | 说明 |
|---|---|---|
| ai-drama | `HERMES_AGENT_URL` | hermes gateway 的 api_server 基址（如 `http://hermes:8642`，多 profile 复用时为 `http://hermes:8642/p/drama`） |
| ai-drama | `HERMES_AGENT_KEY` | gateway 的 `API_SERVER_KEY` |
| ai-drama | `AI_DRAMA_MCP_TOKEN` | hermes↔ai-drama 之间的 MCP 令牌（与 bot-backend 的服务令牌无关） |
| hermes (drama profile) | `API_SERVER_KEY` | api_server 鉴权；与 ai-drama 的 `HERMES_AGENT_KEY` 同值 |

未配置 `HERMES_AGENT_URL`/`HERMES_AGENT_KEY` 时，ai-drama 的 agent 调用直接报错
（不回落本地循环——公司模式先例）。

## drama profile 的 config.yaml

在 drama profile 的 `config.yaml` 中注册 ai-drama 的 MCP 工具服务：

```yaml
mcp_servers:
  ai_drama:
    url: http://ai-drama-backend:3000/mcp   # ai-drama 后端地址 + /mcp
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
   用于媒体/语音/转写直连模型面）。
3. hermes drama profile（`API_SERVER_KEY`、config.yaml 的 `mcp_servers.ai_drama`、
   模型指向公司后端），起 gateway。
4. 验证：ai-drama 前端发起一次编剧/规划请求 → 观察 hermes gateway 日志出现该会话
   的 turn、ai-drama `/mcp` 收到 tools/call、bot-backend 请求日志出现模型调用。
