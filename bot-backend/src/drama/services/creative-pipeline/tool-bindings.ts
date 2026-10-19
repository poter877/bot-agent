import { PipelineInputRequired } from './contracts.js'
import type { PipelineToolExecution, PipelineToolReference } from './tool-contracts.js'

const blocked = new Set(['__proto__', 'prototype', 'constructor'])
/** Read only explicit own data properties. Bindings never execute an expression or a tool response. */
export function toolDataPath(value: unknown, dataPath: string): unknown {
  const parts = dataPath
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  if (parts.length > 20 || parts.some((part) => blocked.has(part)))
    throw new PipelineInputRequired('工具产物引用路径无效')
  let current = value
  for (const part of parts) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}
export function isToolReference(value: unknown): value is PipelineToolReference {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as PipelineToolReference).$step === 'string'
  )
}
export function resolveToolBindings<T>(value: T, steps: readonly PipelineToolExecution[]): T {
  const lookup = new Map(steps.map((step) => [step.key, step]))
  const resolve = (input: unknown, depth: number): unknown => {
    if (depth > 30) throw new PipelineInputRequired('工具输入引用嵌套过深')
    if (isToolReference(input)) {
      const step = lookup.get(input.$step)
      if (!step || step.status !== 'completed')
        throw new PipelineInputRequired(`工具前序产物尚未就绪：${input.$step}`)
      if (input.dataPath !== undefined) {
        if (typeof input.dataPath !== 'string') throw new PipelineInputRequired('工具产物引用路径无效')
        const data = toolDataPath(step.data, input.dataPath)
        if (data === undefined)
          throw new PipelineInputRequired(`工具产物缺少字段：${input.$step}.${input.dataPath}`)
        return structuredClone(data)
      }
      const files = (step.files ?? []).filter((file) => !input.kind || file.kind === input.kind)
      const index = input.index ?? 0
      if (!Number.isInteger(index) || index < 0 || !files[index])
        throw new PipelineInputRequired(
          `工具前序产物没有所需文件：${input.$step}${input.kind ? `（${input.kind}）` : ''}`,
        )
      return files[index].url
    }
    if (Array.isArray(input)) return input.map((item) => resolve(item, depth + 1))
    if (input && typeof input === 'object') {
      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input)) {
        if (blocked.has(key)) throw new PipelineInputRequired('工具输入含有无效字段')
        output[key] = resolve(item, depth + 1)
      }
      return output
    }
    return input
  }
  return resolve(value, 0) as T
}

/** Match the native importer's canonical timed transcript without invoking another tool. */
export function subtitleWritebackText(content: string, extension: string): string {
  if (extension === '.json') {
    const value: unknown = JSON.parse(content)
    if (!Array.isArray(value) || value.length > 2000) throw new PipelineInputRequired('字幕 JSON 格式无效')
    const stamp = (seconds: unknown) => {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0 || seconds > 3600)
        throw new PipelineInputRequired('字幕 JSON 时码无效')
      const ms = Math.round(seconds * 1000)
      return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`
    }
    return value
      .map((cue, index) => {
        if (!cue || typeof cue !== 'object' || typeof cue.text !== 'string')
          throw new PipelineInputRequired('字幕 JSON 内容无效')
        return `${index + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text.replace(/\r\n?/g, '\n').replace(/\n\s*\n+/g, '\n')}`
      })
      .join('\n\n')
  }
  if (extension !== '.vtt') return content
  return content
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .replace(/^WEBVTT[^\n]*\n/, '')
    .trim()
    .split(/\n\s*\n/)
    .flatMap((block) => {
      const lines = block.split('\n'),
        line = lines.findIndex((value) => value.includes('-->'))
      if (line < 0) return []
      const match = lines[line].match(
        /((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d{2,}:)?\d{2}:\d{2}\.\d{3})/,
      )
      if (!match) throw new PipelineInputRequired('VTT 字幕时码无效')
      const stamp = (value: string) => (value.split(':').length === 2 ? '00:' : '') + value.replace('.', ',')
      return [`${stamp(match[1])} --> ${stamp(match[2])}\n${lines.slice(line + 1).join('\n')}`]
    })
    .map((block, index) => `${index + 1}\n${block}`)
    .join('\n\n')
}
