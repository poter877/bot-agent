import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  extractTokenFromMailBody,
  flushRateLimits,
  jsonRequest,
  login,
  registerAndVerify,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

const PASSWORD = 'correct-horse-battery'
const NEW_PASSWORD = 'fresh-passphrase-99'

async function resetTokenFromOutbox(testApp: TestApp): Promise<string> {
  const mails = await testApp.database.pool.query(
    "SELECT body_text FROM mail_outbox WHERE purpose = 'password_reset' ORDER BY created_at DESC LIMIT 1",
  )
  return extractTokenFromMailBody(String(mails.rows[0]!.body_text))
}

describe('password forgot / reset', () => {
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

  it('answers forgot requests identically whether or not the account exists', async () => {
    const email = uniqueEmail()
    await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)

    const known = await jsonRequest(testApp.app, 'POST', '/v1/auth/password/forgot', { email })
    const unknown = await jsonRequest(testApp.app, 'POST', '/v1/auth/password/forgot', {
      email: uniqueEmail(),
    })
    expect(known.status).toBe(202)
    expect(unknown.status).toBe(202)
    expect(await unknown.json()).toEqual(await known.json())

    const mails = await testApp.database.pool.query(
      'SELECT to_email FROM mail_outbox WHERE purpose = $1',
      ['password_reset'],
    )
    // Exactly one mail — only for the account that exists.
    expect(mails.rows).toHaveLength(1)
    expect(mails.rows[0]!.to_email).toBe(email)
  })

  it('changes the password, revokes every session, and retires the token', async () => {
    const email = uniqueEmail()
    const user = await registerAndVerify(testApp.app, testApp.database, email, PASSWORD)
    const before = await login(testApp.app, email, PASSWORD)
    await jsonRequest(testApp.app, 'POST', '/v1/auth/password/forgot', { email })
    const token = await resetTokenFromOutbox(testApp)

    const reset = await jsonRequest(testApp.app, 'POST', '/v1/auth/password/reset', {
      token,
      newPassword: NEW_PASSWORD,
    })
    expect(reset.status).toBe(200)

    // Old credentials and session are gone.
    const oldLogin = await jsonRequest(testApp.app, 'POST', '/v1/auth/login', { email, password: PASSWORD })
    expect(oldLogin.status).toBe(401)
    const oldMe = await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, {
      authorization: `Bearer ${before.accessToken}`,
    })
    expect(oldMe.status).toBe(401)
    const oldRefresh = await jsonRequest(testApp.app, 'POST', '/v1/auth/refresh', {
      refreshToken: before.refreshToken,
    })
    expect(oldRefresh.status).toBe(401)

    // New password works.
    const newLogin = await login(testApp.app, email, NEW_PASSWORD)
    expect(newLogin.user.id).toBe(user.userId)

    // One-time consumption.
    const reuse = await jsonRequest(testApp.app, 'POST', '/v1/auth/password/reset', {
      token,
      newPassword: 'another-passphrase-1',
    })
    expect(reuse.status).toBe(400)
  })

  it('a completed reset verifies a still-pending account (mailbox ownership proven)', async () => {
    const email = uniqueEmail()
    await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })
    await jsonRequest(testApp.app, 'POST', '/v1/auth/password/forgot', { email })
    const token = await resetTokenFromOutbox(testApp)

    const reset = await jsonRequest(testApp.app, 'POST', '/v1/auth/password/reset', {
      token,
      newPassword: NEW_PASSWORD,
    })
    expect(reset.status).toBe(200)

    const users = await testApp.database.pool.query('SELECT status FROM users WHERE email = $1', [email])
    expect(users.rows[0]!.status).toBe('active')
    const direct = await login(testApp.app, email, NEW_PASSWORD)
    expect(direct.user.status).toBe('active')
  })
})
