/**
 * /api/v1 共享令牌（AI_DRAMA_API_TOKEN）的浏览器侧存取。
 *
 * 桌面壳与本地 dev（127.0.0.1）无需令牌；容器/公网部署在后端配置令牌后，
 * 首次访问会收到 401 → ApiTokenGate 弹窗输入一次，存 localStorage，
 * client.ts 统一带 `Authorization: Bearer` 头（唯一拦截点）。
 */

const TOKEN_KEY = 'vf:api-token'

export function getApiToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}

export function setApiToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    /* 隐私模式等存储不可用时无解，请求会继续 401 */
  }
}

/** 请求统一装配的鉴权头；未存令牌时返回空对象（本地回环部署零配置可用） */
export function authHeaders(): Record<string, string> {
  const token = getApiToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 401 广播：ApiTokenGate 监听该事件弹令牌输入框 */
export function notifyUnauthorized(): void {
  window.dispatchEvent(new CustomEvent('vf:api-unauthorized'))
}
