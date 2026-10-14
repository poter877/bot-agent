import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { users } from '../../db/schema.js'
import type { AppEnv } from '../../shared/context.js'
import { requireAuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'

/**
 * GET /v1/users/me — minimal profile of the authenticated identity. Ownership
 * is by construction: the user id comes from the verified auth context, never
 * from the request.
 */
export function createUsersRoutes(db: Db): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get('/me', async (c) => {
    const auth = requireAuthContext(c)
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        status: users.status,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, auth.userId))
      .limit(1)
    const user = rows[0]
    if (user === undefined) {
      // The session check should have caught this; a missing row is a state
      // inconsistency, not an empty profile.
      throw new HttpApiError(401, 'unauthorized', 'Session is no longer valid.')
    }
    return c.json({ data: { user } }, 200)
  })

  return routes
}
