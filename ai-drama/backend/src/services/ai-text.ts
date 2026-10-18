/** Text model construction shared by drama agents, creative planning, chat and translation. */
import { createOpenAI } from '@ai-sdk/openai'
import { getTextConfig, getConfigById } from './ai.js'
import { logTaskProgress } from '../utils/task-logger.js'

// Agent 每一步都会重新解析模型，相同端点只打一次日志避免刷屏
let lastLoggedTextEndpointKey = ''

/**
 * 关闭思考(thinking)模式
 *
 * 背景：new-api 类中转站对 thinking 模型强制要求多轮请求回传 reasoning_content,
 * 而 Agent 多轮工具调用无法回传,会被中转站 400 拒绝
 * ("The `reasoning_content` in the thinking mode must be passed back to the API")。
 * 这里在请求体注入各厂商风格的关思考参数,让模型不产出 reasoning_content。
 *
 * - 默认开启;AI_DISABLE_THINKING=false 可关闭注入
 * - AI_THINKING_OFF_PATCH 可传 JSON 覆盖注入的 OpenAI 风格参数(适配不同中转站)
 *
 * 公司后端 /api/llm 是 OpenAI 兼容路由，接受这些字段，补丁始终叠加。
 */
const thinkingOffEnabled = (process.env.AI_DISABLE_THINKING ?? 'true').toLowerCase() !== 'false'

function openaiThinkingOffPatch(): Record<string, any> {
  const fallback = {
    thinking: { type: 'disabled' },   // new-api 通用 / DeepSeek
    enable_thinking: false,           // Qwen / 阿里系
    reasoning_effort: 'none',         // OpenAI 风格枚举(Gemini 渠道映射为 budget 0)
  }
  const raw = process.env.AI_THINKING_OFF_PATCH
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function createThinkingOffFetch(): typeof fetch | undefined {
  if (!thinkingOffEnabled) return undefined
  const openaiPatch = openaiThinkingOffPatch()

  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (Array.isArray(body?.messages)) {
          Object.assign(body, openaiPatch)
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return fetch(input, init)
  }
}

/**
 * 在请求体中写入配置的温度
 *
 * 背景：部分模型服务端强制固定温度（如 kimi-k2 系只允许 0.6，
 * 报 "invalid temperature: only 0.6 is allowed for this model"），
 * 需要在文本服务配置里显式指定并随每个请求下发。
 * inner 传 thinking-off fetch 时可链式叠加两个补丁。
 */
function createTemperatureFetch(temperature: number, inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (Array.isArray(body?.messages)) {
          body.temperature = temperature
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return base(input, init)
  }
}

/**
 * 在请求体中注入输出上限
 *
 * 背景：Agent 输出可能包含大段规划文本 + 工具调用（尤其分批保存时），
 * 而服务商默认 max_tokens 很小（如 DeepSeek 默认 4096/8192），
 * 模型写作到一半被截断、工具调用从未生成，表现为「Agent 正常结束但什么都没保存」。
 * 这里显式抬高输出上限，给足模型完整生成工具调用的空间。
 * AI_MAX_TOKENS 可覆盖默认值（如某些中转站限制更严）。
 */
const defaultMaxTokens = Number(process.env.AI_MAX_TOKENS || 16384)

function createMaxTokensFetch(inner?: typeof fetch): typeof fetch {
  const base = inner || fetch
  return async (input: any, init?: any) => {
    try {
      if (init?.body && typeof init.body === 'string') {
        const body = JSON.parse(init.body)
        if (Array.isArray(body?.messages)) {
          body.max_tokens = defaultMaxTokens
          init = { ...init, body: JSON.stringify(body) }
        }
      }
    } catch { /* 解析失败则原样透传 */ }
    return base(input, init)
  }
}

export async function getTextModel(options: { fallbackModel?: string; model?: string; configId?: number } = {}) {
  const { fallbackModel: fileModel, model: modelOverride, configId: textConfigId } = options
  // 请求可指定文本配置（含其 provider/baseUrl/apiKey），否则回退到当前启用配置
  const textConfig = (textConfigId ? await getConfigById(textConfigId, 'text') : null) || await getTextConfig()
  const modelName = modelOverride || fileModel || textConfig.model
  if (!modelName) throw new Error('文本配置尚未选择模型，请先在模型与服务中选择模型')
  const temperature = textConfig.temperature ?? null
  const endpointKey = `${textConfig.provider}|${textConfig.baseUrl}|${modelName}|t=${temperature ?? 'default'}`
  if (endpointKey !== lastLoggedTextEndpointKey) {
    lastLoggedTextEndpointKey = endpointKey
    logTaskProgress('AIConfig', 'text-model-endpoint', {
      provider: textConfig.provider,
      baseUrl: textConfig.baseUrl,
      model: modelName,
      ...(temperature !== null ? { temperature } : {}),
    })
  }

  // 叠加请求补丁：thinking-off + 配置温度 + 输出上限（公司后端兼容路由都接受）
  const thinkingOffFetch = createThinkingOffFetch()
  const tempFetch = temperature !== null
    ? createTemperatureFetch(temperature, thinkingOffFetch)
    : thinkingOffFetch
  const fetchImpl = createMaxTokensFetch(tempFetch)

  // provider 收敛后只剩公司后端：baseUrl 即最终 OpenAI 兼容地址（.../api/llm），
  // createOpenAI 自动拼 /chat/completions
  const provider = createOpenAI({
    baseURL: textConfig.baseUrl,
    apiKey: textConfig.apiKey,
    fetch: fetchImpl,
  } as any)
  return provider.chat(modelName)
}
