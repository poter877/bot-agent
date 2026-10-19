/**
 * 公司后端（bot-backend）连接参数 — 所有模型调用的唯一出口。
 *
 * 厂商密钥只存在于公司后端服务端；本侧只持内部服务令牌，经配置行
 * （ai_service_configs）下发。独立成叶模块：ai-registry 与 production-tools
 * 都要读，避免经 ai-registry 形成循环导入（providers.ts 在其初始化路径上）。
 *
 * env 一律惰性读取：providers 链在 index.ts 的 `import 'dotenv/config'`
 * 之前求值（ESM 按导入序执行），模块级常量会读到 dotenv 之前的空值。
 */
export const companyBackendUrl = () => (process.env.COMPANY_BACKEND_URL || '').trim().replace(/\/+$/, '')
export const companyServiceToken = () => process.env.COMPANY_SERVICE_TOKEN || ''

/** 文本走原生 /api/llm/stream（AI SDK Core 事件流，language model provider 拼 /stream），媒体走根路径。 */
export function companyBaseUrl(type: string) {
  return type === 'text' ? `${companyBackendUrl()}/api/llm` : companyBackendUrl()
}

export const companyConfigured = () => !!companyBackendUrl() && !!companyServiceToken()
