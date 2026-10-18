/** Text model construction shared by drama agents, creative planning, chat and translation. */
import { createCompanyLanguageModel } from './company-llm-model.js'
import { getTextConfig, getConfigById } from './ai.js'
import { logTaskProgress } from '../utils/task-logger.js'

// Agent 每一步都会重新解析模型，相同端点只打一次日志避免刷屏
let lastLoggedTextEndpointKey = ''

/**
 * 输出上限默认值（AI_MAX_TOKENS 可覆盖）。
 *
 * 背景：Agent 输出可能包含大段规划文本 + 工具调用（尤其分批保存时），
 * 而服务商默认 max_tokens 很小（如 DeepSeek 默认 4096/8192），
 * 模型写作到一半被截断、工具调用从未生成，表现为「Agent 正常结束但什么都没保存」。
 * 公司后端 wire 协议里它是 maxOutputTokens 一等字段，随请求下发。
 */
const fixedMaxOutputTokens = Number(process.env.AI_MAX_TOKENS || 16384)

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

  // provider 收敛后只剩公司后端：直连原生 /api/llm/stream（AI SDK Core 事件流），
  // baseUrl 即配置行里的 .../api/llm，provider 内部拼 /stream。
  // 温度与输出上限作为协议一等字段下发（固定值覆盖调用方，语义同旧补丁）；
  // 旧 thinking-off 补丁没有对应物——wire 是 .strict() 校验，注入 thinking 等
  // 未登记字段会被 400，关思考由服务端模型目录侧管理。
  return createCompanyLanguageModel({
    baseUrl: textConfig.baseUrl,
    apiKey: textConfig.apiKey,
    model: modelName,
    temperature,
    ...(Number.isFinite(fixedMaxOutputTokens) ? { maxOutputTokens: fixedMaxOutputTokens } : {}),
  })
}
