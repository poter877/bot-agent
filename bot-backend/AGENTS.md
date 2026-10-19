# bot-backend/ — ToC unified business backend (Hono model gateway)

Applies on top of the root `AGENTS.md`.

- Hono / Node >= 24 / TypeScript ESM / PostgreSQL + Redis. The repo's single model exit:
  every model call rides `/api/llm/*` (`src/modules/llm/`); vendor SDKs live only here.
- Auth: better-auth (account module). Secrets only in `.env` (copy `.env.example`); missing
  critical values abort startup — no secrets in tracked config.
- DB: drizzle-orm; migrations in `drizzle/`. `npm run db:generate` / `db:migrate` (drizzle-kit);
  review generated SQL like a release step.
- Tests: vitest (`npm test`). `tests/global-setup.ts` self-provisions a throwaway PostgreSQL
  (initdb into a temp dir) + in-memory Redis, or uses CI services via
  `BOT_BACKEND_TEST_DATABASE_URL` / `BOT_BACKEND_TEST_REDIS_URL`; it applies the drizzle
  migrations itself. The suite shares one cluster — `fileParallelism: false` in vitest.config.ts
  is load-bearing, keep it.
- `npm run typecheck` covers src and tests (tsconfig.json + tsconfig.test.json).
- 运营后台双形态：服务端渲染控制台（`/admin`，`admin.views.tsx` + form-post 闪条）与
  React SPA（`admin/`，构建产物同源挂在 `/console`；dev `npm run dev` 跑 30177 并代理
  30172，Origin 由代理改写）。JSON 数据面在 `admin.api.ts`（/admin/api/*），会话身份
  与首启引导共享于 `admin.shared.ts`；`securityMiddleware` 对这两类 HTML 面放宽 CSP
  到 self，其余响应维持 `default-src 'none'`。
- 文本模型适配器由 models.dev 注册表驱动（`src/modules/llm/models-registry.json`
  瘦身快照 + `registry.ts`）：provider 即注册表 id（zhipuai/moonshotai/deepseek/openai/…），
  适配器按条目 `npm` 字段选择（@ai-sdk/openai|anthropic|google 原生，其余
  openai-compatible + 注册表默认端点），密钥 = 控制台凭证 > 注册表 `env` 名对应的
  配置值。刷新注册表：`curl -s https://models.dev/api.json` 后按现有瘦身规则重新
  生成该 JSON（保留 id/name/api/npm/env/models 的 id,name,reasoning,tool_call）。
