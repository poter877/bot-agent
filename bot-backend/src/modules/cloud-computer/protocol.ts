import { z } from 'zod'

export const CLOUD_ACTIONS = ['click', 'move', 'drag', 'type', 'key', 'scroll'] as const
const coordinate = z.number().int().min(0).max(8191)
export const cloudActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), params: z.object({ x: coordinate, y: coordinate, button: z.enum(['left', 'middle', 'right']).default('left'), clicks: z.number().int().min(1).max(3).default(1) }).strict() }).strict(),
  z.object({ action: z.literal('move'), params: z.object({ x: coordinate, y: coordinate }).strict() }).strict(),
  z.object({ action: z.literal('drag'), params: z.object({ fromX: coordinate, fromY: coordinate, toX: coordinate, toY: coordinate, durationMs: z.number().int().min(100).max(2000).default(300) }).strict() }).strict(),
  z.object({ action: z.literal('type'), params: z.object({ text: z.string().min(1).max(8000) }).strict() }).strict(),
  z.object({ action: z.literal('key'), params: z.object({ keys: z.array(z.string().regex(/^[A-Za-z0-9_+-]{1,32}$/)).min(1).max(8) }).strict() }).strict(),
  z.object({ action: z.literal('scroll'), params: z.object({ direction: z.enum(['up', 'down', 'left', 'right']), amount: z.number().int().min(1).max(20), x: coordinate.optional(), y: coordinate.optional() }).strict() }).strict(),
])
export type CloudAction = z.infer<typeof cloudActionSchema>

export interface CloudImage {
  mediaType: 'image/png'
  data: string
  width: number
  height: number
}

export interface WorkerComputer {
  id: string
  state: 'missing' | 'stopped' | 'running'
  width: number
  height: number
}

/** Private worker implementations never receive browser-chosen owners or paths. */
export interface CloudWorker {
  status(owner: string, id: string): Promise<WorkerComputer>
  start(owner: string, id: string): Promise<WorkerComputer>
  stop(owner: string, id: string): Promise<WorkerComputer>
  capture(owner: string, id: string): Promise<{ image: CloudImage }>
  action(owner: string, id: string, action: CloudAction): Promise<{ ok: true }>
}
