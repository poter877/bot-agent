import { HttpApiError } from '../../shared/http.js'
import type { CloudAction, CloudImage, CloudWorker, WorkerComputer } from './protocol.js'

const unavailable = () => new HttpApiError(503, 'dependency_unavailable', 'The cloud computer service is temporarily unavailable.')
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw unavailable()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      length += part.value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw unavailable()
      chunks.push(part.value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Redirects are forbidden: the worker credential has exactly one recipient. */
export class HttpCloudWorker implements CloudWorker {
  constructor(private readonly baseUrl: string, private readonly token: string) {}

  private async request(owner: string, id: string, suffix: string, body?: unknown): Promise<unknown> {
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, '')}/v1/computers/${encodeURIComponent(id)}${suffix}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${this.token}`, 'x-cloud-owner': owner, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(suffix === '/start' || suffix === '/stop' ? 35_000 : 8_000),
      })
      if (!response.ok) {
        await response.body?.cancel()
        if (response.status === 409) throw new HttpApiError(409, 'conflict', 'The cloud computer is not ready for this operation.')
        if (response.status === 429) throw new HttpApiError(429, 'concurrency_limit', 'Cloud computer capacity is currently full.')
        throw unavailable()
      }
      return await readJson(response)
    } catch (error) {
      if (error instanceof HttpApiError) throw error
      throw unavailable()
    }
  }

  private async computer(owner: string, id: string, suffix = '', body?: unknown): Promise<WorkerComputer> {
    const result = await this.request(owner, id, suffix, body) as Partial<WorkerComputer> | null
    if (!result || result.id !== id || !['missing', 'stopped', 'running'].includes(result.state ?? '') ||
      !Number.isInteger(result.width) || !Number.isInteger(result.height) ||
      result.width! < 1 || result.width! > 8192 || result.height! < 1 || result.height! > 8192) throw unavailable()
    return result as WorkerComputer
  }

  status(owner: string, id: string) { return this.computer(owner, id) }
  start(owner: string, id: string) { return this.computer(owner, id, '/start', {}) }
  stop(owner: string, id: string) { return this.computer(owner, id, '/stop', {}) }

  async capture(owner: string, id: string): Promise<{ image: CloudImage }> {
    const result = await this.request(owner, id, '/capture', {}) as { image?: CloudImage } | null
    const image = result?.image
    if (!image || image.mediaType !== 'image/png' || typeof image.data !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) || !Number.isInteger(image.width) || !Number.isInteger(image.height) ||
      image.width < 1 || image.width > 8192 || image.height < 1 || image.height > 8192) throw unavailable()
    const bytes = Buffer.from(image.data, 'base64')
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw unavailable()
    return { image }
  }

  async action(owner: string, id: string, action: CloudAction): Promise<{ ok: true }> {
    const result = await this.request(owner, id, '/actions', action) as { ok?: boolean } | null
    if (result?.ok !== true) throw unavailable()
    return { ok: true }
  }
}
