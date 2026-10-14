import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export interface Database {
  pool: Pool
  db: NodePgDatabase<typeof schema>
}

export interface CreateDatabaseOptions {
  connectionString: string
  /** Bound to the request processing budget so queries cannot outlive it. */
  statementTimeoutMs: number
  maxConnections?: number
}

export function createDatabase(options: CreateDatabaseOptions): Database {
  const pool = new Pool({
    connectionString: options.connectionString,
    max: options.maxConnections ?? 10,
    statement_timeout: options.statementTimeoutMs,
    idleTimeoutMillis: 30_000,
    application_name: 'bot-backend',
  })
  const db = drizzle(pool, { schema })
  return { pool, db }
}

export type Db = Database['db']
/** Transaction handle, structurally derived so services can accept either. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0]
export type DbExecutor = Db | Tx

export async function closeDatabase(database: Database): Promise<void> {
  await database.pool.end()
}

/** Authoritative readiness probe: SELECT 1 against the account store. */
export async function checkDatabase(database: Database): Promise<boolean> {
  const result = await database.pool.query('SELECT 1')
  return result.rowCount === 1
}
