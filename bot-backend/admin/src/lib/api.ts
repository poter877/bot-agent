/** 运营管理台 API 客户端 — 同源 fetch（dev 经 vite 代理）。 */

const BASE = '/admin/api'

export class ApiError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
}

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init
  const res = await fetch(`${BASE}${path}`, {
    ...rest,
    credentials: 'include',
    headers: {
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
      ...rest.headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  })
  const payload = (await res.json().catch(() => null)) as { code?: number; data?: T; message?: string } | null
  if (!res.ok || !payload || payload.code !== 200) {
    throw new ApiError(res.status, payload?.message ?? `请求失败（${res.status}）`)
  }
  return payload.data as T
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, json?: unknown) => request<T>(path, { method: 'POST', json }),
  put: <T>(path: string, json?: unknown) => request<T>(path, { method: 'PUT', json }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
}

/** better-auth 原生端点（/api/auth/*，绕过 /admin/api 信封）。 */
export async function authSignIn(email: string, password: string): Promise<void> {
  const res = await fetch('/api/auth/sign-in/email', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null
    throw new ApiError(res.status, body?.message ?? '登录失败')
  }
}

export interface BootstrapInfo {
  initialized: boolean
}

export interface UserRow {
  id: string
  email: string
  name: string
  role: string
  banned: boolean
  banReason: string | null
  createdAt: string
}

export interface LlmModelRow {
  id: string
  provider: string
  model: string
  baseUrl: string | null
  enabled: boolean
  displayName: string | null
  isDefault: boolean
  contextLength: number | null
  maxOutputTokens: number | null
  note: string | null
}

export interface MediaModelRow {
  id: string
  kind: string
  provider: string
  model: string
  enabled: boolean
  displayName: string | null
  maxImages: number | null
  note: string | null
}

export interface RegistryModelMeta {
  name: string
  reasoning: boolean
  tool_call: boolean
  modalities: { input: string[]; output: string[] }
}

export interface RegistryProvider {
  id: string
  name: string
  api?: string
  npm: string
  env: string[]
  models: Record<string, RegistryModelMeta>
}

export interface CredentialHint {
  provider: string
  baseUrl: string
  hint: string
}

export interface RequestRow {
  id: number
  userId: string | null
  email: string | null
  route: string
  modelId: string | null
  status: string
  errorCode: string | null
  inputTokens: number | null
  outputTokens: number | null
  latencyMs: number | null
  createdAt: string
}

export interface StatusStats {
  dbOk: boolean
  redisOk: boolean
  uptimeSeconds: number
  activeStreams: number | null
  totalUsers: number
  bannedUsers: number
  adminUsers: number
  modelsEnabled: number
  modelsTotal: number
  dayComplete: number
  dayFailed: number
  dayRejected: number
}

export interface UserQuota {
  dailyTokenLimit: number | null
  concurrencyLimit: number | null
  modelAllowlist: string | null
}

export interface UserDetail {
  user: UserRow
  quota: UserQuota | null
  todayTokens: number
  requests: RequestRow[]
}

export const adminApi = {
  bootstrap: () => api.get<BootstrapInfo>('/bootstrap'),
  setup: (input: { email: string; password: string; confirm: string; name?: string }) =>
    api.post<{ userId: string }>('/setup', input),
  users: (q = '') => api.get<UserRow[]>(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
  userDetail: (id: string) => api.get<UserDetail>(`/users/${id}`),
  setUserRole: (id: string, role: 'admin' | 'user') => api.post<{ role: string }>(`/users/${id}/role`, { role }),
  banUser: (id: string, reason?: string) => api.post<void>(`/users/${id}/ban`, { reason }),
  unbanUser: (id: string) => api.post<void>(`/users/${id}/unban`),
  saveQuota: (
    id: string,
    input: { dailyTokenLimit: string; concurrencyLimit: string; modelAllowlist: string },
  ) =>
    api.put<void>(`/users/${id}/quota`, {
      dailyTokenLimit: input.dailyTokenLimit,
      concurrencyLimit: input.concurrencyLimit,
      modelAllowlist: input.modelAllowlist
        ? input.modelAllowlist.split(/[,，\n]/).map((s) => s.trim()).filter(Boolean)
        : [],
    }),
  models: () => api.get<LlmModelRow[]>('/models'),
  saveModel: (input: Record<string, unknown>) => api.post<void>('/models', input),
  toggleModel: (id: string) => api.post<void>(`/models/${encodeURIComponent(id)}/toggle`),
  deleteModel: (id: string) => api.delete<void>(`/models/${encodeURIComponent(id)}`),
  mediaModels: () => api.get<MediaModelRow[]>('/media-models'),
  saveMediaModel: (input: Record<string, unknown>) => api.post<void>('/media-models', input),
  requests: (status = '') => api.get<RequestRow[]>(`/requests${status ? `?status=${status}` : ''}`),
  status: () => api.get<StatusStats>('/status'),
  registry: () => api.get<RegistryProvider[]>('/registry'),
  credentials: () => api.get<CredentialHint[]>('/credentials'),
  saveCredential: (input: { provider: string; baseUrl?: string; apiKey: string }) =>
    api.post<{ provider: string; baseUrl: string }>('/credentials', input),
}
