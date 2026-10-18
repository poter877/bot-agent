export type ToolFileKind = 'image' | 'video' | 'audio' | 'subtitle' | 'model' | 'archive' | 'data'
export interface ToolOutput {
  summary: string
  files: { path: string; name: string; kind: ToolFileKind }[]
  data?: Record<string, unknown>
}
export interface ToolContext {
  projectId: number
  toolId: string
  args: Record<string, unknown>
  outputDir: string
  signal: AbortSignal
  progress: (value: number) => void
  config?: {
    id?: number
    provider: string
    baseUrl: string
    apiKey: string
    model: string
    serviceOptions?: Record<string, unknown>
  }
  checkpoint: (value: Record<string, unknown>) => void
  state: Record<string, unknown>
}
export interface ToolField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'media' | 'json'
  required?: boolean
  default?: unknown
  options?: { label: string; value: string }[]
  accept?: string
}
export interface ToolDefinition {
  id: string
  name: string
  category: string
  provider: string
  referenceProvider: string
  description: string
  serviceType?: string
  inputs: ToolField[]
  available: boolean
  reason?: string
  implemented: boolean
}
export interface ProviderPreset {
  provider: string
  serviceType: string
  name: string
  baseUrl: string
  models: string[]
  requiresApiKey?: boolean
}
