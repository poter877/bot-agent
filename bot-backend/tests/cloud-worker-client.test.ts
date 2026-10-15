import { createServer, type RequestListener, type Server } from 'node:http'
import { afterEach, expect, it } from 'vitest'
import { HttpCloudWorker } from '../src/modules/cloud-computer/worker-client.js'
import { loadConfig } from '../src/config/env.js'

const servers: Server[] = []
async function listen(handler: RequestListener): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No worker address')
  return `http://127.0.0.1:${address.port}`
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
})

it('sends owner and private worker authority only to the configured worker, preserving the action body', async () => {
  const seen: Array<{ path: string; owner: string | undefined; token: string | undefined; body: unknown }> = []
  const url = await listen(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const text = Buffer.concat(chunks).toString()
    seen.push({ path: req.url!, owner: req.headers['x-cloud-owner'] as string | undefined,
      token: req.headers.authorization, body: text ? JSON.parse(text) : null })
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(req.url?.endsWith('/actions') ? { ok: true } : { id: 'desktop-a', state: 'running', width: 1440, height: 900 }))
  })
  const worker = new HttpCloudWorker(url, 'private-worker-credential')
  await worker.start('company-user-a', 'desktop-a')
  await worker.action('company-user-a', 'desktop-a', { action: 'type', params: { text: '你好 $(never execute)' } })
  expect(seen).toEqual([
    { path: '/v1/computers/desktop-a/start', owner: 'company-user-a', token: 'Bearer private-worker-credential', body: {} },
    { path: '/v1/computers/desktop-a/actions', owner: 'company-user-a', token: 'Bearer private-worker-credential', body: { action: 'type', params: { text: '你好 $(never execute)' } } },
  ])
})

it('refuses redirects without forwarding credentials and rejects a response for another computer', async () => {
  let leaked = false
  const destination = await listen((_req, res) => { leaked = true; res.end('{}') })
  const redirect = await listen((_req, res) => { res.writeHead(302, { location: destination }); res.end() })
  await expect(new HttpCloudWorker(redirect, 'secret').status('owner', 'desktop-a')).rejects.toMatchObject({ status: 503 })
  expect(leaked).toBe(false)
  const wrong = await listen((_req, res) => res.end(JSON.stringify({ id: 'desktop-b', state: 'running', width: 1440, height: 900 })))
  await expect(new HttpCloudWorker(wrong, 'secret').status('owner', 'desktop-a')).rejects.toMatchObject({ status: 503 })
})

it('rejects enabled cloud service without a worker and refuses credential-bearing worker URLs', () => {
  const base = { DATABASE_URL: 'postgres://localhost/test', REDIS_URL: 'redis://localhost', BETTER_AUTH_SECRET: 'test-secret-at-least-32-characters-long', BETTER_AUTH_URL: 'http://localhost:3000' }
  expect(() => loadConfig({ ...base, CLOUD_COMPUTER_ENABLED: 'true' })).toThrow('Cloud computers require')
  expect(() => loadConfig({ ...base, CLOUD_COMPUTER_WORKER_URL: 'http://user:password@localhost:3031' })).toThrow('without credentials')
  expect(loadConfig(base).CLOUD_COMPUTER_ENABLED).toBe(false)
})
