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

消息/agent-bridge 模块、WebSocket/SSE、邮箱验证、找回密码、社交登录、完整 16 项中间件、
桌面强制登录接入。代码中无占位实现。
