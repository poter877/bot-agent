import { Algorithm, hash, verify } from '@node-rs/argon2'
import { randomUUID } from 'node:crypto'
import type { Config } from '../../config/env.js'

/**
 * Argon2id password hashing with bounded, asynchronous execution: hashing and
 * verification run through a fixed-size semaphore so a burst of login or
 * registration traffic cannot exhaust memory/CPU and starve the event loop.
 * Parameters start at the OWASP minimum and are tuned on target hardware.
 */
export class PasswordHasher {
  private readonly semaphore: Semaphore
  private readonly memoryCost: number
  private readonly timeCost: number
  private readonly parallelism: number
  /** Precomputed hash used to equalize timing when the account does not exist. */
  private decoyHash: string

  private constructor(config: Config) {
    this.semaphore = new Semaphore(config.ARGON2_MAX_CONCURRENCY)
    this.memoryCost = config.ARGON2_MEMORY_KIB
    this.timeCost = config.ARGON2_TIME_COST
    this.parallelism = config.ARGON2_PARALLELISM
    this.decoyHash = ''
  }

  static async create(config: Config): Promise<PasswordHasher> {
    const hasher = new PasswordHasher(config)
    // Not derived from any user input; only its cost shape matters.
    hasher.decoyHash = await hasher.hashRaw(randomUUID())
    return hasher
  }

  async hash(password: string): Promise<string> {
    return this.semaphore.run(() => this.hashRaw(password))
  }

  async verify(passwordHash: string, password: string): Promise<boolean> {
    return this.semaphore.run(async () => {
      try {
        return await verify(passwordHash, password)
      } catch {
        return false
      }
    })
  }

  /** Constant-shape verification path for unknown accounts. */
  async verifyDummy(password: string): Promise<false> {
    await this.verify(this.decoyHash, password)
    return false
  }

  private async hashRaw(password: string): Promise<string> {
    return hash(password, {
      algorithm: Algorithm.Argon2id,
      memoryCost: this.memoryCost,
      timeCost: this.timeCost,
      parallelism: this.parallelism,
    })
  }
}

class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve))
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.queue.shift()?.()
    }
  }
}
