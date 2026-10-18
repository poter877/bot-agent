/** Render only our generated, self-contained scene files, at deterministic timestamps. */
import fs from 'node:fs/promises'
import path from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import type { LocalContext } from './local-core.js'
import { output } from './local-core.js'

export async function productionBrowser() {
  const candidates = [
    process.env.PRODUCTION_CHROME_BIN,
    ...(process.platform === 'darwin'
      ? [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ]
      : []),
    ...(process.env.PATH || '')
      .split(path.delimiter)
      .flatMap((dir) =>
        ['chromium', 'chromium-browser', 'google-chrome', 'chrome', 'msedge.exe', 'chrome.exe'].map((name) =>
          path.join(dir, name),
        ),
      ),
  ].filter((value): value is string => !!value)
  for (const candidate of candidates)
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) return candidate
  throw new Error('Three.js 视频渲染需要 Chrome / Chromium，请安装浏览器或设置 PRODUCTION_CHROME_BIN')
}
const pause = (signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, 80)
    signal.addEventListener('abort', onAbort, { once: true })
  })
export async function renderThreeFrames(
  ctx: LocalContext,
  spec: { width: number; height: number; fps: number; duration: number },
) {
  ctx.signal.throwIfAborted()
  const browser = await productionBrowser()
  const profile = path.join(ctx.outputDir, 'browser-profile')
  const allowed = new Set([
    'world.html',
    'world.js',
    'world.json',
    'three.module.js',
    'three.core.js',
    'GLTFLoader.js',
    'BufferGeometryUtils.js',
    'SkeletonUtils.js',
  ])
  for (let index = 0; index < 10; index++) allowed.add(`model-${index}.glb`)
  const server = createServer(async (req, res) => {
    const name = (req.url || '').split('?')[0].slice(1)
    if (!allowed.has(name)) {
      res.writeHead(404).end()
      return
    }
    try {
      const bytes = await fs.readFile(output(ctx, name))
      res.writeHead(200, {
        'Content-Type': name.endsWith('.js')
          ? 'text/javascript'
          : name.endsWith('.json')
            ? 'application/json'
            : name.endsWith('.glb')
              ? 'model/gltf-binary'
              : 'text/html',
        'Content-Security-Policy':
          "default-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; object-src 'none'",
      })
      res.end(bytes)
    } catch {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = (server.address() as { port: number }).port
  const child = spawn(
    browser,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-extensions',
      '--disable-component-update',
      '--disable-sync',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      `--window-size=${spec.width},${spec.height}`,
      `http://127.0.0.1:${port}/world.html`,
    ],
    { stdio: 'ignore', windowsHide: true },
  )
  let spawnError: Error | undefined
  let closed = false
  const completion = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      spawnError = error
      resolve()
    })
    child.once('close', () => {
      closed = true
      resolve()
    })
  })
  let socket: WebSocket | undefined
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let sequence = 0
  const command = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<any>((resolve, reject) => {
      const id = ++sequence
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`三维渲染浏览器响应超时：${method}`))
      }, 30000)
      pending.set(id, { resolve, reject, timer })
      socket!.send(JSON.stringify({ id, method, params }))
    })
  const abort = () => {
    child.kill('SIGTERM')
    socket?.close()
  }
  ctx.signal.addEventListener('abort', abort, { once: true })
  try {
    const deadline = Date.now() + 20000
    let debugPort = ''
    while (!debugPort) {
      ctx.signal.throwIfAborted()
      if (spawnError || closed || child.exitCode !== null)
        throw new Error('三维渲染浏览器启动失败，请检查 PRODUCTION_CHROME_BIN')
      debugPort = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '')).split(
        '\n',
      )[0]
      if (Date.now() > deadline) throw new Error('三维渲染浏览器启动超时')
      if (!debugPort) await pause(ctx.signal)
    }
    const targets = (await fetch(`http://127.0.0.1:${Number(debugPort)}/json/list`, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(10000)]),
    }).then((response) => response.json())) as { type: string; webSocketDebuggerUrl: string }[]
    const target = targets.find((target) => target.type === 'page')
    if (!target) throw new Error('三维渲染浏览器未建立画面')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    socket.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)),
        job = pending.get(data.id)
      if (!job) return
      clearTimeout(job.timer)
      pending.delete(data.id)
      if (data.error) job.reject(new Error('三维渲染浏览器执行失败'))
      else job.resolve(data.result)
    })
    const close = () => {
      for (const job of pending.values()) {
        clearTimeout(job.timer)
        job.reject(new Error('三维渲染浏览器已中断'))
      }
      pending.clear()
    }
    socket.addEventListener('close', close)
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        ctx.signal.removeEventListener('abort', onAbort)
      }
      const onAbort = () => {
        cleanup()
        reject(new Error('任务已取消'))
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('三维渲染浏览器连接超时'))
      }, 10000)
      ctx.signal.addEventListener('abort', onAbort, { once: true })
      socket!.addEventListener(
        'open',
        () => {
          cleanup()
          resolve()
        },
        { once: true },
      )
      socket!.addEventListener(
        'error',
        () => {
          cleanup()
          reject(new Error('无法连接三维渲染浏览器'))
        },
        { once: true },
      )
    })
    await command('Emulation.setDeviceMetricsOverride', {
      width: spec.width,
      height: spec.height,
      deviceScaleFactor: 1,
      mobile: false,
    })
    let ready = false
    while (!ready) {
      ctx.signal.throwIfAborted()
      const value = await command('Runtime.evaluate', {
        expression: "typeof globalThis.__renderFrame === 'function'",
        returnByValue: true,
      })
      ready = value.result?.value === true
      if (Date.now() > deadline) throw new Error('Three.js 场景加载失败，请检查 WebGL 和浏览器运行环境')
      if (!ready) await pause(ctx.signal)
    }
    const count = Math.ceil(spec.duration * spec.fps)
    let total = 0
    for (let index = 0; index < count; index++) {
      ctx.signal.throwIfAborted()
      const value = await command('Runtime.evaluate', {
        expression: `globalThis.__renderFrame(${index / spec.fps})`,
        returnByValue: true,
      })
      const png = value.result?.value
      if (typeof png !== 'string' || png.length > 32 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(png))
        throw new Error('Three.js 没有返回真实渲染帧')
      const bytes = Buffer.from(png, 'base64')
      total += bytes.length
      if (total > 512 * 1024 * 1024) throw new Error('三维帧数据超过512MB，请降低分辨率或时长')
      await fs.writeFile(output(ctx, `three-frame-${String(index).padStart(5, '0')}.png`), bytes)
      ctx.progress(0.2 + (0.65 * (index + 1)) / count)
    }
  } finally {
    ctx.signal.removeEventListener('abort', abort)
    socket?.close()
    for (const job of pending.values()) {
      clearTimeout(job.timer)
      job.reject(new Error('渲染结束'))
    }
    pending.clear()
    child.kill('SIGTERM')
    const kill = setTimeout(() => child.kill('SIGKILL'), 1000)
    kill.unref()
    await completion
    clearTimeout(kill)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    await fs.rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}
