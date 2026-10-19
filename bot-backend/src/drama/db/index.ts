/**
 * 视频工厂数据层 — PostgreSQL（复用 bot-backend 的 DATABASE_URL 与连接池）。
 *
 * 自 SQLite 迁移：表/列名与行值形状不变（时间戳仍为 text ISO 字符串），
 * 业务代码的查询改为异步 pg 形态（drizzle node-postgres）。DDL 走 bot-backend
 * 的 drizzle 迁移（0008_drama*.sql）；旧 SQLite 库的一次性导入见
 * scripts/migrate-drama-sqlite-to-pg.ts。
 */
import { drizzle } from 'drizzle-orm/node-postgres'
import * as schema from './schema.js'

/** 与宿主（bot-backend db/client.ts）共用同一连接池形态：独立池、同库。 */
export const db = drizzle(process.env.DATABASE_URL!, { schema })
export { schema }
export type DB = typeof db

/** pg 迁移后的插入 id：insert().values().returning() 的首行。 */
export function getInsertId<T extends { id: number }>(rows: T[] | undefined): number {
  const first = rows?.[0]
  if (!first || first.id === undefined || first.id === null) {
    throw new Error('pg insert did not return an id (missing .returning()?)')
  }
  return Number(first.id)
}
