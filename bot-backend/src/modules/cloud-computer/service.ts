import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { asc, eq, lte } from 'drizzle-orm'
import type { Db, Tx } from '../../db/client.js'
import { cloudComputer, type CloudComputerRow } from '../../db/schema.js'
import type { AuthContext } from '../../shared/context.js'
import { HttpApiError } from '../../shared/http.js'
import { CLOUD_ACTIONS, type CloudAction, type CloudWorker } from './protocol.js'
import { clearedLease, expireLease, getComputer, updateComputer, withComputerLock } from './store.js'

export interface CloudAuthority {
  actor: 'agent' | 'human'
  computerGeneration: number
  leaseEpoch: number
  viewerToken?: string
}

export function cloudSnapshot(row?: CloudComputerRow, enabled = true) {
  return {
    enabled,
    computer: row ? {
      id: row.id, state: row.state, generation: row.generation, width: row.width, height: row.height,
      capabilities: { actions: [...CLOUD_ACTIONS], capture: true }, error: row.lastError,
    } : null,
    lease: {
      holder: row?.leaseExpiresAt && row.leaseExpiresAt.getTime() > Date.now() ? 'human' : 'agent',
      epoch: row?.leaseEpoch ?? 0,
      expiresAt: row?.leaseExpiresAt?.toISOString() ?? null,
    },
  }
}

const conflict = (message: string) => new HttpApiError(409, 'conflict', message)
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex')

function requireViewer(row: CloudComputerRow, auth: AuthContext, token?: string): void {
  if (!token || !row.leaseTokenHash || row.leaseSessionId !== auth.sessionId ||
    !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now() ||
    !timingSafeEqual(Buffer.from(tokenHash(token)), Buffer.from(row.leaseTokenHash))) {
    throw conflict('Your control lease is no longer valid. Take control again.')
  }
}

function requireAuthority(row: CloudComputerRow, auth: AuthContext, authority: CloudAuthority, input: boolean): void {
  if (row.state !== 'running' || row.desiredState !== 'running') throw conflict('Start the cloud computer first.')
  if (row.generation !== authority.computerGeneration || row.leaseEpoch !== authority.leaseEpoch) {
    throw conflict('The cloud computer or control owner changed. Refresh the screen before continuing.')
  }
  if (authority.actor === 'agent' && row.leaseTokenHash) throw conflict('The user has control of the cloud computer.')
  if (authority.actor === 'human' && input) requireViewer(row, auth, authority.viewerToken)
}

function validateCoordinates(action: CloudAction, row: CloudComputerRow): void {
  const p = action.params as Record<string, unknown>
  for (const key of ['x', 'fromX', 'toX']) {
    if (typeof p[key] === 'number' && p[key] >= row.width) throw new HttpApiError(400, 'validation_failed', 'The pointer is outside the screen.')
  }
  for (const key of ['y', 'fromY', 'toY']) {
    if (typeof p[key] === 'number' && p[key] >= row.height) throw new HttpApiError(400, 'validation_failed', 'The pointer is outside the screen.')
  }
}

export class CloudComputerService {
  constructor(private readonly db: Db, private readonly worker: CloudWorker) {}

  async status(auth: AuthContext) {
    const row = await getComputer(this.db, auth.userId)
    if (row?.leaseExpiresAt) {
      return this.locked(auth, async (_tx, current) => cloudSnapshot(current))
    }
    return cloudSnapshot(row)
  }

  async desired(auth: AuthContext, desiredState: 'running' | 'stopped') {
    return withComputerLock(this.db, auth.userId, async (tx) => {
      let row = await getComputer(tx, auth.userId)
      if (!row) {
        if (desiredState === 'stopped') return cloudSnapshot()
        row = (await tx.insert(cloudComputer).values({ id: randomUUID(), userId: auth.userId }).returning())[0]!
      }
      if (row.desiredState === desiredState && ['running', 'starting', 'stopped', 'stopping'].includes(row.state)) {
        return cloudSnapshot(await expireLease(tx, row))
      }
      row = await updateComputer(tx, row, {
        desiredState, state: desiredState === 'running' ? 'starting' : 'stopping', generation: row.generation + 1,
        ...clearedLease(row), lastError: null, reconcileAfter: new Date(),
      })
      return cloudSnapshot(row)
    })
  }

  private async locked<T>(auth: AuthContext, run: (tx: Tx, row: CloudComputerRow) => Promise<T>): Promise<T> {
    return withComputerLock(this.db, auth.userId, async (tx) => {
      const row = await getComputer(tx, auth.userId)
      if (!row) throw new HttpApiError(404, 'not_found', 'Create your cloud computer first.')
      return run(tx, await expireLease(tx, row))
    })
  }

  async capture(auth: AuthContext, authority: CloudAuthority) {
    return this.locked(auth, async (_tx, row) => {
      requireAuthority(row, auth, authority, false)
      const result = await this.worker.capture(auth.userId, row.id)
      if (result.image.width !== row.width || result.image.height !== row.height) throw conflict('The screen size changed. Refresh the cloud computer status.')
      return { ...result, computerGeneration: row.generation, leaseEpoch: row.leaseEpoch }
    })
  }

  async action(auth: AuthContext, authority: CloudAuthority, action: CloudAction) {
    return this.locked(auth, async (_tx, row) => {
      requireAuthority(row, auth, authority, true)
      validateCoordinates(action, row)
      await this.worker.action(auth.userId, row.id, action)
      return { ok: true, computerGeneration: row.generation, leaseEpoch: row.leaseEpoch }
    })
  }

  async acquire(auth: AuthContext) {
    return this.locked(auth, async (tx, row) => {
      if (row.state !== 'running' || row.desiredState !== 'running') throw conflict('Start the cloud computer first.')
      // The worker serializes by owner. This barrier also drains an old action
      // whose HTTP response was lost before handing input to a human.
      const actual = await this.worker.status(auth.userId, row.id)
      if (actual.state !== 'running') throw conflict('The cloud computer is no longer running. Refresh its status.')
      const viewerToken = randomBytes(32).toString('hex')
      const updated = await updateComputer(tx, row, {
        leaseEpoch: row.leaseEpoch + 1, leaseTokenHash: tokenHash(viewerToken), leaseSessionId: auth.sessionId,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      })
      return { ...cloudSnapshot(updated), viewerToken }
    })
  }

  async control(auth: AuthContext, viewerToken: string, release: boolean) {
    return this.locked(auth, async (tx, row) => {
      requireViewer(row, auth, viewerToken)
      const updated = await updateComputer(tx, row, release ? clearedLease(row) : { leaseExpiresAt: new Date(Date.now() + 60_000) })
      return cloudSnapshot(updated)
    })
  }

  /** Durable desired state is retried after process restarts; request handlers never boot Docker. */
  async reconcile(): Promise<void> {
    const rows = await this.db.select({ userId: cloudComputer.userId }).from(cloudComputer)
      .where(lte(cloudComputer.reconcileAfter, new Date())).orderBy(asc(cloudComputer.reconcileAfter)).limit(20)
    for (let index = 0; index < rows.length; index += 2) {
      await Promise.all(rows.slice(index, index + 2).map(({ userId }) => this.reconcileUser(userId)))
    }
  }

  private async reconcileUser(userId: string): Promise<void> {
    try {
      await withComputerLock(this.db, userId, async (tx) => {
        let row = await getComputer(tx, userId)
        if (!row || row.reconcileAfter.getTime() > Date.now()) return
        try {
          const actual = await this.worker.status(userId, row.id)
          if (row.desiredState === 'running' && actual.state !== 'running') {
            row = await updateComputer(tx, row, { generation: row.generation + 1, ...clearedLease(row) })
          }
          const result = row.desiredState === 'running'
            ? actual.state === 'running' ? actual : await this.worker.start(userId, row.id)
            : actual.state === 'running' ? await this.worker.stop(userId, row.id) : actual
          const expected = row.desiredState === 'running' ? result.state === 'running' : result.state !== 'running'
          if (!expected) throw conflict('The runtime did not reach its requested state.')
          await updateComputer(tx, row, {
            state: row.desiredState, lastError: null, width: result.width, height: result.height,
            reconcileAfter: new Date(Date.now() + 30_000),
          })
        } catch {
          await updateComputer(tx, row, {
            state: 'error', lastError: 'The cloud computer could not reach its requested state. Retry or contact support.',
            reconcileAfter: new Date(Date.now() + 30_000),
          })
        }
      })
    } catch (error) {
      // Another replica or a user operation owns this computer; the next tick retries it.
      if (!(error instanceof HttpApiError && error.status === 409)) throw error
    }
  }
}
