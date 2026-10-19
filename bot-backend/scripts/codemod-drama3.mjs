/**
 * Drama 迁移收尾 codemod（错误驱动）：
 * - declfix：TS2339/2345/2349/2531/2322 的表达式基座标识符若来自未 await 的
 *   `const X = <调用>` 声明 → 声明处补 await，并清理文件内已有的 `(await X)` 双重包裹。
 * - retfix：TS1064 —— async 函数的非 Promise 返回类型包 Promise<...>。
 * - runfix：insert/values 链尾残留 `.run()` → 删除（配合已有 .returning() 与 getInsertId）。
 * 用法：node scripts/codemod-drama3.mjs <errors.json>
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

function load(file) {
  const source = fs.readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
  return { source, sf }
}

function looksDrizzle(text) {
  return /(^|[^A-Za-z0-9_$.])(db|tx)\.[a-z]/.test(text)
}

function ensureAsyncAtFn(rw, sf, node, insert) {
  let cur = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)) {
      if (!cur.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
        const head = rw.slice(cur.getStart(sf), cur.getStart(sf) + 40)
        if (!/^\s*(export\s+)?(default\s+)?async\b/.test(head)) {
          const m = head.match(/^(\s*)((?:export\s+)?(?:default\s+)?)?/)
          insert(cur.getStart(sf) + m[0].length, 'async ')
        }
      }
      return
    }
    cur = cur.parent
  }
}

const errors = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const byFile = new Map()
for (const e of errors) {
  if (!byFile.has(e.file)) byFile.set(e.file, [])
  byFile.get(e.file).push(e)
}

for (const [file, errs] of byFile) {
  let src = fs.readFileSync(file, 'utf8')
  let changed = false

  // retfix（TS1064）：async fn: T { → async fn: Promise<T> {
  for (const e of errs.filter((x) => x.code === 'TS1064')) {
    const line = src.split('\n')[e.line - 1] ?? ''
    const fixed = line.replace(/(\)\s*:\s*)([A-Za-z_][\w.<>, \[\]|]*?)(\s*\{)/, (_m, p1, p2, p3) =>
      p2.startsWith('Promise<') ? p1 + p2 + p3 : `${p1}Promise<${p2}>${p3}`)
    if (fixed !== line) {
      const lines = src.split('\n')
      lines[e.line - 1] = fixed
      src = lines.join('\n')
      changed = true
    }
  }

  // runfix：`.run()` 残留（.returning() 已在链上）→ 删 `.run()`
  {
    const before = src
    src = src.replace(/\)\s*\.run\(\)/g, ')')
    src = src.replace(/\n(\s*)\.run\(\)/g, '')
    if (src !== before) changed = true
  }

  // declfix：对每个错误位置，找表达式最左标识符；若其声明是未 await 的调用 → 补 await
  for (const e of errs.filter((x) => ['TS2339', 'TS2345', 'TS2349', 'TS2531', 'TS2322', 'TS7053', 'TS2739'].includes(x.code))) {
    const { sf } = load(file)
    let base = null
    const visit = (node) => {
      if (node.getStart(sf) <= e.offset && e.offset < node.getEnd() && ts.isIdentifier(node)) {
        if (!base || node.getStart(sf) >= base.getStart(sf)) base = node
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
    // 找包含 offset 的成员链，取最左标识符
    let prop = null
    const visit2 = (node) => {
      if (node.getStart(sf) <= e.offset && e.offset <= node.getEnd() && ts.isPropertyAccessExpression(node)) {
        if (!prop || node.getStart(sf) >= prop.getStart(sf)) prop = node
      }
      ts.forEachChild(node, visit2)
    }
    visit2(sf)
    let name = base?.getText(sf)
    if (!name && prop) {
      let b = prop
      while (ts.isPropertyAccessExpression(b.expression)) b = b.expression
      if (ts.isIdentifier(b.expression)) name = b.expression.getText(sf)
    }
    if (!name) continue
    // 声明处补 await（仅当初始化是调用/链且未 await）
    const declRe = new RegExp(`(const|let)\\s+${name}\\s*=\\s+(?!(?:await|async|function)\\b)`, 'g')
    let m
    while ((m = declRe.exec(src))) {
      const initPos = m.index + m[0].length
      // 初始化必须是调用开头（标识符( 或 db./tx.）
      const rest = src.slice(initPos, initPos + 80)
      if (!/^([A-Za-z_$][\w$]*\s*\(|(db|tx)\.)/.test(rest)) continue
      const insertAwait = () => { src = src.slice(0, initPos) + 'await ' + src.slice(initPos) }
      // 宿主函数 async：粗略向上找最近的 function/=> 行
      const before = src.slice(0, m.index)
      const fnStart = Math.max(before.lastIndexOf('function'), before.lastIndexOf('=>'), before.lastIndexOf('): '))
      void fnStart
      insertAwait()
      changed = true
      break
    }
    // 清理双重包裹：(await name) → name（声明已 await 后）
    const double = new RegExp(`\\(await\\s+${name}\\)`, 'g')
    const after = src.replace(double, name)
    if (after !== src) { src = after; changed = true }
  }

  if (changed) {
    fs.writeFileSync(file, src)
    console.log('fixed', path.relative(process.cwd(), file))
  }
}
