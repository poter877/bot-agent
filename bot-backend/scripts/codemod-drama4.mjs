/**
 * Drama 迁移 codemod 4：
 * - asi：语句位置以 `(await …)` 开头（上一行以 ; { } 结尾或空行）→ 去掉包裹括号
 *   （按括号配对找闭合点），消除 ASI 吞并。
 * - a1308：TS1308（await 在非 async 函数内）→ 给最近的宿主函数加 async。
 * 用法：node scripts/codemod-drama4.mjs asi <file> | a1308 <errors.json>
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function matchCloseParen(src, openIdx) {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    } else if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch
      i++
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++ }
    }
  }
  return -1
}

function fixAsi(file) {
  const src = fs.readFileSync(file, 'utf8')
  const lines = src.split('\n')
  const edits = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)\(await\s/)
    if (!m) continue
    const prev = (lines[i - 1] ?? '').trimEnd()
    if (!/[;{}(,=>?:]$/.test(prev) && prev !== '' && !prev.endsWith('&&') && !prev.endsWith('||')) continue
    if (/[;,{]$/.test(prev) || prev.endsWith('=>') || prev === '') {
      // 语句位置：去掉包裹括号
    } else continue
    const openIdx = lines[i].indexOf('(await')
    const closeIdx = matchCloseParen(src, offsetOf(lines, i) + openIdx)
    if (closeIdx < 0) continue
    edits.push({ start: offsetOf(lines, i) + openIdx, end: offsetOf(lines, i) + openIdx + 1, text: '' })
    edits.push({ start: closeIdx, end: closeIdx + 1, text: '' })
  }
  if (!edits.length) return
  edits.sort((a, b) => b.start - a.start)
  let out = src
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  fs.writeFileSync(file, out)
  console.log('asi', path.relative(process.cwd(), file))
}

function offsetOf(lines, idx) {
  let n = 0
  for (let i = 0; i < idx; i++) n += lines[i].length + 1
  return n
}

function fixA1308(errorsFile) {
  const errors = JSON.parse(fs.readFileSync(errorsFile, 'utf8'))
  const byFile = new Map()
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file).push(e)
  }
  for (const [file, errs] of byFile) {
    const src = fs.readFileSync(file, 'utf8')
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true)
    const inserts = []
    for (const e of errs) {
      let cur = null
      const visit = (node) => {
        if (node.getStart(sf) <= e.offset && e.offset < node.getEnd() && ts.isAwaitExpression(node)) {
          if (!cur || node.getStart(sf) >= cur.getStart(sf)) cur = node
        }
        ts.forEachChild(node, visit)
      }
      visit(sf)
      if (!cur) continue
      let fn = cur.parent
      while (fn && !ts.isSourceFile(fn)) {
        if (ts.isFunctionDeclaration(fn) || ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isMethodDeclaration(fn)) break
        fn = fn.parent
      }
      if (!fn || ts.isSourceFile(fn)) continue
      if (fn.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) continue
      const head = src.slice(fn.getStart(sf), fn.getStart(sf) + 40)
      if (/^\s*(export\s+)?(default\s+)?async\b/.test(head)) continue
      const m = head.match(/^(\s*)((?:export\s+)?(?:default\s+)?)?/)
      inserts.push(fn.getStart(sf) + m[0].length)
    }
    if (!inserts.length) continue
    let out = src
    for (const pos of [...new Set(inserts)].sort((a, b) => b - a)) out = out.slice(0, pos) + 'async ' + out.slice(pos)
    fs.writeFileSync(file, out)
    console.log('a1308', path.relative(process.cwd(), file))
  }
}

const mode = process.argv[2]
if (mode === 'asi') fixAsi(process.argv[3])
else if (mode === 'a1308') fixA1308(process.argv[3])
