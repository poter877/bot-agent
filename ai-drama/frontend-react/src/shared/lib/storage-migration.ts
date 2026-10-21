/**
 * 存储键一次性迁移——huobao 遗留命名 → vf 命名。
 *
 * 在任何存储读写发生前于入口调用一次。旧键存在且新键不存在时复制并
 * 删除旧键；新旧并存（已迁移过）时不动，用户数据永不丢失。
 */

const MIGRATIONS: Array<[oldKey: string, newKey: string]> = [
  ['huobao:studio-agent-sessions:v1', 'vf:studio-agent-sessions:v1'],
  ['huobao:studio-agent-sessions', 'vf:studio-agent-sessions'],
  ['huobao:prefs:v1', 'vf:prefs:v1'],
  ['huobao:tours', 'vf:tours'],
  ['huobao:api-token', 'vf:api-token'],
  ['huobao:locale', 'vf:locale'],
]

export function migrateLegacyStorage(): void {
  if (typeof window === 'undefined') return
  for (const [oldKey, newKey] of MIGRATIONS) {
    try {
      const legacy = window.localStorage.getItem(oldKey)
      if (legacy === null) continue
      if (window.localStorage.getItem(newKey) === null) {
        window.localStorage.setItem(newKey, legacy)
      }
      window.localStorage.removeItem(oldKey)
    } catch {
      /* 隐私模式等存储不可用场景：跳过迁移，各处自行降级 */
    }
  }
}
