/**
 * 视频工厂存量数据一次性导入：SQLite（ai-drama/data/huobao.sqlite3）→ PostgreSQL。
 *
 * 表/列名两侧一致（pg schema 自 sqlite 迁移保名）；时间戳两侧均为 text ISO。
 * 逐表全量插入（ON CONFLICT DO NOTHING），跳过空表；结束打印每表行数。
 * 用法：cd bot-backend && npx tsx scripts/migrate-drama-sqlite-to-pg.ts [sqlite路径]
 */
import Database from 'better-sqlite3'
import { Pool } from 'pg'
import fs from 'node:fs'
import path from 'node:path'

const sqlitePath = process.argv[2] || path.resolve(process.cwd(), '../ai-drama/data/huobao.sqlite3')
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite 文件不存在：${sqlitePath}`)
  process.exit(1)
}

const sqlite = new Database(sqlitePath, { readonly: true })
const pg = new Pool({ connectionString: process.env.DATABASE_URL })

const tables = sqlite
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as Array<{ name: string }>

const imported: Array<[string, number]> = []
for (const { name } of tables) {
  const rows = sqlite.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>
  if (rows.length === 0) continue
  const cols = Object.keys(rows[0]!)
  const colList = cols.map((c) => `"${c}"`).join(', ')
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ')
  const client = await pg.connect()
  try {
    await client.query('BEGIN')
    // 一次性导入工具：挂起 FK 触发器以任意顺序搬表（replica 角色跳过触发器）
    await client.query("SET session_replication_role = replica")
    for (const row of rows) {
      const values = cols.map((c) => {
        const v = row[c]
        return typeof v === 'boolean' ? (v ? 1 : 0) : v // pg 侧 boolean 列由 pg 客户端自适应
      })
      await client.query(
        `INSERT INTO "${name}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values,
      )
    }
    await client.query('COMMIT')
    imported.push([name, rows.length])
  } catch (err) {
    await client.query('ROLLBACK')
    console.warn(`表 ${name} 导入失败（跳过）：${(err as Error).message}`)
  } finally {
    client.release()
  }
}

console.log('导入完成：')
for (const [name, n] of imported) console.log(`  ${name}: ${n} 行`)
await pg.end()
sqlite.close()
