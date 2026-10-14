import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { LogTransport, OutboxWorker } from '../src/modules/mail/mail.service.js'
import { loadConfig } from '../src/config/env.js'
import {
  createTestApp,
  jsonRequest,
  registerAndVerify,
  truncateAll,
  uniqueEmail,
  type TestApp,
} from './helpers.js'

describe('mail outbox worker', () => {
  let testApp: TestApp

  beforeAll(async () => {
    testApp = await createTestApp()
  })

  beforeEach(async () => {
    await truncateAll(testApp.database)
  })

  afterAll(async () => {
    await testApp.close()
  })

  it('drains pending mail through the transport and marks it sent', async () => {
    await registerAndVerify(testApp.app, testApp.database, uniqueEmail(), 'correct-horse-battery')
    const worker = new OutboxWorker(testApp.database.db, new LogTransport(testApp.logger), testApp.config, testApp.logger)
    const drained = await worker.drainOnce()
    expect(drained).toBe(1)

    const rows = await testApp.database.pool.query('SELECT status, sent_at FROM mail_outbox')
    expect(rows.rows[0]!.status).toBe('sent')
    expect(rows.rows[0]!.sent_at).not.toBeNull()

    expect(await worker.drainOnce()).toBe(0)
  })

  it('retries transient failures with a bounded budget, then marks the mail failed', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: testApp.config.DATABASE_URL,
      REDIS_URL: testApp.config.REDIS_URL,
      AUTH_JWT_SECRET: 'unit-test-secret-0123456789abcdef0123456789abcdef',
      MAIL_FROM: 'test@bot-backend.invalid',
      APP_BASE_URL: 'https://accounts.test.local',
      MAIL_OUTBOX_MAX_ATTEMPTS: '2',
    })
    await registerAndVerify(testApp.app, testApp.database, uniqueEmail(), 'correct-horse-battery')

    const failing = {
      send: async () => {
        throw new Error('smtp unavailable')
      },
    }
    const worker = new OutboxWorker(testApp.database.db, failing, config, testApp.logger)
    expect(await worker.drainOnce()).toBe(1)
    let rows = await testApp.database.pool.query('SELECT status, attempts FROM mail_outbox')
    expect(rows.rows[0]!.status).toBe('pending')
    expect(rows.rows[0]!.attempts).toBe(1)

    expect(await worker.drainOnce()).toBe(1)
    rows = await testApp.database.pool.query('SELECT status, attempts FROM mail_outbox')
    expect(rows.rows[0]!.status).toBe('failed')
    expect(rows.rows[0]!.attempts).toBe(2)

    // Exhausted mail is not picked up again.
    expect(await worker.drainOnce()).toBe(0)
  })
})

describe('configuration is validated at startup', () => {
  const base = {
    NODE_ENV: 'test' as const,
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379',
    MAIL_FROM: 'a@b.c',
    APP_BASE_URL: 'https://x.test',
  }

  it('refuses to boot without a real signing secret', () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'short' })).toThrow(/AUTH_JWT_SECRET/)
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: undefined })).toThrow(/AUTH_JWT_SECRET/)
  })

  it('refuses to boot without the authoritative stores', () => {
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'x'.repeat(32), DATABASE_URL: undefined })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ ...base, AUTH_JWT_SECRET: 'x'.repeat(32), REDIS_URL: undefined })).toThrow(/REDIS_URL/)
  })

  it('forbids the log mail transport in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUTH_JWT_SECRET: 'x'.repeat(32), MAIL_TRANSPORT: 'log' }),
    ).toThrow(/MAIL_TRANSPORT/)
  })

  it('requires SMTP settings when the smtp transport is selected', () => {
    expect(() =>
      loadConfig({ ...base, AUTH_JWT_SECRET: 'x'.repeat(32), MAIL_TRANSPORT: 'smtp' }),
    ).toThrow(/SMTP_HOST/)
  })
})
