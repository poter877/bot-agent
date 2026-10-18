import type { PipelineAutomation } from './pipeline'

export function parsePipelineAutomation(raw?: string): { value: PipelineAutomation; error: string | null } {
  if (!raw?.trim()) return { value: {}, error: null }
  try {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('制作设置需要填写对象')
    const parsed = value as PipelineAutomation
    if (
      parsed.visual &&
      !['auto', 'generated', 'diagram', 'math', 'character', 'threejs', 'blender', 'source'].includes(
        parsed.visual,
      )
    )
      throw new Error('请选择有效的画面制作方式')
    if (parsed.analysis && !['auto', 'off', 'vision'].includes(parsed.analysis))
      throw new Error('请选择有效的素材分析方式')
    for (const key of [
      'stockTool',
      'researchTool',
      'musicTool',
      'speechTool',
      'transcriptionTool',
      'avatarTool',
      'imageTool',
      'videoTool',
      'modelTool',
    ] as const) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'string')
        throw new Error('制作工具选择需要填写工具名称')
    }
    if (
      parsed.postTools &&
      (!Array.isArray(parsed.postTools) || parsed.postTools.some((item) => typeof item !== 'string'))
    )
      throw new Error('后期处理需要填写工具名称列表')
    if (parsed.capture !== undefined && typeof parsed.capture !== 'boolean')
      throw new Error('录屏设置需要填写 true 或 false')
    if (
      parsed.toolParameters !== undefined &&
      (!parsed.toolParameters ||
        typeof parsed.toolParameters !== 'object' ||
        Array.isArray(parsed.toolParameters) ||
        Object.values(parsed.toolParameters).some(
          (item) => !item || typeof item !== 'object' || Array.isArray(item),
        ))
    )
      throw new Error('工具参数需要按工具名称填写参数对象')
    return { value: parsed, error: null }
  } catch (error) {
    return {
      value: {},
      error:
        error instanceof SyntaxError
          ? '高级制作设置的 JSON 格式不正确，请修正后保存。'
          : (error as Error).message,
    }
  }
}
