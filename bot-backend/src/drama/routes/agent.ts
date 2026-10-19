/**
 * Agent 聊天路由 — 非流式版本
 */
import { Hono } from 'hono'
import { getAgent, validAgentTypes } from '../agents/index.js'
import { success, badRequest } from '../utils/response.js'
import { logTaskError, logTaskPayload, logTaskStart, logTaskSuccess } from '../utils/task-logger.js'

const app = new Hono()

// POST /agent/:type/chat — 非流式 Agent 对话
// 工具循环在 hermes gateway 侧执行，工具轨迹不回流；toolCalls/toolResults 恒为空
// 数组（保持响应形状，前端与任务日志消费方不变）
app.post('/:type/chat', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) {
    return badRequest(c, `无效的 Agent 类型：${agentType}`)
  }

  const body = await c.req.json()
  const { message, drama_id, episode_id } = body

  logTaskStart('Agent', agentType, {
    dramaId: drama_id,
    episodeId: episode_id,
    message,
  })
  logTaskPayload('Agent', `${agentType} input`, body)

  if (!episode_id || !drama_id) {
    logTaskError('Agent', agentType, { reason: 'missing drama_id or episode_id' })
    return badRequest(c, '需要 drama_id 与 episode_id')
  }

  const agent = await getAgent(agentType, {
    episodeId: episode_id,
    dramaId: drama_id,
    modelOverride: body.model || undefined,
    textConfigId: body.config_id || undefined,
  })
  if (!agent) {
    logTaskError('Agent', agentType, { reason: 'agent not found' })
    return badRequest(c, 'Agent 不存在')
  }

  const startTime = performance.now()

  try {
    const result = await agent.generate({
      messages: [{ role: 'user', content: message }],
    })

    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskSuccess('Agent', agentType, { elapsedSeconds: elapsed })

    return success(c, {
      type: 'done',
      text: result.text || '',
      toolCalls: result.toolCalls,
      toolResults: result.toolResults,
    })
  } catch (err: any) {
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1)
    logTaskError('Agent', agentType, { elapsedSeconds: elapsed, error: err.message })
    console.error(err.stack || err)
    return badRequest(c, err.message || 'Agent 执行失败')
  }
})

// GET /agent/:type/debug
app.get('/:type/debug', async (c) => {
  const agentType = c.req.param('type')
  if (!validAgentTypes.includes(agentType)) return badRequest(c, '无效的 Agent 类型')
  return success(c, { agent_type: agentType, valid: true })
})

export default app
