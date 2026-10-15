export type { CloudComputerCaptureResult, CloudComputerSnapshot } from '@hermes/shared'

export type CloudAction =
  | { action: 'click'; params: { x: number; y: number; button: 'left' | 'middle' | 'right'; clicks: number } }
  | { action: 'move'; params: { x: number; y: number } }
  | { action: 'drag'; params: { fromX: number; fromY: number; toX: number; toY: number; durationMs: number } }
  | { action: 'type'; params: { text: string } }
  | { action: 'key'; params: { keys: string[] } }
  | { action: 'scroll'; params: { direction: 'up' | 'down' | 'left' | 'right'; amount: number; x: number; y: number } }

export interface CloudRequest {
  <T>(method: string, params?: Record<string, unknown>, signal?: AbortSignal): Promise<T>
}
