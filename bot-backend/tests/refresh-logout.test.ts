import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  login,
  registerAndVerify,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

const PASSWORD = 'correct-horse-battery'

describe('refresh rotation, replay detection and logout', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('rotates the refresh token: the old one dies, the new one works', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)
    const first = await login(testApp.app, email, PASSWORD)

    const refreshed = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    })
    expect(refreshed.status).toBe(200)
    const tokens = (await refreshed.json()) as { data: { accessToken: string; refreshToken: string } }
    expect(tokens.data.refreshToken).not.toBe(first.refreshToken)

    // The new pair works against the protected surface.
    const me = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${tokens.data.accessToken}`,
    })
    expect(me.status).toBe(200)

    // The old access token's session was revoked by rotation.
    const oldMe = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${first.accessToken}`,
    })
    expect(oldMe.status).toBe(401)

    const rows = await testApp.database.pool.query(
      'SELECT revoked_reason, replaced_by_session_id FROM login_sessions ORDER BY created_at',
    )
    expect(rows.rows[0]!.revoked_reason).toBe('rotated')
    expect(rows.rows[0]!.replaced_by_session_id).not.toBeNull()
  })

  it('treats refresh-token replay as compromise and kills the whole family', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)
    const first = await login(testApp.app, email, PASSWORD)

    const rotation = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    })
    expect(rotation.status).toBe(200)
    const rotated = (await rotation.json()) as { data: { refreshToken: string; accessToken: string } }

    // Replay the already-consumed token.
    const replay = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: first.refreshToken,
    })
    expect(replay.status).toBe(401)

    // The descendant minted by the stolen rotation is dead too.
    const descendant = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: rotated.data.refreshToken,
    })
    expect(descendant.status).toBe(401)

    const liveSessions = await testApp.database.pool.query(
      'SELECT id FROM login_sessions WHERE revoked_at IS NULL',
    )
    expect(liveSessions.rows).toHaveLength(0)

    const audit = await testApp.database.pool.query(
      "SELECT event FROM auth_audit WHERE event = 'refresh_replayed'",
    )
    // The replay and the stolen descendant both hit the replay path.
    expect(audit.rows).toHaveLength(2)
  })

  it('logout revokes the current device session end to end', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)
    const session = await login(testApp.app, email, PASSWORD)

    const anonymous = await jsonRequest(testApp.app, 'POST', '/v1/auth/logout')
    expect(anonymous.status).toBe(401)

    const logout = await jsonRequest(testApp.app, 'POST', '/v1/auth/logout', undefined, {
      authorization: `Bearer ${session.accessToken}`,
    })
    expect(logout.status).toBe(200)

    const meAfter = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${session.accessToken}`,
    })
    expect(meAfter.status).toBe(401)

    const refreshAfter = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: session.refreshToken,
    })
    expect(refreshAfter.status).toBe(401)

    // The revoked session no longer authenticates anything: a second logout
    // call is rejected by the protected route like any other request.
    const logoutAgain = await jsonRequest(testApp.app, 'POST', '/v1/auth/logout', undefined, {
      authorization: `Bearer ${session.accessToken}`,
    })
    expect(logoutAgain.status).toBe(401)
  })
})
