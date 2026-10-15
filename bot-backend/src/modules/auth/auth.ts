import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { admin } from 'better-auth/plugins'
import { eq } from 'drizzle-orm'
import type { Database } from '../../db/client.js'
import * as schema from '../../db/schema.js'
import type { Config } from '../../config/env.js'

/**
 * Better Auth instance — the sole owner of registration, login and session
 * lifecycle (doc §6). The service must not add its own password hashing,
 * JWT signing or refresh-token machinery beside this. Email verification,
 * password recovery and social login are out of current scope.
 *
 * The official admin() plugin owns operations-console identity semantics:
 * roles, ban/unban (ban also deletes the user's live sessions and the
 * session-create hook blocks re-login — 停用即时生效), impersonation. The
 * console flips these ONLY through auth.api, never direct column UPDATEs.
 * Bootstrap: an account registered under a BOT_BACKEND_ADMIN_EMAILS address
 * is promoted to role='admin' on creation; afterwards the console manages roles.
 */
export function createAuth(config: Config, database: Database) {
  const adminEmails = new Set(config.BOT_BACKEND_ADMIN_EMAILS.map((email) => email.trim().toLowerCase()))
  return betterAuth({
    secret: config.BETTER_AUTH_SECRET,
    baseURL: config.BETTER_AUTH_URL,
    trustedOrigins: [...config.BETTER_AUTH_TRUSTED_ORIGINS, new URL(config.BETTER_AUTH_URL).origin],
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
    plugins: [admin()],
    databaseHooks: {
      user: {
        create: {
          after: async (created) => {
            if (!adminEmails.has(created.email.toLowerCase())) return
            await database.db.update(schema.user).set({ role: 'admin' }).where(eq(schema.user.id, created.id))
          },
        },
      },
    },
  })
}

export type Auth = ReturnType<typeof createAuth>
