import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, beforeEach, expect, it } from 'vitest'

const helper = fileURLToPath(new URL('../cloud-computer-runtime/control.py', import.meta.url))
let root: string
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lxkAAAAASUVORK5CYII='

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cloud-control-test-'))
  const fake = `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path');
const name=path.basename(process.argv[1]);
const args=process.argv.slice(2);
const input=fs.readFileSync(0,'utf8');
const run=()=>{
 fs.appendFileSync(path.join(path.dirname(process.argv[1]),'input.jsonl'),JSON.stringify({name,args,input})+'\\n');
 if(name==='scrot')fs.writeFileSync(args[args.length-1],Buffer.from('${png}','base64'));
};
if(process.env.FIXTURE_INPUT_DELAY && name==='xdotool')setTimeout(run,Number(process.env.FIXTURE_INPUT_DELAY));else run();
`
  for (const name of ['xdotool', 'xdpyinfo', 'xclip', 'scrot']) {
    const filename = path.join(root, name)
    writeFileSync(filename, fake)
    chmodSync(filename, 0o700)
  }
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function invoke(command: object, deadline = Date.now() + 4500, delay?: number): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [helper], { env: { ...process.env, PATH: `${root}:${process.env.PATH}`,
      ...(delay ? { FIXTURE_INPUT_DELAY: String(delay) } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk.toString() })
    child.stderr.resume()
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, output }))
    child.stdin.end(JSON.stringify({ ...command, deadlineAt: deadline }))
  })
}

function inputs(): Array<{ name: string; args: string[]; input: string }> {
  const filename = path.join(root, 'input.jsonl')
  return existsSync(filename) ? readFileSync(filename, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
}

it('captures a real helper PNG and passes Unicode and key combinations as data to subprocesses', async () => {
  const capture = await invoke({ action: 'screenshot' })
  expect(capture.code).toBe(0)
  expect(JSON.parse(capture.output)).toEqual({ image: { mediaType: 'image/png', data: png, width: 1, height: 1 } })
  const text = '公司测试 $(touch should-not-exist)'
  expect((await invoke({ action: 'type', params: { text } })).code).toBe(0)
  expect((await invoke({ action: 'key', params: { keys: ['Control_L', 'l'] } })).code).toBe(0)
  expect(inputs().find((input) => input.name === 'xclip')?.input).toBe(text)
  expect(inputs().at(-1)?.args).toEqual(['key', '--clearmodifiers', 'Control_L+l'])
  expect(existsSync(path.join(root, 'should-not-exist'))).toBe(false)
})

it('rejects expired commands and kills a delayed input subprocess before it can deliver late input', async () => {
  const command = { action: 'key', params: { keys: ['Return'] } }
  expect((await invoke(command, Date.now() - 1)).code).toBe(1)
  expect(inputs()).toHaveLength(0)
  expect((await invoke(command, Date.now() + 150, 500)).code).toBe(1)
  await new Promise((resolve) => setTimeout(resolve, 550))
  expect(inputs()).toHaveLength(0)
})

it('rejects out-of-screen coordinates and releases a dragged mouse before returning', async () => {
  expect((await invoke({ action: 'click', params: { x: 8000, y: 0 } })).code).toBe(1)
  expect(inputs()).toHaveLength(0)
  expect((await invoke({ action: 'drag', params: { fromX: 0, fromY: 0, toX: 40, toY: 30, durationMs: 100 } })).code).toBe(0)
  expect(inputs().at(-1)?.args).toEqual(['mouseup', '1'])
})
