/**
 * 读取 snake_case / camelCase 双形态 DTO 字段（后端绝大多数接口 snake_case，
 * tasks/scenes-create/storage/server-update 直接返回 camelCase；兼容集中在边界）。
 */
export function field<T>(obj: Record<string, unknown>, snakeKey: string): T | undefined {
  if (obj[snakeKey] !== undefined) return obj[snakeKey] as T
  const camel = snakeKey.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  return obj[camel] as T | undefined
}

export function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>
}

export function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : []
}

/** 后端 tags/scenes 等字段为 JSON 字符串，解析失败回退空数组 */
export function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value) {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
      return []
    }
  }
  return []
}
