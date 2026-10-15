import { spawn } from 'node:child_process'

export class ProcessFailure extends Error {
  constructor(readonly code: number | null, readonly stderr: string) {
    super('Cloud computer runtime command failed.')
  }
}

export interface ProcessRequest {
  command: string
  args: string[]
  signal: AbortSignal
  input?: string
}
export type ProcessRunner = (request: ProcessRequest) => Promise<string>

/** No shell. The only stdin accepted by callers is a validated desktop command. */
export const runProcess: ProcessRunner = ({ command, args, signal, input }) => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(new ProcessFailure(null, 'operation timeout'))
    return
  }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' })
  const output: Buffer[] = []
  let size = 0
  let stderr = ''
  let overflow = false
  child.stdout.on('data', (chunk: Buffer) => {
    size += chunk.length
    if (size > 12 * 1024 * 1024) {
      overflow = true
      child.kill('SIGKILL')
    } else {
      output.push(chunk)
    }
  })
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 16384) })
  child.once('error', () => reject(new ProcessFailure(null, 'runtime unavailable or timed out')))
  child.once('close', (code) => {
    if (code !== 0 || overflow || signal.aborted) reject(new ProcessFailure(code, stderr))
    else resolve(Buffer.concat(output).toString('utf8'))
  })
  child.stdin.on('error', () => { /* A rejected exec can close stdin before it consumes the bounded command. */ })
  child.stdin.end(input ?? '')
})
