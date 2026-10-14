import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config/env.js'

describe('configuration is validated at startup', () => {
  const base = {
    NODE_ENV: 'test' as const,
    DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/x',
    REDIS_URL: 'redis://127.0.0.1:6379',
    BETTER_AUTH_URL: 'http://127.0.0.1:3100',
  }

  it('refuses to boot without a real Better Auth secret', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'short' })).toThrow(/BETTER_AUTH_SECRET/)
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: undefined })).toThrow(/BETTER_AUTH_SECRET/)
  })

  it('refuses to boot without the authoritative stores and auth URL', () => {
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32), DATABASE_URL: undefined })).toThrow(/DATABASE_URL/)
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32), REDIS_URL: undefined })).toThrow(/REDIS_URL/)
    expect(() => loadConfig({ ...base, BETTER_AUTH_SECRET: 'x'.repeat(32), BETTER_AUTH_URL: undefined })).toThrow(/BETTER_AUTH_URL/)
  })
})
