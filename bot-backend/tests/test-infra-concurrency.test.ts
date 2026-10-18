import { spawn } from 'node:child_process'
import { readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { it, expect } from 'vitest'

/**
 * Concurrency smoke for the test infrastructure handoff (tests/global-setup.ts).
 * The infra connection info used to live in ONE fixed file
 * (node_modules/.bot-backend-test-infra.json): two concurrent vitest runs
 * overwrote and deleted it under each other. Each run now owns a
 * pid+uuid-suffixed file reached through BOT_BACKEND_TEST_INFRA_FILE. Two
 * real vitest children start together here — both must come back green, and
 * the runs must be observable as DISTINCT infra files (with the fixed-name
 * scheme this assertion cannot pass: exactly one name can ever exist).
 */

const INFRA_FILE_PREFIX = '.bot-backend-test-infra-'

function listInfraFiles(): string[] {
  const dir = path.join(process.cwd(), 'node_modules')
  try {
    return readdirSync(dir).filter((name) => name.startsWith(INFRA_FILE_PREFIX))
  } catch {
    return []
  }
}

function runVitestChild(): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(path.join('node_modules', '.bin', 'vitest'), ['run', 'tests/config.test.ts'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    })
    child.on('error', reject)
    child.on('exit', (code) => resolve({ code: code ?? -1 }))
  })
}

it('two concurrent vitest runs each own their infra file', { timeout: 180_000 }, async () => {
  rmSync(path.join(process.cwd(), 'node_modules', '.bot-backend-test-infra.json'), { force: true })
  const observed = new Set<string>()
  const poller = setInterval(() => {
    for (const name of listInfraFiles()) observed.add(name)
  }, 300)

  let first: { code: number }
  let second: { code: number }
  try {
    // config.test.ts is a pure unit file: the children exercise the global
    // setup (own PostgreSQL + Redis + info file) without extra DB traffic.
    ;[first, second] = await Promise.all([runVitestChild(), runVitestChild()])
  } finally {
    clearInterval(poller)
  }

  expect(first.code).toBe(0)
  expect(second.code).toBe(0)
  // Distinct per-run files (the legacy fixed-name scheme fails here), and
  // both runs cleaned up after themselves — only this run's own file may
  // remain while it is still executing.
  expect(observed.size).toBeGreaterThanOrEqual(2)
  const ownFile = path.basename(process.env['BOT_BACKEND_TEST_INFRA_FILE'] ?? '')
  expect(listInfraFiles().filter((name) => name !== ownFile)).toEqual([])
})
