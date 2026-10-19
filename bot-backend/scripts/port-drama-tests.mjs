/**
 * 把 tests/drama 的 SQLite 时代测试头换成 pg 模板库隔离：
 * - mkdtemp+SQLITE_PATH 块 → 从 bot_backend_test 克隆一次性库（schema 即刻可用）
 * - after 清理目录 → DROP DATABASE
 */
import fs from 'node:fs'
import path from 'node:path'

const dir = path.resolve('tests/drama')
const files = fs.readdirSync(dir).filter((f) => /\.(ts|mjs)$/.test(f) && f.includes('.test.'))
let n = 0
for (const name of files) {
  const full = path.join(dir, name)
  let t = fs.readFileSync(full, 'utf8')
  if (!t.includes('SQLITE_PATH')) continue
  const orig = t

  const header = [
    "import { Pool } from 'pg'",
    "const __base = process.env.DATABASE_URL",
    "if (!__base) throw new Error('tests need DATABASE_URL (point at the test cluster, e.g. bot_backend_test)')",
    'const __admin = new Pool({ connectionString: __base })',
    "const __dbName = 'drama_' + process.pid + '_' + (Date.now() % 1000000)",
    'await __admin.query(`CREATE DATABASE "${__dbName}" TEMPLATE bot_backend_test`)',
    'process.env.DATABASE_URL = __base.replace(/\\/[^/?]+$/, `/${__dbName}`)',
  ].join('\n')

  // 形态 A：directory + SQLITE_PATH + MYSQL_AUTO_IMPORT 三行
  t = t.replace(
    /const directory = await fs\.mkdtemp\([^\n]*\)\nprocess\.env\.SQLITE_PATH = [^\n]*\nprocess\.env\.MYSQL_AUTO_IMPORT = 'false'\n/,
    header + '\n',
  )
  // 形态 B：仅 SQLITE_PATH 行
  t = t.replace(/process\.env\.SQLITE_PATH = [^\n]*\n/, header + '\n')
  // 清理钩子
  t = t.replace(
    /after\(async \(\) => \{ await fs\.rm\(directory, \{ recursive: true, force: true \}\) \}\)/,
    'after(async () => { process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end() })',
  )
  t = t.replace(
    /after\(\(\) => \{ fs\.rmSync\(directory, \{ recursive: true, force: true \}\) \}\)/,
    'after(async () => { process.env.DATABASE_URL = __base; await __admin.query(`DROP DATABASE IF EXISTS "${__dbName}"`); await __admin.end() })',
  )

  if (t !== orig) {
    fs.writeFileSync(full, t)
    n++
    console.log('header:', name)
  }
}
console.log('rewritten:', n)
