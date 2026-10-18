import { createHash } from 'node:crypto'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { apiTokens } from '../src/db/schema.js'
import {
  createTestApp,
  flushRateLimits,
  jsonRequest,
  registerUser,
  truncateAll,
  uniqueEmail,
  type RegisteredUser,
  type TestApp,
} from './helpers.js'

/**
 * 用户 API 令牌（bat_ bearer）：签发 → bearer 调 /api/llm/models → 撤销后
 * 401；明文只出现在创建响应里，库中只有 sha256 哈希。会话与会话令牌互不
 * 越权：另一用户不能撤销别人的令牌；令牌不适用于 /v1 会话树。
 */

const PASSWORD = 'correct-horse-battery'
const TEXT_MODEL = { id: 'company-default', provider: 'openai' as const, model: 'gpt-test', enabled: true }

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

describe('user API tokens', () => {
  let testApp: TestApp
  let user: RegisteredUser

  beforeEach(async () => {
    testApp = await createTestApp({
      OPENAI_API_KEY: 'test-key',
      LLM_MODEL_CATALOG: JSON.stringify([TEXT_MODEL]),
    })
    await truncateAll(testApp.database)
    await flushRateLimits(testApp.redis)
    user = await registerUser(testApp.app, testApp.database, uniqueEmail(), PASSWORD)
  })

  afterAll(async () => {
    await testApp.close()
  })

  async function createToken(name = 'cli-token'): Promise<{ id: string; plaintext: string }> {
    const response = await jsonRequest(testApp.app, 'POST', '/api/account/tokens', { name }, { cookie: user.cookie })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { data: { token: { id: string }; plaintext: string } }
    return { id: body.data.token.id, plaintext: body.data.plaintext }
  }

  it('issues a bat_ token whose plaintext never lands in the database', async () => {
    const { plaintext } = await createToken()
    expect(plaintext.startsWith('bat_')).toBe(true)
    expect(plaintext.length).toBeGreaterThan('bat_'.length + 20)

    const rows = await testApp.database.db.select().from(apiTokens).where(eq(apiTokens.userId, user.userId))
    expect(rows).toHaveLength(1)
    const stored = JSON.stringify(rows)
    expect(stored).not.toContain(plaintext)
    expect(rows[0]!.hash).toBe(createHash('sha256').update(plaintext).digest('hex'))
    expect(rows[0]!.name).toBe('cli-token')
  })

  it('lists tokens without the secret or hash', async () => {
    const { plaintext } = await createToken('named-one')
    const list = await jsonRequest(testApp.app, 'GET', '/api/account/tokens', undefined, { cookie: user.cookie })
    expect(list.status).toBe(200)
    const body = (await list.json()) as { data: { tokens: Array<Record<string, unknown>> } }
    expect(body.data.tokens).toHaveLength(1)
    expect(body.data.tokens[0]!.name).toBe('named-one')
    const serialized = JSON.stringify(body)
    expect(serialized).not.toContain(plaintext)
    expect(serialized).not.toContain('hash')
  })

  it('authenticates /api/llm/models with the bearer token, no cookie needed', async () => {
    const { plaintext } = await createToken()
    const models = await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, bearer(plaintext))
    expect(models.status).toBe(200)
    expect(((await models.json()) as { models: Array<{ id: string }> }).models.map((model) => model.id)).toContain(
      'company-default',
    )

    // Usage stamp lands once (throttled afterwards).
    const rows = await testApp.database.db.select().from(apiTokens).where(eq(apiTokens.userId, user.userId))
    expect(rows[0]!.lastUsedAt).not.toBeNull()
  })

  it('answers 401 after revocation and for unknown tokens', async () => {
    const { id, plaintext } = await createToken()
    const revoke = await jsonRequest(testApp.app, 'POST', `/api/account/tokens/${id}/revoke`, {}, { cookie: user.cookie })
    expect(revoke.status).toBe(200)
    expect(((await revoke.json()) as { data: { token: { revokedAt: string } } }).data.token.revokedAt).toBeTruthy()

    expect((await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, bearer(plaintext))).status).toBe(401)
    expect((await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, bearer('bat_forged'))).status).toBe(401)
  })

  it('passes unknown bearer shapes through to the session flow untouched', async () => {
    // A non-bat_ Authorization header is none of this middleware's business:
    // it must not turn an anonymous request into a stricter 401 than the
    // session check would (and vice versa the valid-cookie case still works).
    expect(
      (await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { authorization: 'Bearer something-else' }))
        .status,
    ).toBe(401)
    expect((await jsonRequest(testApp.app, 'GET', '/api/llm/models', undefined, { cookie: user.cookie })).status).toBe(
      200,
    )
  })

  it('scopes tokens to the API trees: /v1 stays session-only', async () => {
    const { plaintext } = await createToken()
    expect((await jsonRequest(testApp.app, 'GET', '/v1/users/me', undefined, bearer(plaintext))).status).toBe(401)
  })

  it('bearer principals skip the browser-only origin gate on the stream route', async () => {
    const { plaintext } = await createToken()
    // No Origin header: a cookie session would be 403 forbidden here; the
    // bearer request proceeds to model resolution and fails with 404 instead.
    const stream = await testApp.app.request('/api/llm/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearer(plaintext) },
      body: JSON.stringify({ model: 'no-such-model', messages: [{ role: 'user', content: 'hi' }] }),
    })
    expect(stream.status).toBe(404)
    expect(((await stream.json()) as { error: { code: string } }).error.code).toBe('model_not_found')
  })

  it('requires a session to manage tokens; foreign tokens are not revocable', async () => {
    expect((await jsonRequest(testApp.app, 'POST', '/api/account/tokens', { name: 'x' })).status).toBe(401)
    expect((await jsonRequest(testApp.app, 'GET', '/api/account/tokens')).status).toBe(401)

    const { id } = await createToken()
    const stranger = await registerUser(testApp.app, testApp.database, uniqueEmail(), PASSWORD)
    const revoke = await jsonRequest(
      testApp.app,
      'POST',
      `/api/account/tokens/${id}/revoke`,
      {},
      { cookie: stranger.cookie },
    )
    expect(revoke.status).toBe(404)
    // Untouched: the owner's token still authenticates.
    const rows = await testApp.database.db.select().from(apiTokens).where(eq(apiTokens.id, id))
    expect(rows[0]!.revokedAt).toBeNull()
  })

  it('caps the number of active tokens per account', async () => {
    for (let index = 0; index < 20; index += 1) {
      await createToken(`t-${index}`)
    }
    const overflow = await jsonRequest(testApp.app, 'POST', '/api/account/tokens', { name: 'one-too-many' }, { cookie: user.cookie })
    expect(overflow.status).toBe(409)
  })
})
