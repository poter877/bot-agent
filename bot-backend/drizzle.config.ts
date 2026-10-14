import { defineConfig } from 'drizzle-kit'

/**
 * Migration workflow (per the architecture doc): generate versioned SQL with
 * `npm run db:generate`, review it, and apply it as a separate release step
 * with `npm run db:migrate` — API processes never mutate the schema at boot.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
})
