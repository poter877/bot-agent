import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  createTestApp,
  extractTokenFromMailBody,
  flushRateLimits,
  jsonRequest,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

const PASSWORD = 'correct-horse-battery'

async function outboxRows(testApp: TestApp, purpose: string): Promise<Array<Record<string, unknown>>> {
  const result = await testApp.database.pool.query('SELECT * FROM mail_outbox WHERE purpose = $1', [purpose])
  return result.rows as Array<Record<string, unknown>>
}

describe('registration and email verification', () => {
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

  it('creates a pending account, queues a verification mail, and never echoes credentials', async () => {
    const email = uniqueEmail()
    const response = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', {
      email,
      password: PASSWORD,
      displayName: 'Test User',
    })
    expect(response.status).toBe(202)
    const body = (await response.json()) as { data: { accepted: boolean; message: string } }
    expect(body.data.accepted).toBe(true)

    const users = await testApp.database.pool.query(
      'SELECT email, status, display_name, password_hash FROM users',
    )
    expect(users.rows).toHaveLength(1)
    const user = users.rows[0] as Record<string, unknown>
    expect(user.email).toBe(email)
    expect(user.status).toBe('pending_verification')
    expect(user.display_name).toBe('Test User')
    // Stored hash, never a plaintext password.
    expect(String(user.password_hash)).toMatch(/^\$argon2id\$/)
    expect(JSON.stringify(body)).not.toContain(PASSWORD)

    const mails = await outboxRows(testApp, 'verify_email')
    expect(mails).toHaveLength(1)
    expect(String(mails[0]!.to_email)).toBe(email)
    expect(String(mails[0]!.body_text)).toContain('/verify?token=')
  })

  it('answers a duplicate registration with the same neutral shape and creates nothing', async () => {
    const email = uniqueEmail()
    const first = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })
    const firstBody = await first.json()
    const mailsBefore = await outboxRows(testApp, 'verify_email')

    const second = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })
    const secondBody = await second.json()

    expect(second.status).toBe(first.status)
    expect(secondBody).toEqual(firstBody)
    const users = await testApp.database.pool.query('SELECT id FROM users')
    expect(users.rows).toHaveLength(1)
    const mailsAfter = await outboxRows(testApp, 'verify_email')
    expect(mailsAfter).toHaveLength(mailsBefore.length)
  })

  it('rejects weak passwords and smuggled fields with a 400 validation contract', async () => {
    const weak = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', {
      email: uniqueEmail(),
      password: 'short',
    })
    expect(weak.status).toBe(400)
    const weakBody = (await weak.json()) as { error: { code: string } }
    expect(weakBody.error.code).toBe('validation_failed')

    const smuggled = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', {
      email: uniqueEmail(),
      password: PASSWORD,
      owner_id: crypto.randomUUID(),
      role: 'admin',
    })
    expect(smuggled.status).toBe(400)

    const badEmail = await jsonRequest(testApp.app, 'POST', '/v1/auth/register', {
      email: 'not-an-email',
      password: PASSWORD,
    })
    expect(badEmail.status).toBe(400)
  })

  it('verifies an account exactly once with the one-time token', async () => {
    const email = uniqueEmail()
    await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })
    const mails = await outboxRows(testApp, 'verify_email')
    const token = extractTokenFromMailBody(String(mails[0]!.body_text))

    const verified = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify', { token })
    expect(verified.status).toBe(200)

    const users = await testApp.database.pool.query('SELECT status, email_verified_at FROM users WHERE email = $1', [email])
    expect(users.rows[0]!.status).toBe('active')
    expect(users.rows[0]!.email_verified_at).not.toBeNull()

    const replay = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify', { token })
    expect(replay.status).toBe(400)
    const replayBody = (await replay.json()) as { error: { code: string } }
    expect(replayBody.error.code).toBe('invalid_token')

    const garbage = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify', {
      token: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    })
    expect(garbage.status).toBe(400)
  })

  it('resends verification only while the account is still pending', async () => {
    const email = uniqueEmail()
    await jsonRequest(testApp.app, 'POST', '/v1/auth/register', { email, password: PASSWORD })
    const mailsBefore = await outboxRows(testApp, 'verify_email')

    const pendingResend = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify/resend', { email })
    expect(pendingResend.status).toBe(202)
    expect((await outboxRows(testApp, 'verify_email')).length).toBe(mailsBefore.length + 1)

    const mails = await outboxRows(testApp, 'verify_email')
    await jsonRequest(testApp.app, 'POST', '/v1/auth/verify', {
      token: extractTokenFromMailBody(String(mails.at(-1)!.body_text)),
    })

    const activeResend = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify/resend', { email })
    expect(activeResend.status).toBe(202)
    const activeBody = await activeResend.json()
    const unknownResend = await jsonRequest(testApp.app, 'POST', '/v1/auth/verify/resend', {
      email: uniqueEmail(),
    })
    expect(unknownResend.status).toBe(202)
    // Same neutral shape for active and unknown accounts: no enumeration.
    expect(await unknownResend.json()).toEqual(activeBody)
    expect((await outboxRows(testApp, 'verify_email')).length).toBe(mails.length)
  })
})
