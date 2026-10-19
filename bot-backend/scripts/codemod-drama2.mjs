/**
 * Drama pg 迁移 codemod v2 — 单遍成型（重置后运行一次）：
 * 1) 相对导入补 .js（NodeNext）
 * 2) drizzle 同步链 → 异步：EXPR.run()→(await EXPR)；EXPR.all()→(await EXPR)；
 *    EXPR.get()→(await EXPR)[0]；db.insert().values()→.returning()；
 *    db.transaction(cb)→await + cb async；宿主函数自动补 async（去重防叠）
 * 3) 级联修复（迭代 N 轮，tsc JSON 驱动）：仅在「函数调用链根部」包 await
 *    —— 沿 offset 向上找最近的 CallExpression（callee 为标识符或 db/tx 链），
 *    包住整条链；绝不包 Identifier/属性名。
 * 用法：node scripts/codemod-drama2.mjs pass1 | cascade errors.json
 */
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const ROOT = path.resolve(process.cwd(), process.argv[3] ? 'tests/drama' : 'src/drama')

function collectTsFiles(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...collectTsFiles(full))
    else if (e.name.endsWith('.ts') || e.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

class Rewriter {
  constructor(file) {
    this.file = file
    this.source = fs.readFileSync(file, 'utf8')
    this.sf = ts.createSourceFile(file, this.source, ts.ScriptTarget.ES2022, true)
    this.edits = []
  }
  push(start, end, text) {
    for (const e of this.edits) {
      if (start === e.start && end === e.end) return // 零宽同位插入去重
      if (start < e.end && end > e.start) return
    }
    this.edits.push({ start, end, text })
  }
  replace(node, text) { this.push(node.getStart(this.sf), node.getEnd(), text) }
  insert(pos, text) { this.push(pos, pos, text) }
  apply() {
    this.edits.sort((a, b) => b.start - a.start)
    let out = this.source
    for (const e of this.edits) out = out.slice(0, e.start) + e.text + out.slice(e.end)
    return out
  }
}

function looksLikeDrizzleChain(rw, expr) {
  const text = rw.source.slice(expr.getStart(rw.sf), expr.getEnd())
  return /(^|[^A-Za-z0-9_$.])(db|tx)\s*\.[a-z]/.test(text)
}

function enclosingFunction(rw, node) {
  let cur = node.parent
  while (cur && !ts.isSourceFile(cur)) {
    if (ts.isFunctionDeclaration(cur) || ts.isFunctionExpression(cur) || ts.isArrowFunction(cur) || ts.isMethodDeclaration(cur)) {
      return { fn: cur, isAsync: cur.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ?? false }
    }
    cur = cur.parent
  }
  return null
}

/** 在位置 pos 前最近的 async 关键字占位判定：看 fn 源码前缀 */
function ensureAsync(rw, node) {
  const host = enclosingFunction(rw, node)
  if (!host || host.isAsync) return
  const start = host.fn.getStart(rw.sf)
  const head = rw.source.slice(start, start + 24)
  if (/^\s*(export\s+)?(default\s+)?async\b/.test(head)) return
  const m = head.match(/^(\s*)((?:export\s+)?(?:default\s+)?)?/)
  const insertAt = start + m[0].length
  const isGen = host.fn.asteriskToken ? '*' : ''
  rw.insert(insertAt, ('async ' + isGen).trimEnd() + ' ')
}

function fixImports(rw) {
  const visit = (node) => {
    const spec = (n) => {
      if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
        const spec2 = n.moduleSpecifier.text
        if (spec2.startsWith('.') && !/\.(js|mjs|json)$/.test(spec2)) {
          const quote = rw.source[n.moduleSpecifier.getStart(rw.sf)]
          rw.replace(n.moduleSpecifier, `${quote}${spec2}.js${quote}`)
        }
      }
    }
    spec(node)
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0]
      if (arg && ts.isStringLiteral(arg)) {
        const s = arg.text
        if (s.startsWith('.') && !/\.(js|mjs|json)$/.test(s)) {
          const quote = rw.source[arg.getStart(rw.sf)]
          rw.replace(arg, `${quote}${s}.js${quote}`)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(rw.sf)
}

function pass1(bOnly = false) {
  for (const file of collectTsFiles(ROOT)) {
    const rw = new Rewriter(file)
    if (!bOnly) fixImports(rw)
    const visit = (node) => {
      if (bOnly) {
        if (ts.isCallExpression(node) && node.expression && ts.isPropertyAccessExpression(node.expression)) {
          const prop = node.expression
          const recv = prop.expression
          if ((prop.name.text === 'run' || prop.name.text === 'all' || prop.name.text === 'get') && looksLikeDrizzleChain(rw, recv)) {
            const inner = rw.source.slice(recv.getStart(rw.sf), recv.getEnd())
            if (prop.name.text === 'get') rw.replace(node, `(await ${inner})[0]`)
            else rw.replace(node, `(await ${inner})`)
            const head = rw.source.slice(node.getStart(rw.sf), node.getEnd())
            void head
            return
          }
        }
      }
      if (ts.isCallExpression(node) && node.expression && ts.isPropertyAccessExpression(node.expression)) {
        const prop = node.expression
        const recv = prop.expression
        if (prop.name.text === 'run' || prop.name.text === 'all') {
          if (looksLikeDrizzleChain(rw, recv)) {
            ensureAsync(rw, node)
            rw.replace(node, `(await ${rw.source.slice(recv.getStart(rw.sf), recv.getEnd())})`)
          }
        } else if (prop.name.text === 'get') {
          if (looksLikeDrizzleChain(rw, recv)) {
            ensureAsync(rw, node)
            rw.replace(node, `(await ${rw.source.slice(recv.getStart(rw.sf), recv.getEnd())})[0]`)
          }
        } else if (prop.name.text === 'values' && looksLikeDrizzleChain(rw, node)) {
          rw.insert(node.getEnd(), '.returning()')
        } else if (prop.name.text === 'transaction' && looksLikeDrizzleChain(rw, node)) {
          const cb = node.arguments[0]
          if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
            const head = rw.source.slice(cb.getStart(rw.sf), cb.getStart(rw.sf) + 12)
            if (!/^\s*async\b/.test(head)) rw.insert(cb.getStart(rw.sf), 'async ')
          }
          ensureAsync(rw, node)
          rw.replace(node, `(await ${rw.source.slice(node.getStart(rw.sf), node.getEnd())})`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(rw.sf)
    const next = rw.apply()
    if (next !== rw.source) {
      fs.writeFileSync(file, next)
      console.log('pass1', path.relative(process.cwd(), file))
    }
  }
}

/** 级联：在 offset 处向上找「函数调用链根」并整链包 await */
function wrapChainAwaitAt(rw, offset) {
  let target = null
  const visit = (node) => {
    if (node.getStart(rw.sf) <= offset && offset < node.getEnd() && ts.isCallExpression(node)) {
      const callee = node.expression
      const isFnCall = ts.isIdentifier(callee)
      const isDrizzle = callee && ts.isPropertyAccessExpression(callee) && looksLikeDrizzleChain(rw, callee.expression)
      if (isFnCall || isDrizzle) {
        if (!target || node.getStart(rw.sf) >= target.getStart(rw.sf)) target = node
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(rw.sf)
  let skippedByAwaitAncestor = false
  if (target) {
    let cur = target.parent
    while (cur && !ts.isSourceFile(cur)) {
      if (ts.isAwaitExpression(cur)) { skippedByAwaitAncestor = true; break }
      cur = cur.parent
    }
  }
  if (!target || skippedByAwaitAncestor) {
    if (target && !skippedByAwaitAncestor) {
      // unreachable guard kept for clarity
    }
    // fallback：offset 落在 Promise 变量上 —— 回溯到最近声明处，包初始化调用
    let cur = null
    const visit2 = (node) => {
      if (node.getStart(rw.sf) <= offset && offset < node.getEnd() && ts.isIdentifier(node)) {
        if (!cur || node.getStart(rw.sf) >= cur.getStart(rw.sf)) cur = node
      }
      ts.forEachChild(node, visit2)
    }
    visit2(rw.sf)
    // offset 落在成员链上（常是点号）：把链基座标识符内联包 await —— project.x → (await project).x
    let prop = null
    const visit3 = (node) => {
      if (node.getStart(rw.sf) <= offset && offset <= node.getEnd() && ts.isPropertyAccessExpression(node)) {
        if (!prop || node.getStart(rw.sf) >= prop.getStart(rw.sf)) prop = node
      }
      ts.forEachChild(node, visit3)
    }
    visit3(rw.sf)
    if (prop) {
      let base = prop
      while (ts.isPropertyAccessExpression(base.expression)) base = base.expression
      if (ts.isIdentifier(base.expression)) {
        const id = base.expression
        const before = rw.source.slice(Math.max(0, id.getStart(rw.sf) - 8), id.getStart(rw.sf))
        if (!/await\s*$/.test(before)) {
          ensureAsync(rw, id)
          rw.replace(id, `(await ${rw.source.slice(id.getStart(rw.sf), id.getEnd())})`)
          return true
        }
      }
    }
    let anc = cur?.parent
    while (anc && !ts.isSourceFile(anc)) {
      if (ts.isVariableDeclaration(anc) && anc.initializer && ts.isCallExpression(anc.initializer) && !ts.isAwaitExpression(anc.initializer.parent)) {
        const init = anc.initializer
        ensureAsync(rw, init)
        rw.replace(init, `(await ${rw.source.slice(init.getStart(rw.sf), init.getEnd())})`)
        return true
      }
      if (ts.isReturnStatement(anc) && anc.expression && ts.isCallExpression(anc.expression)) break
      anc = anc.parent
    }
    // 兜底：取包含 offset 的最小语句；在其中找第一个未 await 的「标识符调用」并包 await
    let stmt = null
    const visit4 = (node) => {
      if (node.getStart(rw.sf) <= offset && offset < node.getEnd() &&
          (ts.isExpressionStatement(node) || ts.isReturnStatement(node) || ts.isVariableStatement(node) || ts.isPropertyAssignment(node) || ts.isSpreadAssignment(node) || ts.isSpreadElement(node))) {
        if (!stmt || node.getStart(rw.sf) >= stmt.getStart(rw.sf)) stmt = node
      }
      ts.forEachChild(node, visit4)
    }
    visit4(rw.sf)
    if (stmt) {
      let first = null
      const visit5 = (node) => {
        if (!first && ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !ts.isAwaitExpression(node.parent)) {
          const nm = node.expression.text
          if (!/^(JSON|Object|Array|Number|String|Boolean|Date|Math|Map|Set|Promise|Error)$/.test(nm)) first = node
        }
        ts.forEachChild(node, visit5)
      }
      visit5(stmt)
      if (first) {
        ensureAsync(rw, first)
        rw.replace(first, `(await ${rw.source.slice(first.getStart(rw.sf), first.getEnd())})`)
        return true
      }
    }
    return false
  }
  ensureAsync(rw, target)
  rw.replace(target, `(await ${rw.source.slice(target.getStart(rw.sf), target.getEnd())})`)
  return true
}

function cascade(errorsFile) {
  const errors = JSON.parse(fs.readFileSync(errorsFile, 'utf8'))
  const byFile = new Map()
  for (const e of errors) {
    if (!byFile.has(e.file)) byFile.set(e.file, [])
    byFile.get(e.file).push(e)
  }
  for (const [file, errs] of byFile) {
    const rw = new Rewriter(file)
    let changed = false
    for (const e of errs) if (wrapChainAwaitAt(rw, e.offset)) changed = true
    if (changed) {
      fs.writeFileSync(file, rw.apply())
      console.log('cascade', path.relative(process.cwd(), file))
    }
  }
}

const mode = process.argv[2]
if (mode === 'pass1') pass1()
else if (mode === 'pass1b') pass1(true)
else if (mode === 'cascade') cascade(process.argv[3])
else console.log('usage: codemod-drama2.mjs pass1 | cascade errors.json')
