import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { CreativeError } from '../creative-model.js'
export class ProviderRejected extends CreativeError {}
export function isPublicIPv4(address: string) {
  const n = address.split('.').map(Number)
  if (n.length !== 4 || n.some((v) => !Number.isInteger(v) || v < 0 || v > 255)) return false
  const [a, b] = n
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19))
  )
}
export function checkRemoteUrl(value: string, domains: readonly string[]) {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !domains.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`))
  )
    throw new CreativeError('远程素材地址不属于该服务的受信任域名', 422)
  return url
}
/** DNS is resolved once and pinned to the socket; redirects repeat both checks. */
export async function remoteBytes(
  value: string,
  domains: readonly string[],
  limit: number,
  options: { method?: 'GET' | 'PUT'; body?: Buffer; contentType?: string } = {},
  redirects = 0,
): Promise<Buffer> {
  const url = checkRemoteUrl(value, domains)
  const addresses = await lookup(url.hostname, { family: 4, all: true })
  if (!addresses.length || addresses.some((a) => !isPublicIPv4(a.address)))
    throw new CreativeError('远程素材不能访问本机或私有网络', 422)
  const result = await new Promise<{ body: Buffer; location?: string }>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: options.method ?? 'GET',
        headers: options.body
          ? {
              'Content-Type': options.contentType ?? 'application/octet-stream',
              'Content-Length': options.body.length,
            }
          : {},
        lookup: ((_host: unknown, opts: unknown, callback: any) => {
          callback(
            null,
            (opts as { all?: boolean }).all
              ? [{ address: addresses[0].address, family: 4 }]
              : addresses[0].address,
            4,
          )
        }) as any,
      },
      (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
          response.resume()
          if (!response.headers.location) {
            reject(new CreativeError('远程素材重定向缺少地址', 422))
            return
          }
          resolve({ body: Buffer.alloc(0), location: response.headers.location })
          return
        }
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          response.resume()
          reject(new CreativeError('远程素材传输失败，请稍后恢复任务', 503))
          return
        }
        if (Number(response.headers['content-length'] ?? 0) > limit) {
          response.destroy()
          reject(new CreativeError('远程素材超过大小限制', 422))
          return
        }
        let size = 0
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > limit) {
            response.destroy(new CreativeError('远程素材超过大小限制', 422))
          } else chunks.push(chunk)
        })
        response.on('error', reject)
        response.on('end', () => resolve({ body: Buffer.concat(chunks) }))
      },
    )
    const timer = setTimeout(
      () => request.destroy(new CreativeError('远程素材传输超时，请恢复任务重试', 503)),
      180000,
    )
    request.on('close', () => clearTimeout(timer))
    request.on('error', () => reject(new CreativeError('远程素材传输失败，请恢复任务重试', 503)))
    request.end(options.body)
  })
  if (result.location) {
    if (redirects >= 3 || options.method === 'PUT') throw new CreativeError('远程素材重定向无效', 422)
    return remoteBytes(new URL(result.location, url).href, domains, limit, options, redirects + 1)
  }
  return result.body
}
export async function providerJson(
  url: string,
  key: string,
  body?: unknown,
  extra: Record<string, string> = {},
) {
  const sync = new URL(url).hostname === 'api.sync.so'
  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(sync
          ? { 'x-api-key': key }
          : { Authorization: new URL(url).hostname === 'api.pexels.com' ? key : `Bearer ${key}` }),
        ...extra,
        'Content-Type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(120000),
      redirect: 'error',
    })
  } catch {
    throw new CreativeError('服务请求超时或连接失败；已提交任务需先恢复查询，避免重复计费', 503)
  }
  if (!response.ok)
    throw new (response.status < 500 ? ProviderRejected : CreativeError)(
      `制作服务返回 ${response.status}，请检查配置、额度和输入`,
      response.status < 500 ? 422 : 503,
    )
  const reader = response.body?.getReader()
  if (!reader) throw new CreativeError('服务响应为空', 422)
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      size += item.value.length
      if (size > 8 * 1024 * 1024) {
        await reader.cancel()
        throw new CreativeError('服务响应过大', 422)
      }
      chunks.push(item.value)
    }
  } finally {
    reader.releaseLock()
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new CreativeError('服务返回了无效的数据', 422)
  }
}
