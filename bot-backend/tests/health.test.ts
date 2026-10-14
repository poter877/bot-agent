import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTestApp, jsonRequest, truncateAll, type TestApp } from './helpers.js'

describe('health endpoints', () => {
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

  it('GET /healthz reports liveness without dependency checks', async () => {
    const response = await jsonRequest(testApp.app, 'GET', '/healthz')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { status: string } }
    expect(body.data.status).toBe('ok')
  })

  it('GET /readyz reports readiness when PostgreSQL and Redis answer', async () => {
    const response = await jsonRequest(testApp.app, 'GET', '/readyz')
    expect(response.status).toBe(200)
    const body = (await response.json()) as { data: { status: string; checks: Record<string, string> } }
    expect(body.data.status).toBe('ready')
    expect(body.data.checks).toEqual({ database: 'ok', redis: 'ok' })
  })

  it('GET /readyz exits readiness with 503 when a dependency is down, disclosing no secrets', async () => {
    const dead = await createTestApp({ REDIS_URL: 'redis://127.0.0.1:1' })
    try {
      const response = await jsonRequest(dead.app, 'GET', '/readyz')
      expect(response.status).toBe(503)
      const body = (await response.json()) as { data: { checks: Record<string, string> } }
      expect(body.data.checks.redis).toBe('unavailable')
      const text = JSON.stringify(body)
      expect(text).not.toContain('redis://')
    } finally {
      await dead.close()
    }
  })
})
