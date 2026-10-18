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
