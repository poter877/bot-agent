import type { Context } from 'hono'
import { routePath } from 'hono/route'
import { z } from 'zod'
import { WorkerError } from './errors.js'
import { ProcessFailure } from './process.js'

export interface WorkerDiagnostic {
  event: 'cloud_worker_request_failed'
  method: string
  route: string
  category: 'policy' | 'process' | 'request' | 'unexpected'
  code: string
  exitCode?: number | null
}
export type DiagnosticSink = (entry: WorkerDiagnostic) => void

export const writeDiagnostic: DiagnosticSink = (entry) => console.error(JSON.stringify(entry))

/** Only registered route templates and fixed classification fields leave the worker. */
export function diagnostic(error: Error, context: Context): WorkerDiagnostic {
  const request = {
    event: 'cloud_worker_request_failed' as const,
    method: ['GET', 'POST', 'HEAD', 'OPTIONS'].includes(context.req.method) ? context.req.method : 'OTHER',
    route: routePath(context, -1),
  }
  if (error instanceof WorkerError) return { ...request, category: 'policy', code: error.code }
  if (error instanceof ProcessFailure) {
    return { ...request, category: 'process', code: 'runtime_command_failed', exitCode: error.code }
  }
  if (error instanceof z.ZodError || error instanceof SyntaxError) {
    return { ...request, category: 'request', code: 'invalid_request' }
  }
  return { ...request, category: 'unexpected', code: 'runtime_unavailable' }
}
