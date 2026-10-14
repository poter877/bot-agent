import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  cookieFrom,
  createTestApp,
  flushRateLimits,
  getSession,
  jsonRequest,
  me,
  registerUser,
  signIn,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

const PASSWORD = 'correct-horse-battery'

describe('Better Auth register / login / session', () => {
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

  it('sign-up stores the account in Better Auth tables and issues a session', async () => {
    const email = uniqueEmail()
    const user = await registerUser(testApp.app, testApp.database, email, PASSWORD)

    const users = await testApp.database.pool.query('SELECT email, name FROM "user"')
    expect(users.rows).toHaveLength(1)
    expect(users.rows[0]!.email).toBe(email)

    // The credential is the library's hashed value inside `account` —
    // never a plaintext or a service-owned password column.
    const accounts = await testApp.database.pool.query(
      'SELECT provider_id, password FROM account WHERE user_id = $1',
      [user.userId],
    )
    expect(accounts.rows[0]!.provider_id).toBe('credential')
    expect(String(accounts.rows[0]!.password)).not.toContain(PASSWORD)

    const session = await getSession(testApp.app, user.cookie)
    expect(session?.user.email).toBe(email)

    const profile = await me(testApp.app, user.cookie)
    expect(profile.status).toBe(200)
    const body = (await profile.json()) as { data: { user: Record<string, unknown> } }
    expect(body.data.user.email).toBe(email)
    expect(JSON.stringify(body)).not.toContain('password')
  })

  it('rejects duplicate sign-up and weak passwords with library-owned errors', async () => {
    const email = uniqueEmail()
    await registerUser(testApp.app, testApp.database, email, PASSWORD)

    const duplicate = await jsonRequest(testApp.app, 'POST', '/api/auth/sign-up/email', {
      name: 'dupe',
      email,
      password: PASSWORD,
    })
    expect(duplicate.status).toBe(422)

    const weak = await jsonRequest(testApp.app, 'POST', '/api/auth/sign-up/email', {
      name: 'weak',
      email: uniqueEmail(),
      password: 'short',
    })
    expect(weak.status).toBe(400)
  })

  it('sign-in answers with a session only for the right password', async () => {
    const email = uniqueEmail()
    await registerUser(testApp.app, testApp.database, email, PASSWORD)

    const wrong = await signIn(testApp.app, email, 'totally-wrong-pass')
    expect(wrong.status).toBe(401)

    const ok = await signIn(testApp.app, email, PASSWORD)
    expect(ok.status).toBe(200)
    const cookie = cookieFrom(ok)
    const session = await getSession(testApp.app, cookie)
    expect(session?.user.email).toBe(email)

    const unknown = await signIn(testApp.app, uniqueEmail(), PASSWORD)
    expect(unknown.status).toBe(401)
  })

  it('sign-out invalidates the session server-side', async () => {
    const email = uniqueEmail()
    const user = await registerUser(testApp.app, testApp.database, email, PASSWORD)
    expect(await getSession(testApp.app, user.cookie)).not.toBeNull()

    const signOut = await jsonRequest(testApp.app, 'POST', '/api/auth/sign-out', {}, { cookie: user.cookie })
    expect(signOut.status).toBe(200)

    expect(await getSession(testApp.app, user.cookie)).toBeNull()
    const profile = await me(testApp.app, user.cookie)
    expect(profile.status).toBe(401)
  })

  it('every authenticated request re-checks the authoritative session store', async () => {
    const email = uniqueEmail()
    const user = await registerUser(testApp.app, testApp.database, email, PASSWORD)

    // A session revoked behind the service's back (e.g. another instance or
    // an admin action) must stop working immediately — no cookie cache ride.
    await testApp.database.pool.query('DELETE FROM session WHERE user_id = $1', [user.userId])
    const profile = await me(testApp.app, user.cookie)
    expect(profile.status).toBe(401)
    expect(((await profile.json()) as { error: { code: string } }).error.code).toBe('unauthorized')
  })

  it('identity comes from the server session, never from the request body', async () => {
    const emailA = uniqueEmail()
    const emailB = uniqueEmail()
    const userA = await registerUser(testApp.app, testApp.database, emailA, PASSWORD)
    const userB = await registerUser(testApp.app, testApp.database, emailB, PASSWORD)

    const profileA = await me(testApp.app, userA.cookie)
    const profileB = await me(testApp.app, userB.cookie)
    const idA = ((await profileA.json()) as { data: { user: { id: string } } }).data.user.id
    const idB = ((await profileB.json()) as { data: { user: { id: string } } }).data.user.id
    expect(idA).toBe(userA.userId)
    expect(idB).toBe(userB.userId)
    expect(idA).not.toBe(idB)

    // A forged session token value cannot authenticate.
    const forged = await me(testApp.app, 'better-auth.session_token=forged-token-value')
    expect(forged.status).toBe(401)
  })

  it('rate limits repeated sign-in attempts per normalized account', async () => {
    const limited = await createTestApp({
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '2',
      RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SECONDS: '60',
    })
    try {
      const email = uniqueEmail()
      await registerUser(limited.app, limited.database, email, PASSWORD)
      await flushRateLimits(limited.redis)

      const first = await signIn(limited.app, email, 'bad-pass-1')
      const second = await signIn(limited.app, email, 'bad-pass-2')
      const third = await signIn(limited.app, email, 'bad-pass-3')
      expect(first.status).toBe(401)
      expect(second.status).toBe(401)
      expect(third.status).toBe(429)
      expect(third.headers.get('retry-after')).toMatch(/^\d+$/)
      const thirdBody = (await third.json()) as { error: { code: string }; request_id: string }
      expect(thirdBody.error.code).toBe('rate_limited')
      expect(thirdBody.request_id).toBeTruthy()
    } finally {
      await limited.close()
    }
  })
})
