import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    // tests/drama 走独立 tsx --test（npm run test:drama），不进 vitest
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/drama/**'],
    // The suite shares one PostgreSQL cluster; run files sequentially so
    // table truncation between cases cannot race.
    fileParallelism: false,
    pool: 'forks',
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
