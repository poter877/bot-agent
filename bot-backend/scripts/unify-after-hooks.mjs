/**
 * 统一 tests/drama 的 after 钩子：确保删临时库 + 关 admin 池（否则 node:test 挂起）。
 * 策略：找到每个 after(...) 的闭合大括号，把 DROP/CLOSE 前置插入回调体首行。
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('tests/drama')
const PRELUDE = 'process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end();'
let n = 0
for (const name of fs.readdirSync(dir).filter((f) => /\.(ts|mjs)$/.test(f) && f.includes('.test.'))) {
  const full = path.join(dir, name)
  let t = fs.readFileSync(full, 'utf8')
  if (!t.includes('__dbName') || t.includes('__admin.end()')) continue
  const idx = t.indexOf('after(')
  if (idx < 0) {
    // 无 after：文件尾追加
    t += `\nafter(async () => { ${PRELUDE} })\n`
    fs.writeFileSync(full, t); n++
    console.log('appended after:', name)
    continue
  }
  // 找 after( 后第一个 { 与其配对 }
  const braceOpen = t.indexOf('{', idx)
  let depth = 0, i = braceOpen
  for (; i < t.length; i++) {
    if (t[i] === '{') depth++
    else if (t[i] === '}') { depth--; if (depth === 0) break }
    else if (t[i] === "'" || t[i] === '"' || t[i] === '`') {
      const q = t[i]; i++
      while (i < t.length && t[i] !== q) { if (t[i] === '\\') i++; i++ }
    }
  }
  const insertAt = braceOpen + 1
  t = t.slice(0, insertAt) + ' ' + PRELUDE + t.slice(insertAt)
  fs.writeFileSync(full, t); n++
  console.log('patched after:', name)
}
console.log('total:', n)
