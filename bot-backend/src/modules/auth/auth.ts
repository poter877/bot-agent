import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import type { Database } from '../../db/client.js'
import * as schema from '../../db/schema.js'
import type { Config } from '../../config/env.js'

/**
 * Better Auth instance — the sole owner of registration, login and session
 * lifecycle (doc §6). The service must not add its own password hashing,
 * JWT signing or refresh-token machinery beside this. Email verification,
 * password recovery and social login are out of current scope.
 */
export function createAuth(config: Config, database: Database) {
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: config.BETTER_AUTH_TRUSTED_ORIGINS,
    database: drizzleAdapter(database.db, {
      provider: 'pg',
      schema: {
        user: schema.user,
        session: schema.session,
        account: schema.account,
        verification: schema.verification,
      },
    }),
    emailAndPassword: {
      enabled: true,
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
