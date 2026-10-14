import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { user } from '../../db/schema.js'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'

/**
 * GET /v1/users/me — minimal profile of the authenticated identity. Ownership
 * is by construction: the user id comes from the verified Better Auth session
 * in the request context, never from the request.
 */
export function createUsersRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/me', async (c) => {
    const auth = requireAuthContext(c)
    const rows = await db
      .select({
        id: user.id,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        createdAt: user.createdAt,
      })
      .from(user)
      .where(eq(user.id, auth.userId))
      .limit(1)
    const profile = rows[0]
    if (profile === undefined) {
      // The session check should have caught this; a missing row is a state
      // inconsistency, not an empty profile.
      throw new HttpApiError(401, 'unauthorized', 'Session is no longer valid.')
    }
    return c.json({ data: { user: profile } }, 200)
  })

  return routes
}
