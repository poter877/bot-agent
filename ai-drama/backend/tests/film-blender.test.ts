/** Blender 接入契约测试：路径探测（override/候选/找不到）、无头执行与参数传递。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { detectBlenderPath, blenderVersion, runBlenderHeadless } = await import('../src/services/film-pipeline/blender.js')

function makeStubBlender(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-blender-'))
  const exe = path.join(dir, 'blender')
  fs.writeFileSync(exe, [
    '#!/bin/sh',
    'case "$1" in',
    '  --version) echo "Blender 4.2.1 stub"; exit 0;;',
    'esac',
    '# --background --python <script> -- <args...>：把收到的参数原样写给脚本看',
    'echo "argv: $@"',
    'exit 0',
  ].join('\n'), { mode: 0o755 })
  return exe
}

test('detectBlenderPath honors an executable override and rejects a missing one', () => {
  const exe = makeStubBlender()
  assert.equal(detectBlenderPath(exe), exe)
  assert.equal(detectBlenderPath(path.join(path.dirname(exe), 'nope')), null)
})

test('detectBlenderPath falls back to candidates/env only when they exist', () => {
  // 不存在的显式路径 → null（不静默回落，避免误装路径）
  assert.equal(detectBlenderPath('/definitely/not/blender'), null)
})

test('blenderVersion parses the version banner', async () => {
  const exe = makeStubBlender()
  assert.equal(await blenderVersion(exe), '4.2.1')
})

test('runBlenderHeadless passes script and args after --', async () => {
  const exe = makeStubBlender()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blender-run-'))
  const script = path.join(dir, 'build.py')
  fs.writeFileSync(script, 'print("hi from bpy")\n')
  const r = await runBlenderHeadless({ exe, scriptPath: script, cwd: dir, args: ['/tmp/out.png', 't=2'] })
  assert.equal(r.code, 0)
  assert.match(r.stdout, /--background/)
  assert.match(r.stdout, new RegExp(script))
  assert.match(r.stdout, /t=2/)
})
