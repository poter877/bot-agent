import { isIPv4 } from 'node:net'
import type { MiddlewareHandler } from 'hono'
import type { AppEnv } from '../shared/context.js'

/**
 * Real client IP resolution. Forwarded headers are only honored when the TCP
 * peer is a configured trusted proxy; anything else is treated as a direct
 * client address. A client-reported X-Forwarded-For can never choose its own
 * rate-limit identity.
 */

interface ParsedConfig {
  trustedIpv4Cidrs: Array<{ network: number; prefix: number }>
  trustedIps: Set<string>
}

export function parseTrustedProxies(list: string[]): ParsedConfig {
  const trustedIpv4Cidrs: ParsedConfig['trustedIpv4Cidrs'] = []
  const trustedIps = new Set<string>()
  for (const entry of list) {
    if (entry.includes('/')) {
      const [networkPart, prefixPart] = entry.split('/')
      const prefix = Number(prefixPart)
      if (networkPart === undefined || !isIPv4(networkPart) || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
        throw new Error(`TRUSTED_PROXIES entry is not a valid IPv4 CIDR: ${entry}`)
      }
      const network = ipv4ToNumber(networkPart)
      trustedIpv4Cidrs.push({ network: maskNetwork(network, prefix), prefix })
    } else {
      trustedIps.add(normalizeIp(entry))
    }
  }
  return { trustedIpv4Cidrs, trustedIps }
}

function normalizeIp(ip: string): string {
  return ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip.toLowerCase()
}

function ipv4ToNumber(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function maskNetwork(network: number, prefix: number): number {
  if (prefix === 0) return 0
  const mask = (0xffffffff << (32 - prefix)) >>> 0
  return (network & mask) >>> 0
}

function isTrustedAddress(address: string, config: ParsedConfig): boolean {
  const normalized = normalizeIp(address)
  if (config.trustedIps.has(normalized)) return true
  if (!isIPv4(normalized)) return false
  const value = ipv4ToNumber(normalized)
  return config.trustedIpv4Cidrs.some(
    (cidr) => maskNetwork(value, cidr.prefix) === cidr.network,
  )
}

/**
 * Walk the X-Forwarded-For chain from rightmost to leftmost and return the
 * first address that was not appended by a trusted proxy. With no trusted
 * proxies configured, the socket address is always used.
 */
export function resolveRealIp(
  socketAddress: string | undefined,
  forwardedFor: string | undefined,
  config: ParsedConfig,
): string {
  const peer = socketAddress ? normalizeIp(socketAddress) : 'unknown'
  if (forwardedFor === undefined || !isTrustedAddress(peer, config)) {
    return peer
  }
  const chain = forwardedFor
    .split(',')
    .map((entry) => normalizeIp(entry.trim()))
    .filter(Boolean)
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const candidate = chain[index]!
    if (!isTrustedAddress(candidate, config)) {
      return candidate
    }
  }
  return peer
}

export function realIpMiddleware(trustedProxies: string[]): MiddlewareHandler<AppEnv> {
  const config = parseTrustedProxies(trustedProxies)
  return async (c, next) => {
    // env is absent on direct fetch-style invocations (tests); that simply
    // means no socket peer, i.e. no trusted proxy chain.
    const env = (c.env ?? {}) as { incoming?: { socket?: { remoteAddress?: string } } }
    const socketAddress = env.incoming?.socket?.remoteAddress
    const forwardedFor = c.req.header('x-forwarded-for')
    c.set('realIp', resolveRealIp(socketAddress, forwardedFor, config))
    await next()
  }
}
