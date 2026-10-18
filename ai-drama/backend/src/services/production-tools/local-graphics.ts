import fs from 'node:fs/promises'
import path from 'node:path'
import { createReadStream } from 'node:fs'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import {
  ENCODE,
  asset,
  choice,
  dimensions,
  inputUrl,
  jsonResult,
  list,
  media,
  num,
  object,
  output,
  result,
  str,
  xml,
  ffmpeg,
} from './local-core.js'
import type { LocalContext, LocalDependencies, ToolResult } from './local-core.js'

function svg(width: number, height: number, body: string, background = '#101827') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${background}"/>${body}</svg>`
}
function color(value: unknown, fallback: string) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error('颜色须为 #RRGGBB')
  return value
}
function label(text: string, x: number, y: number, size = 24, fill = '#f5f7ff', anchor = 'middle') {
  return `<text x="${x}" y="${y}" font-size="${size}" font-family="Arial, sans-serif" fill="${fill}" text-anchor="${anchor}">${xml(text)}</text>`
}
async function imageResult(
  ctx: LocalContext,
  summary: string,
  image: string,
  data?: Record<string, unknown>,
) {
  await fs.writeFile(output(ctx, 'graphic.svg'), image)
  await sharp(Buffer.from(image), { limitInputPixels: 33554432 }).png().toFile(output(ctx, 'image.png'))
  return result(
    ctx,
    summary,
    [
      ['image.png', 'image'],
      ['graphic.svg', 'data'],
    ],
    data,
  )
}

async function diagram(ctx: LocalContext) {
  const { width, height } = dimensions(ctx.args, 1200, 800),
    theme = choice(ctx.args, 'theme', ['dark', 'light', 'neutral'] as const, 'dark'),
    dark = theme !== 'light'
  let nodes = list(ctx.args, ctx.args.nodes ? 'nodes' : 'boxes', 36),
    edges = list(ctx.args, 'connections', 100)
  const definition = str(ctx.args, 'definition', '', 10000),
    title = str(ctx.args, 'title', '流程图', 120)
  if (!nodes.length && definition) {
    const ids = new Map<string, number>(),
      parsedNodes: { label: string }[] = [],
      parsedEdges: { from: number; to: number; label: string }[] = []
    const node = (value: string) => {
      const match =
        /^\s*([a-zA-Z][a-zA-Z0-9_-]*)(?:\s*(?:\[(.*?)\]|\(\s*"?(.*?)"?\s*\)|\{(.*?)\}))?\s*$/.exec(value)
      if (!match)
        throw new Error(
          'Mermaid 目前支持 flowchart/graph 的节点和箭头，请使用 boxes/connections 表达复杂图形',
        )
      const id = match[1]
      if (!ids.has(id)) {
        ids.set(id, parsedNodes.length)
        parsedNodes.push({ label: (match[2] || match[3] || match[4] || id).replace(/^"|"$/g, '') })
      } else if (match[2] || match[3] || match[4])
        parsedNodes[ids.get(id)!].label = match[2] || match[3] || match[4]
      return ids.get(id)!
    }
    for (const line of definition
      .split(/[\n;]/)
      .map((v) => v.trim())
      .filter(Boolean)) {
      if (/^(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)\s*$/.test(line) || line.startsWith('%%')) continue
      const parts = line.split(/\s*(-->|---|==>|-\.->)(?:\|([^|]{0,100})\|)?\s*/)
      if (parts.length === 1) {
        node(line)
        continue
      }
      let previous = node(parts[0])
      for (let i = 1; i < parts.length; i += 3) {
        const next = node(parts[i + 2] || '')
        parsedEdges.push({ from: previous, to: next, label: parts[i + 1] || '' })
        previous = next
      }
    }
    if (parsedNodes.length > 36 || parsedEdges.length > 100) throw new Error('流程图超过节点或连接线数量限制')
    nodes = parsedNodes
    edges = parsedEdges
  }
  if (!nodes.length) throw new Error('请提供 boxes 或 nodes（label、color）以及 connections（from、to）')
  const columns = Math.min(4, nodes.length),
    rows = Math.ceil(nodes.length / columns),
    cellWidth = (width - 80) / columns,
    cellHeight = (height - 150) / rows,
    boxWidth = Math.max(40, cellWidth - 24),
    boxHeight = Math.min(100, cellHeight - 24),
    centers = nodes.map((_, i) => ({
      x: 40 + cellWidth * (i % columns) + cellWidth / 2,
      y: 120 + cellHeight * Math.floor(i / columns) + cellHeight / 2,
    }))
  let body = `<defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${dark ? '#a4b4d0' : '#52627e'}"/></marker></defs>${label(title, width / 2, 60, 32, dark ? '#f5f7ff' : '#182033')}`
  for (const value of edges) {
    const edge = object(value),
      from = Math.round(num(edge, 'from', 0, 0, nodes.length - 1)),
      to = Math.round(num(edge, 'to', 0, 0, nodes.length - 1)),
      a = centers[from],
      b = centers[to]
    body += `<path d="M${a.x} ${a.y} L${b.x} ${b.y}" stroke="${dark ? '#a4b4d0' : '#52627e'}" stroke-width="3" fill="none" marker-end="url(#arrow)"/>`
    if (edge.label)
      body += label(
        str(edge, 'label', '', 80),
        (a.x + b.x) / 2,
        (a.y + b.y) / 2 - 10,
        16,
        dark ? '#c4cfe2' : '#44516a',
      )
  }
  nodes.forEach((value, i) => {
    const node = typeof value === 'string' ? { label: value } : object(value),
      center = centers[i],
      fill = color(node.color, dark ? '#203754' : '#dce9ff')
    body += `<rect x="${center.x - boxWidth / 2}" y="${center.y - boxHeight / 2}" width="${boxWidth}" height="${boxHeight}" rx="14" fill="${fill}" stroke="${dark ? '#5292ef' : '#4a78c5'}" stroke-width="2"/>${label(str(node, 'label', `步骤 ${i + 1}`, 100), center.x, center.y + 8, Math.min(24, boxWidth / 7), dark ? '#f5f7ff' : '#182033')}`
  })
  return imageResult(ctx, '流程图生成完成', svg(width, height, body, dark ? '#101827' : '#f8fafc'), {
    nodes: nodes.length,
    connections: edges.length,
  })
}

async function codeCard(ctx: LocalContext) {
  const code = str(ctx.args, 'code', str(ctx.args, 'text'), 12000),
    { width, height } = dimensions(ctx.args, 1280, 720),
    title = str(ctx.args, 'title', '代码示例', 160)
  if (!code.trim()) throw new Error('请输入代码内容')
  const lines = code.replace(/\t/g, '  ').split('\n'),
    font = Math.max(12, Math.min(28, (height - 150) / Math.max(1, lines.length))),
    visible = lines.slice(0, Math.floor((height - 150) / font))
  if (visible.length !== lines.length) throw new Error('代码行数超过画面可读范围，请拆分代码卡片')
  let body = `<rect x="30" y="28" width="${width - 60}" height="${height - 56}" rx="22" fill="#182232" stroke="#31465e"/>${label(title, 68, 75, 24, '#c5d3e9', 'start')}`
  const token =
    /(\b(?:const|let|var|function|return|if|else|class|import|from|export|async|await|def|for|in|true|false|null|None)\b|"[^"\n]*"|'[^'\n]*'|\b\d+(?:\.\d+)?\b|\/\/.*$|#.*$)/g
  visible.forEach((line, i) => {
    let cursor = 0,
      content = ''
    for (const match of line.matchAll(token)) {
      content += xml(line.slice(cursor, match.index))
      const value = match[0],
        fill = /^['"]/.test(value)
          ? '#b4d88a'
          : /^(\/\/|#)/.test(value)
            ? '#8290a6'
            : /^\d/.test(value)
              ? '#e7b983'
              : '#c2a9f5'
      content += `<tspan fill="${fill}">${xml(value)}</tspan>`
      cursor = match.index! + value.length
    }
    content += xml(line.slice(cursor))
    body += `<text x="68" y="${125 + i * font * 1.25}" fill="#7e90ab" font-family="monospace" font-size="${font * 0.75}">${i + 1}</text><text x="120" y="${125 + i * font * 1.25}" fill="#e4edf9" font-family="monospace" font-size="${font}" xml:space="preserve">${content}</text>`
  })
  return imageResult(ctx, '代码图片生成完成', svg(width, height, body), {
    lines: lines.length,
    language: str(ctx.args, 'language', 'text', 50),
  })
}

/** Small arithmetic parser: mathematical expressions are data, never executable code. */
export function compileExpression(expression: string): (x: number, t: number) => number {
  if (!expression || expression.length > 500) throw new Error('数学表达式不能为空且不能超过 500 个字符')
  const tokens = expression.match(/(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?|[a-zA-Z]+|[+\-*/^(),]/g) ?? []
  if (tokens.join('').toLowerCase() !== expression.replace(/\s+/g, '').toLowerCase())
    throw new Error('数学表达式含有不支持的字符')
  type Eval = (x: number, t: number) => number
  let at = 0
  const parse = (minimum = 0): Eval => {
    const token = tokens[at++]
    let left: Eval
    if (token === '-' || token === '+') {
      const child = parse(3)
      left = (x, t) => (token === '-' ? -child(x, t) : child(x, t))
    } else if (token === '(') {
      left = parse()
      if (tokens[at++] !== ')') throw new Error('数学表达式括号不匹配')
    } else if (token && /^(?:\d|\.)/.test(token)) {
      const value = Number(token)
      left = () => value
    } else if (token === 'x') left = (x) => x
    else if (token === 't') left = (_, t) => t
    else if (token === 'pi') left = () => Math.PI
    else if (token === 'e') left = () => Math.E
    else if (token && ['sin', 'cos', 'tan', 'exp', 'log', 'sqrt', 'abs'].includes(token)) {
      if (tokens[at++] !== '(') throw new Error('数学函数须使用括号')
      const argument = parse()
      if (tokens[at++] !== ')') throw new Error('数学函数括号不匹配')
      const fn = {
        sin: Math.sin,
        cos: Math.cos,
        tan: Math.tan,
        exp: Math.exp,
        log: Math.log,
        sqrt: Math.sqrt,
        abs: Math.abs,
      }[token]!
      left = (x, t) => fn(argument(x, t))
    } else throw new Error(`不支持的数学符号：${token ?? '表达式不完整'}`)
    const priority: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 }
    while (tokens[at] in priority && priority[tokens[at]] >= minimum) {
      const op = tokens[at++],
        right = parse(priority[op] + (op === '^' ? 0 : 1)),
        previous = left
      left = (x, t) => {
        const a = previous(x, t),
          b = right(x, t)
        return op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a ** b
      }
    }
    return left
  }
  const compiled = parse()
  if (at !== tokens.length) throw new Error('数学表达式含有多余内容')
  return compiled
}

async function animatedSvg(
  ctx: LocalContext,
  deps: LocalDependencies,
  draw: (time: number, index: number, count: number) => string,
  title: string,
) {
  const seconds = num(ctx.args, 'duration_seconds', 3, 0.1, 30),
    fps = Math.round(num(ctx.args, 'fps', 12, 1, 30)),
    count = Math.ceil(seconds * fps)
  if (count > 450) throw new Error('动画最多生成 450 帧，请缩短时长或降低帧率')
  for (let i = 0; i < count; i++) {
    ctx.signal.throwIfAborted()
    await sharp(Buffer.from(draw(i / fps, i, count)))
      .png()
      .toFile(output(ctx, `frame-${String(i).padStart(4, '0')}.png`))
    ctx.progress((i / count) * 0.8)
  }
  await fs.copyFile(output(ctx, 'frame-0000.png'), output(ctx, 'image.png'))
  await ffmpeg(ctx, deps, [
    '-framerate',
    String(fps),
    '-i',
    path.join(ctx.outputDir, 'frame-%04d.png'),
    '-t',
    String(seconds),
    ...ENCODE,
    '-movflags',
    '+faststart',
    output(ctx, 'video.mp4'),
  ])
  return result(
    ctx,
    title,
    [
      ['video.mp4', 'video'],
      ['image.png', 'image'],
    ],
    { duration: seconds, fps, frames: count },
  )
}

async function mathAnimation(ctx: LocalContext, deps: LocalDependencies) {
  if (ctx.args.code) throw new Error('数学动画接收 expression 数学表达式，不执行任意程序代码')
  const { width, height } = dimensions(ctx.args, 960, 540),
    expression = str(ctx.args, 'expression', 'sin(x+t)', 500),
    evaluate = compileExpression(expression),
    minX = num(ctx.args, 'x_min', -Math.PI * 2, -1000, 1000),
    maxX = num(ctx.args, 'x_max', Math.PI * 2, -1000, 1000),
    minY = num(ctx.args, 'y_min', -2, -1000, 1000),
    maxY = num(ctx.args, 'y_max', 2, -1000, 1000)
  if (maxX <= minX || maxY <= minY) throw new Error('坐标轴范围无效')
  const mapX = (x: number) => 70 + ((x - minX) / (maxX - minX)) * (width - 120),
    mapY = (y: number) => height - 60 - ((y - minY) / (maxY - minY)) * (height - 150)
  return animatedSvg(
    ctx,
    deps,
    (time, index, count) => {
      const commands: string[] = []
      let connected = false
      for (let i = 0; i <= 600; i++) {
        const x = minX + ((maxX - minX) * i) / 600,
          y = evaluate(x, time)
        if (!Number.isFinite(y) || y < minY - 10 || y > maxY + 10) {
          connected = false
          continue
        }
        commands.push(`${connected ? 'L' : 'M'}${mapX(x).toFixed(2)},${mapY(y).toFixed(2)}`)
        connected = true
      }
      const zeroX = mapX(Math.max(minX, Math.min(0, maxX))),
        zeroY = mapY(Math.max(minY, Math.min(0, maxY)))
      return svg(
        width,
        height,
        `${label(`y = ${expression}`, width / 2, 50, 28)}<path d="M70 ${zeroY}H${width - 50}M${zeroX} 90V${height - 60}" stroke="#71829a" stroke-width="2"/><clipPath id="plot"><rect x="70" y="90" width="${width - 120}" height="${height - 150}"/></clipPath><path clip-path="url(#plot)" d="${commands.join(' ')}" fill="none" stroke="#69a7ff" stroke-width="4"/>${label(`t = ${time.toFixed(2)}`, width - 80, height - 20, 16)}<rect x="70" y="${height - 12}" width="${((width - 120) * (index + 1)) / count}" height="4" fill="#69a7ff"/>`,
      )
    },
    '数学动画渲染完成',
  )
}

async function showcase(ctx: LocalContext, deps: LocalDependencies) {
  const { width, height } = dimensions(ctx.args, 1280, 720),
    title = str(ctx.args, 'title', '视频工厂', 100),
    subtitle = str(ctx.args, 'subtitle', str(ctx.args, 'description', '', 180), 180),
    background = color(ctx.args.background_color, '#101827'),
    body = `${label(title, width / 2, height * 0.45, Math.min(68, width / Math.max(8, Array.from(title).length)), '#f8fbff')}${label(subtitle, width / 2, height * 0.6, 28, '#9baecb')}`
  const image = svg(width, height, body, background)
  await imageResult(ctx, '展示卡片生成完成', image)
  if (ctx.args.render_video) {
    const seconds = num(ctx.args, 'duration_seconds', 3, 0.1, 30)
    await ffmpeg(ctx, deps, [
      '-loop',
      '1',
      '-i',
      output(ctx, 'image.png'),
      '-t',
      String(seconds),
      '-vf',
      'fps=30',
      ...ENCODE,
      output(ctx, 'video.mp4'),
    ])
    return result(ctx, '展示卡片视频生成完成', [
      ['image.png', 'image'],
      ['video.mp4', 'video'],
    ])
  }
  return result(ctx, '展示卡片生成完成', [
    ['image.png', 'image'],
    ['graphic.svg', 'data'],
  ])
}

function normalizeCharacters(args: Record<string, unknown>) {
  const entries = list(args, 'characters', 12)
  if (!entries.length) throw new Error('请提供 characters（id、name、color）')
  const ids = new Set<string>()
  return entries.map((entry, i) => {
    const value = object(entry),
      id = str(value, 'id', `character-${i + 1}`, 80)
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('角色 id 无效或重复')
    ids.add(id)
    return {
      id,
      name: str(value, 'name', id, 100),
      color: color(value.color, '#6da8ff'),
      bodyHeight: num(value, 'bodyHeight', 180, 80, 300),
    }
  })
}
function rigCharacters(args: Record<string, unknown>) {
  const design = args.character_design
    ? object(args.character_design)
    : args.rig_plan
      ? object(args.rig_plan)
      : args
  return normalizeCharacters(design)
}
async function character(ctx: LocalContext, deps: LocalDependencies) {
  if (ctx.toolId === 'character_spec_generator')
    return jsonResult(ctx, '角色规格已整理', {
      version: 1,
      characters: normalizeCharacters(ctx.args),
      brief: str(ctx.args, 'brief', '', 5000),
    })
  if (ctx.toolId === 'svg_rig_builder') {
    const characters = rigCharacters(ctx.args)
    return jsonResult(ctx, 'SVG 关节结构已建立', {
      version: 1,
      characters,
      parts: ['head', 'torso', 'leftArm', 'rightArm', 'leftLeg', 'rightLeg'],
      pivots: {
        head: [0, -85],
        leftArm: [-24, -50],
        rightArm: [24, -50],
        leftLeg: [-14, 20],
        rightLeg: [14, 20],
      },
    })
  }
  if (ctx.toolId === 'pose_library_builder') {
    const characters = rigCharacters(ctx.args)
    return jsonResult(ctx, '角色动作姿势库已建立', {
      version: 1,
      characters,
      poses: {
        idle: { leftArm: 10, rightArm: -10, leftLeg: 0, rightLeg: 0 },
        wave: { leftArm: 10, rightArm: -145, leftLeg: 0, rightLeg: 0 },
        walk: { leftArm: 25, rightArm: -25, leftLeg: -25, rightLeg: 25 },
      },
      cycles: { walk: { period: 0.8, amplitude: 25 }, breathe: { period: 2.5, amplitude: 2 } },
    })
  }
  if (ctx.toolId === 'action_timeline_compiler') {
    const plan = ctx.args.scene_plan ? object(ctx.args.scene_plan) : ctx.args,
      actions = list(plan, 'actions', 200),
      normalized = actions.map((value) => {
        const action = object(value),
          start = num(action, 'start', 0),
          end = num(action, 'end', 3)
        if (end <= start) throw new Error('角色动作结束时间须大于开始时间')
        return {
          characterId: str(action, 'characterId', '', 80),
          start,
          end,
          pose: choice(action, 'pose', ['idle', 'wave', 'walk'] as const, 'idle'),
          x: num(action, 'x', 0.5, 0, 1),
          toX: num(action, 'toX', num(action, 'x', 0.5, 0, 1), 0, 1),
        }
      })
    if (!normalized.length) throw new Error('请提供 scene_plan.actions')
    return jsonResult(ctx, '角色动作时间轴编译完成', {
      version: 1,
      actions: normalized,
      fps: num(ctx.args, 'fps', 12, 1, 30),
    })
  }
  if (ctx.toolId === 'character_animation_reviewer') {
    const rig = ctx.args.rig_plan ? object(ctx.args.rig_plan) : {},
      timeline = ctx.args.action_timeline ? object(ctx.args.action_timeline) : {},
      issues: string[] = []
    const chars = Array.isArray(rig.characters) ? rig.characters : []
    if (!chars.length) issues.push('缺少角色关节结构')
    if (!Array.isArray(timeline.actions) || !timeline.actions.length) issues.push('缺少动作时间轴')
    if (ctx.args.review_level === 'final' && ctx.args.frame_samples_checked !== true)
      issues.push('成片抽帧尚未确认')
    return jsonResult(ctx, issues.length ? '角色动画检查发现问题' : '角色动画结构检查通过', {
      passed: !issues.length,
      issues,
      inspectedArtifacts: ['rig_plan', 'action_timeline'],
      browserReviewed: ctx.args.browser_preview_checked === true,
    })
  }
  const characters = rigCharacters(ctx.args),
    timeline = ctx.args.action_timeline ? object(ctx.args.action_timeline) : {},
    actions = list(timeline, 'actions', 200).map((v) => object(v)),
    { width, height } = dimensions(ctx.args, 960, 540)
  if (!actions.length) throw new Error('请提供 action_timeline.actions')
  const known = new Set(characters.map((c) => c.id))
  for (const action of actions)
    if (!known.has(str(action, 'characterId', '', 80))) throw new Error('动作时间轴包含不存在的角色')
  return animatedSvg(
    ctx,
    deps,
    (time) => {
      let body = `<path d="M0 ${height - 65}H${width}" stroke="#334155" stroke-width="3"/>`
      for (let i = 0; i < characters.length; i++) {
        const c = characters[i],
          action = actions.find(
            (a) => a.characterId === c.id && time >= num(a, 'start', 0) && time < num(a, 'end', 3),
          ),
          pose = action ? choice(action, 'pose', ['idle', 'wave', 'walk'] as const, 'idle') : 'idle',
          start = action ? num(action, 'start', 0) : 0,
          end = action ? num(action, 'end', 3) : 3,
          progress = Math.max(0, Math.min(1, (time - start) / (end - start))),
          from = action
            ? num(action, 'x', (i + 1) / (characters.length + 1), 0, 1)
            : (i + 1) / (characters.length + 1),
          to = action ? num(action, 'toX', from, 0, 1) : from,
          x = 70 + (width - 140) * (from + (to - from) * progress),
          y = height - 160 + Math.sin((time * Math.PI * 2) / 2.5) * 2,
          walk = pose === 'walk' ? Math.sin((time * Math.PI * 2) / 0.8) * 25 : 0,
          right = pose === 'wave' ? -140 + Math.sin(time * 12) * 15 : -walk - 8
        body += `<g transform="translate(${x},${y}) scale(${c.bodyHeight / 180})" stroke="${c.color}" stroke-width="13" stroke-linecap="round"><circle cx="0" cy="-85" r="24" fill="${c.color}" stroke="none"/><path d="M0 -54V22"/><path d="M-16 20V80" transform="rotate(${-walk} -16 20)"/><path d="M16 20V80" transform="rotate(${walk} 16 20)"/><path d="M-5 -45L-22 -40L-24 15" transform="rotate(${walk + 8} -5 -45)"/><path d="M5 -45L22 -40L24 15" transform="rotate(${right} 5 -45)"/></g>${label(c.name, x, height - 20, 20)}`
      }
      return svg(width, height, body)
    },
    '角色关节动画渲染完成',
  )
}

// Minimal streaming ZIP writer (stored entries): no external archiver or shell.
const crcTable = Uint32Array.from({ length: 256 }, (_, number) => {
  let value = number
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
async function crcFile(file: string, signal: AbortSignal) {
  let crc = 0xffffffff
  for await (const chunk of createReadStream(file)) {
    signal.throwIfAborted()
    for (const byte of chunk as Buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}
export async function writeZip(
  destination: string,
  entries: { file: string; name: string }[],
  signal: AbortSignal,
) {
  const temporary = `${destination}.partial-${randomUUID()}`,
    handle = await fs.open(temporary, 'wx'),
    central: Buffer[] = []
  let offset = 0,
    total = 0
  try {
    for (const entry of entries) {
      signal.throwIfAborted()
      if (!/^[a-zA-Z0-9_.-]+$/.test(entry.name) || entry.name === '..') throw new Error('打包文件名无效')
      const stat = await fs.stat(entry.file)
      total += stat.size
      if (total > 480 * 1024 * 1024) throw new Error('打包源文件超过 480 MB')
      const name = Buffer.from(entry.name),
        crc = await crcFile(entry.file, signal),
        header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50)
      header.writeUInt16LE(20, 4)
      header.writeUInt32LE(crc, 14)
      header.writeUInt32LE(stat.size, 18)
      header.writeUInt32LE(stat.size, 22)
      header.writeUInt16LE(name.length, 26)
      await handle.write(header)
      await handle.write(name)
      for await (const chunk of createReadStream(entry.file)) {
        signal.throwIfAborted()
        await handle.write(chunk as Buffer)
      }
      const record = Buffer.alloc(46)
      record.writeUInt32LE(0x02014b50)
      record.writeUInt16LE(20, 4)
      record.writeUInt16LE(20, 6)
      record.writeUInt32LE(crc, 16)
      record.writeUInt32LE(stat.size, 20)
      record.writeUInt32LE(stat.size, 24)
      record.writeUInt16LE(name.length, 28)
      record.writeUInt32LE(offset, 42)
      central.push(Buffer.concat([record, name]))
      offset += header.length + name.length + stat.size
    }
    const directory = Buffer.concat(central),
      end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50)
    end.writeUInt16LE(entries.length, 8)
    end.writeUInt16LE(entries.length, 10)
    end.writeUInt32LE(directory.length, 12)
    end.writeUInt32LE(offset, 16)
    await handle.write(directory)
    await handle.write(end)
    await handle.sync()
  } catch (error) {
    await handle.close()
    await fs.rm(temporary, { force: true })
    throw error
  }
  await handle.close()
  try {
    signal.throwIfAborted()
    await fs.rename(temporary, destination)
  } catch (error) {
    await fs.rm(temporary, { force: true })
    throw error
  }
}
async function bundle(ctx: LocalContext, deps: LocalDependencies) {
  const urls = ctx.args.sourceUrls ? list(ctx.args, 'sourceUrls', 100) : [inputUrl(ctx.args)],
    entries: { file: string; name: string }[] = []
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i]
    if (typeof url !== 'string') throw new Error('打包素材地址无效')
    const extension = path.extname(url).toLowerCase(),
      file = ['.json', '.srt', '.vtt', '.txt', '.glb', '.fbx', '.blend', '.svg', '.zip'].includes(extension)
        ? await asset(ctx, deps, url, [extension])
        : await media(ctx, deps, url)
    entries.push({ file, name: `${i + 1}-${path.basename(file).replace(/[^a-zA-Z0-9_.-]/g, '_')}` })
  }
  const manifest = {
    projectId: ctx.projectId,
    title: str(ctx.args, 'title', '视频导出', 200),
    description: str(ctx.args, 'description', '', 10000),
    tags: list(ctx.args, 'tags', 100),
    platform: str(ctx.args, 'platform', 'local', 100),
    files: entries.map((entry) => entry.name),
    createdAt: new Date().toISOString(),
  }
  await fs.writeFile(output(ctx, 'manifest.json'), JSON.stringify(manifest, null, 2))
  entries.push({ file: output(ctx, 'manifest.json'), name: 'manifest.json' })
  await writeZip(output(ctx, 'bundle.zip'), entries, ctx.signal)
  return result(
    ctx,
    '导出包已生成',
    [
      ['bundle.zip', 'archive'],
      ['manifest.json', 'data'],
    ],
    { files: entries.length, title: manifest.title },
  )
}

export async function runGraphicsTool(
  ctx: LocalContext,
  deps: LocalDependencies,
): Promise<ToolResult | null> {
  switch (ctx.toolId) {
    case 'diagram_gen':
      return diagram(ctx)
    case 'code_snippet':
      return codeCard(ctx)
    case 'math_animate':
      return mathAnimation(ctx, deps)
    case 'showcase_card':
      return showcase(ctx, deps)
    case 'export_bundle':
      return bundle(ctx, deps)
    case 'character_spec_generator':
    case 'svg_rig_builder':
    case 'pose_library_builder':
    case 'action_timeline_compiler':
    case 'character_rig_renderer':
    case 'character_animation_reviewer':
      return character(ctx, deps)
    default:
      return null
  }
}
