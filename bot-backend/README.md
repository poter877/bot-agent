# bot-backend — ToC 统一业务后端（账号模块）

Hono / Node.js / TypeScript / PostgreSQL / Redis 的按业务分模块单体服务。本期交付**账号模块**：
注册、邮箱验证、登录、刷新、退出、密码找回与当前用户资料；所有后续业务（消息等）挂载在同一个
身份与访问边界之后。架构依据飞书文档《后端服务》（2026-10-14 版），账号流程配套文档《用户认证》。

工程是 **bot-agent 仓库内的独立子工程**（自带 package.json / 锁文件 / 依赖 / 部署单元，
与 `apps/desktop`、`web/` 等 TS 子工程同级、独立构建），不与 Hermes Python 运行时耦合。
架构文档中「与 Hermes 源码并列的独立工程」的表述已由项目所有者更正为仓库内子工程。

## 快速开始（开发）

```bash
npm ci                        # 锁定版本安装
docker compose -f docker-compose.dev.yml up -d   # PostgreSQL 18 + Redis 7（无 Docker 时自备两者）
cp .env.example .env          # 填好 DATABASE_URL / REDIS_URL / AUTH_JWT_SECRET
npm run db:migrate            # 应用审核过的 SQL 迁移（独立步骤，API 启动不改 Schema）
npm run dev                   # tsx watch 启动
```

生产构建：`npm ci && npm run build && node dist/index.js`（配置全部来自环境变量，缺失关键项
启动即失败；`MAIL_TRANSPORT=log` 仅限开发，生产禁止启动）。

## 测试

```bash
npm run typecheck   # src + tests 双重严格类型检查
npm test            # 真实集成测试
```

测试自备基础设施：`tests/global-setup.ts` 会在临时目录 `initdb` 一个一次性 PostgreSQL 集群
（不改系统），并用 redis-memory-server 拉起**真实 Redis**；CI 可用
`BOT_BACKEND_TEST_DATABASE_URL` / `BOT_BACKEND_TEST_REDIS_URL` 指向服务容器跳过自备流程。
33 个用例覆盖：注册/验证一次性消费、登录限流（按 IP 与账号）、刷新轮换与重放检测（RFC 9700
§4.14）、退出撤销、找回/重置（含未验证账号经重置转为已验证）、跨用户令牌拒绝、Redis 故障
fail-closed 503、413/415/400 边界、错误路径安全头、配置启动校验、邮件 outbox 重试预算。

## 接口（本期）

| 方法与路径 | 访问规则 | 行为 |
|---|---|---|
| POST /v1/auth/register | 公开、限流（IP+账号） | 创建待验证账号；重复注册返回相同中性响应 |
| POST /v1/auth/verify | 一次性凭据 | 原子消费验证令牌，激活账号 |
| POST /v1/auth/verify/resend | 公开、限流、中性响应 | 仅对待验证账号重发 |
| POST /v1/auth/login | 公开、限流（IP+账号） | Argon2id 校验，创建设备会话并签发凭据 |
| POST /v1/auth/refresh | 刷新凭据自身认证 | 事务内一次性轮换；重放撤销整个轮换族 |
| POST /v1/auth/logout | 已认证 | 撤销当前设备会话 |
| POST /v1/auth/password/forgot | 公开、限流、统一响应 | 防枚举；仅对存在账号投递邮件 |
| POST /v1/auth/password/reset | 一次性凭据 | 改密、撤销全部会话；顺带验证邮箱归属 |
| GET /v1/users/me | 已认证 | 当前用户最小资料 |
| GET /healthz, GET /readyz | 运维探测 | 存活 / 依赖就绪，不披露秘密 |

成功响应 `{ "data": … }`；错误响应 `{ "error": { "code", "message" }, "request_id" }`，
code 取自 `src/shared/http.ts` 的稳定枚举。登录/刷新返回 `accessToken`（短期 JWT，15 分钟）、
`refreshToken`（不透明随机凭据，30 天，服务端只存哈希）与 `expiresInSeconds`。
`/v1` 下未列入公开清单的路径一律要求认证（含未知路径——先 401 再 404，不向匿名者泄露路由存在性）。

## 中间件流水线（`src/app.ts`，顺序即文档 §5）

请求 ID（服务端生成，不采信外部 X-Request-Id）→ 安全响应头 + no-store → CORS（白名单 Origin，
默认关闭）→ 可信代理解析真实 IP（仅信任 TRUSTED_PROXIES 的转发链）→ 10s 处理预算 →
16 KiB 体积 / JSON 媒体类型 / 拒绝压缩体 → Redis 入口限流（按真实 IP）→ 公开 auth 白名单 →
认证链（HS256 JWT 固定算法 + iss/aud/exp + 必需声明，随后查 PostgreSQL：会话未撤销未过期、
账号 active、sub 与会话属主一致；DB 故障 503 绝不放行）→ 按 user_id 限流 → 业务归属 →
`app.onError`/`notFound` 统一错误（错误响应带同一套安全头）→ JSON 访问日志
（request_id/路由模板/状态/耗时/IP，不记录头与正文）。

## 数据模型（`src/db/schema.ts`，迁移在 `drizzle/`）

- `users` — 永久 user_id、唯一规范化 email、Argon2id 哈希、状态（pending_verification/active/disabled）
- `login_sessions` — 设备会话、刷新令牌哈希（唯一索引）、轮换族 family_id、撤销原因与 replaced_by 链
- `verification_tokens` — 用途（verify_email/password_reset）、令牌哈希、期限、used_at、attempt_count
- `auth_audit` — 注册/验证/登录/刷新/退出/找回/重放等事件（含 request_id、IP、UA，无任何秘密）
- `mail_outbox` — 待发验证邮件；后台 worker 有界重试（SKIP-LOCKED 语义由单条 UPDATE…RETURNING 认领实现）

改表流程：编辑 `schema.ts` → `npm run db:generate` → **人工审核 SQL** → 发布步骤执行
`npm run db:migrate`。多副本不在启动时竞争迁移。

## 与架构文档的实现对照

| 文档要求 | 实现位置 |
|---|---|
| 启动配置校验，缺失即失败；生产禁 log 邮件通道 | `src/config/env.ts` |
| 请求 ID 服务端生成（hono 内置会复用外部值，故自实现） | `src/middleware/requestId.ts` |
| 可信代理 / 真实 IP（XFF 自右向左找第一个非信任跳） | `src/middleware/realIp.ts` |
| 体积/媒体类型/压缩体策略（413/415/400） | `src/middleware/bodyPolicy.ts` |
| Redis 原子限流；不可用 fail-closed 503 | `src/redis/rateLimit.ts` |
| JWT 固定算法 + iss/aud + 必需声明（exp 缺失即拒） | `src/modules/auth/tokens.ts` |
| 服务端会话/账号状态权威校验，DB 故障 503 | `src/middleware/auth.ts` |
| Argon2id + 有界并发信号量；未知账号等时校验 | `src/modules/auth/password.ts` |
| 刷新事务轮换 + FOR UPDATE + 重放撤销族（RFC 9700） | `src/modules/sessions/sessions.service.ts` |
| 一次性令牌原子消费 + 尝试计数 | `src/modules/auth/auth.service.ts` |
| 跨实例撤销通知（pub/sub，消息阶段消费点） | `src/redis/events.ts` |
| 邮件 outbox + 有界重试 worker | `src/modules/mail/mail.service.ts` |
| 优雅关停（停止接新 → 排空 → 关 worker/Redis/PG） | `src/index.ts` |

## 部署要点（文档 §9）

`Dockerfile`（多阶段、非 root、HEALTHCHECK 打 /healthz）+ `deploy/nginx.conf.example`
（TLS 入口、覆盖转发头、16k 体积上限；与 `TRUSTED_PROXIES` 对应）。上线前固定 Node 24 LTS
补丁版本与基础镜像 digest；至少两个 API 副本共享 PostgreSQL 与 Redis；迁移先备份再执行；
`CORS_ALLOWED_ORIGINS` 仅在引入浏览器客户端时配置。桌面端（下一步）凭据保存在主进程内存与
系统安全存储，启动时必须经服务端在线校验才能解锁工作界面。

## 明确不在本期范围

消息/agent-bridge 模块、WebSocket/SSE、桌面强制登录接入（用户认证文档实施顺序第 3 步）、
会话列表管理接口。代码中无占位实现。
