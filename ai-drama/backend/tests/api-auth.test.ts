/**
 * /api/v1 共享令牌鉴权契约测试 — Hono app.request 直驱中间件：
 * - 未配置 AI_DRAMA_API_TOKEN：回环来源放行、非回环与不可判定来源 401（fail-closed）
 * - 配置 AI_DRAMA_API_TOKEN：Bearer 匹配放行（不限来源），缺失/错误 401（回环也不豁免）
 * - /api/v1/health 永远豁免（部署巡检探活）
 * - 常量时间比较路径由「错误令牌长度不影响 401」间接覆盖
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { apiAuth } from '../src/middleware/api-auth.js'

function buildApp() {
  const app = new Hono()
  app.use('/api/v1/*', apiAuth)
  app.get('/api/v1/health', (c) => c.json({ status: 'ok' }))
  app.get('/api/v1/dramas', (c) => c.json({ code: 0, data: [] }))
  return app
}

/** app.request 的 env 透传成 c.env；getConnInfo 读 env.incoming.socket.remoteAddress */
const envFrom = (remoteAddress?: string) =>
  remoteAddress === undefined ? {} : ({ incoming: { socket: { remoteAddress } } } as never)

test('未配置令牌：回环来源放行（本地 dev / 桌面壳零配置）', async () => {
  const saved = process.env.AI_DRAMA_API_TOKEN
  delete process.env.AI_DRAMA_API_TOKEN
  const app = buildApp()
  try {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const res = await app.request('/api/v1/dramas', undefined, envFrom(addr))
      assert.equal(res.status, 200, addr)
    }
  } finally {
    if (saved !== undefined) process.env.AI_DRAMA_API_TOKEN = saved
  }
})

test('未配置令牌：非回环来源 401，提示配置 AI_DRAMA_API_TOKEN', async () => {
  const saved = process.env.AI_DRAMA_API_TOKEN
  delete process.env.AI_DRAMA_API_TOKEN
  const app = buildApp()
  try {
    // 容器端口映射下外部请求的 remote addr 是网桥地址，永远不是回环
    const res = await app.request('/api/v1/dramas', undefined, envFrom('172.17.0.1'))
    assert.equal(res.status, 401)
    const body = await res.json()
    assert.match(body.message, /AI_DRAMA_API_TOKEN/)
  } finally {
    if (saved !== undefined) process.env.AI_DRAMA_API_TOKEN = saved
  }
})

test('未配置令牌：来源不可判定（无真实 socket）按 fail-closed 拒绝', async () => {
  const saved = process.env.AI_DRAMA_API_TOKEN
  delete process.env.AI_DRAMA_API_TOKEN
  const app = buildApp()
  try {
    const res = await app.request('/api/v1/dramas')
    assert.equal(res.status, 401)
  } finally {
    if (saved !== undefined) process.env.AI_DRAMA_API_TOKEN = saved
  }
})

test('配置令牌：Bearer 匹配放行（不限来源），缺失或错误 401（回环也不豁免）', async () => {
  const saved = process.env.AI_DRAMA_API_TOKEN
  process.env.AI_DRAMA_API_TOKEN = 'shared-secret'
  const app = buildApp()
  try {
    const ok = await app.request(
      '/api/v1/dramas',
      { headers: { Authorization: 'Bearer shared-secret' } },
      envFrom('203.0.113.9'),
    )
    assert.equal(ok.status, 200)

    const missing = await app.request('/api/v1/dramas', undefined, envFrom('127.0.0.1'))
    assert.equal(missing.status, 401)

    // 错误令牌长度不同也 401（哈希抹平长度差，不因长度差异提前泄露）
    const wrong = await app.request(
      '/api/v1/dramas',
      { headers: { Authorization: 'Bearer a-much-longer-wrong-token' } },
      envFrom('127.0.0.1'),
    )
    assert.equal(wrong.status, 401)

    // 空白令牌视为未配置（trim），不能把「配了空值」变成无鉴权放行
    process.env.AI_DRAMA_API_TOKEN = '   '
    const blank = await app.request('/api/v1/dramas', undefined, envFrom('10.0.0.2'))
    assert.equal(blank.status, 401)
  } finally {
    if (saved === undefined) delete process.env.AI_DRAMA_API_TOKEN
    else process.env.AI_DRAMA_API_TOKEN = saved
  }
})

test('/api/v1/health 永远豁免：无令牌 + 非回环来源也放行', async () => {
  const saved = process.env.AI_DRAMA_API_TOKEN
  process.env.AI_DRAMA_API_TOKEN = 'shared-secret'
  const app = buildApp()
  try {
    const res = await app.request('/api/v1/health', undefined, envFrom('203.0.113.9'))
    assert.equal(res.status, 200)
    assert.deepEqual((await res.json()).status, 'ok')
  } finally {
    if (saved === undefined) delete process.env.AI_DRAMA_API_TOKEN
    else process.env.AI_DRAMA_API_TOKEN = saved
  }
})
