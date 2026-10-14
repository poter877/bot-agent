import { randomUUID } from 'node:crypto'
import { and, eq, isNull, lt, sql } from 'drizzle-orm'
import type { RedisClientType } from 'redis'
import type { Db } from '../../db/client.js'
import { users, verificationTokens } from '../../db/schema.js'
import type { Config } from '../../config/env.js'
import type { Logger } from '../../shared/logger.js'
import { HttpApiError } from '../../shared/http.js'
import { PasswordHasher } from './password.js'
import { signAccessToken, generateOpaqueToken, hashToken } from './tokens.js'
import { writeAudit } from './audit.js'
import {
  createSession,
  revokeAllUserSessions,
  revokeFamily,
  revokeSession,
  rotateSession,
} from '../sessions/sessions.service.js'
import { enqueueMail } from '../mail/mail.service.js'
import { publishRevocation } from '../../redis/events.js'

/**
 * Account business rules. Registration is ToC self-service with e-mail
 * verification; error paths use one neutral shape for register / forgot /
 * login misses so responses can never be used to enumerate accounts.
 * Request context (request id, ip, user agent) flows in explicitly — it is
 * audit metadata, never identity.
 */

export interface RequestContext {
  requestId: string
  ip: string
  userAgent: string | null
}

export interface AuthDependencies {
  db: Db
  config: Config
  hasher: PasswordHasher
  redis: RedisClientType
  logger: Logger
}

type VerificationPurpose = 'verify_email' | 'password_reset'

const ACCOUNT_DISABLED = 'account is disabled'
const NEUTRAL_ACCEPTED = 'If the address is eligible, a message has been sent.'

export class AuthService {
  constructor(private readonly deps: AuthDependencies) {}

  async register(
    input: { email: string; password: string; displayName?: string },
    ctx: RequestContext,
  ): Promise<{ accepted: true; message: string }> {
    const { db, config, hasher } = this.deps

    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1)
    if (existing.length > 0) {
      await writeAudit(db, {
        event: 'register_duplicate',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { emailHash: hashToken(input.email) },
      })
      // Same shape and status as the success path: no enumeration signal.
      return { accepted: true, message: NEUTRAL_ACCEPTED }
    }

    const passwordHash = await hasher.hash(input.password)
    const displayName = input.displayName ?? input.email.split('@')[0] ?? 'user'
    const inserted = await db
      .insert(users)
      .values({ email: input.email, passwordHash, displayName, status: 'pending_verification' })
      .returning({ id: users.id })
    const userId = inserted[0]!.id

    await this.issueVerificationToken(userId, 'verify_email', config.VERIFY_TOKEN_TTL_SECONDS, input.email)
    await writeAudit(db, {
      userId,
      event: 'register_success',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    })
    return { accepted: true, message: NEUTRAL_ACCEPTED }
  }

  async resendVerification(input: { email: string }, ctx: RequestContext): Promise<{ accepted: true; message: string }> {
    const { db, config } = this.deps
    const rows = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
    const user = rows[0]
    if (user && user.status === 'pending_verification') {
      await this.issueVerificationToken(user.id, 'verify_email', config.VERIFY_TOKEN_TTL_SECONDS, input.email)
      await writeAudit(db, {
        userId: user.id,
        event: 'verification_resent',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
    }
    return { accepted: true, message: NEUTRAL_ACCEPTED }
  }

  async verifyEmail(input: { token: string }, ctx: RequestContext): Promise<{ status: 'verified' }> {
    const { db } = this.deps
    const consumed = await this.consumeVerificationToken(input.token, 'verify_email')
    if (consumed === null) {
      await writeAudit(db, {
        event: 'verify_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      throw new HttpApiError(400, 'invalid_token', 'Verification token is invalid, expired, or already used.')
    }
    await db
      .update(users)
      .set({ status: 'active', emailVerifiedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(users.id, consumed.userId), eq(users.status, 'pending_verification')))
    await writeAudit(db, {
      userId: consumed.userId,
      event: 'verify_success',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    })
    return { status: 'verified' }
  }

  async login(
    input: { email: string; password: string; deviceId?: string; deviceLabel?: string },
    ctx: RequestContext,
  ): Promise<{
    accessToken: string
    refreshToken: string
    expiresInSeconds: number
    user: { id: string; email: string; displayName: string; status: string }
  }> {
    const { db, config, hasher } = this.deps
    const rows = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        passwordHash: users.passwordHash,
        status: users.status,
      })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
    const user = rows[0]

    const fail = async (reason: string, userId?: string): Promise<never> => {
      await writeAudit(db, {
        userId: userId ?? null,
        event: 'login_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { reason },
      })
      throw new HttpApiError(401, 'invalid_credentials', 'Invalid email or password.')
    }

    if (user === undefined) {
      // Equalize timing against the known-account path.
      await hasher.verifyDummy(input.password)
      return fail('unknown_account')
    }
    const passwordOk = await hasher.verify(user.passwordHash, input.password)
    if (!passwordOk) {
      return fail('bad_password', user.id)
    }
    if (user.status === 'disabled') {
      await writeAudit(db, {
        userId: user.id,
        event: 'login_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { reason: ACCOUNT_DISABLED },
      })
      throw new HttpApiError(403, 'account_disabled', 'This account cannot sign in.')
    }
    if (user.status === 'pending_verification') {
      await writeAudit(db, {
        userId: user.id,
        event: 'login_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { reason: 'account_not_verified' },
      })
      throw new HttpApiError(403, 'account_not_verified', 'Verify the account before signing in.')
    }

    const deviceId = input.deviceId ?? randomUUID()
    const session = await createSession(db, {
      userId: user.id,
      deviceId,
      deviceLabel: input.deviceLabel,
      ttlSeconds: config.REFRESH_TOKEN_TTL_SECONDS,
    })
    const access = await signAccessToken(
      { userId: user.id, sessionId: session.sessionId, deviceId },
      config,
    )
    await writeAudit(db, {
      userId: user.id,
      event: 'login_success',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      details: { sessionId: session.sessionId, deviceId },
    })
    return {
      accessToken: access.token,
      refreshToken: session.refreshToken,
      expiresInSeconds: access.expiresInSeconds,
      user: { id: user.id, email: user.email, displayName: user.displayName, status: user.status },
    }
  }

  async refresh(
    input: { refreshToken: string },
    ctx: RequestContext,
  ): Promise<{
    accessToken: string
    refreshToken: string
    expiresInSeconds: number
    user: { id: string; email: string; displayName: string; status: string }
  }> {
    const { db, config } = this.deps
    const result = await rotateSession(db, { rawRefreshToken: input.refreshToken, ttlSeconds: config.REFRESH_TOKEN_TTL_SECONDS })

    if (result.outcome === 'replay') {
      await writeAudit(db, {
        event: 'refresh_replayed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      throw new HttpApiError(401, 'invalid_token', 'Refresh token is invalid or expired.')
    }
    if (result.outcome === 'invalid') {
      await writeAudit(db, {
        event: 'refresh_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      throw new HttpApiError(401, 'invalid_token', 'Refresh token is invalid or expired.')
    }

    const issued = result.issued
    const rows = await db
      .select({ id: users.id, email: users.email, displayName: users.displayName, status: users.status })
      .from(users)
      .where(eq(users.id, issued.userId))
      .limit(1)
    const user = rows[0]
    if (user === undefined || user.status !== 'active') {
      // Account changed state after login: no new credentials leave the door.
      await revokeFamily(db, issued.familyId, 'account_state_changed')
      await writeAudit(db, {
        userId: issued.userId,
        event: 'refresh_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        details: { reason: user?.status ?? 'unknown_user' },
      })
      throw new HttpApiError(403, user?.status === 'disabled' ? 'account_disabled' : 'account_not_verified', 'Account is not permitted to sign in.')
    }

    const access = await signAccessToken(
      { userId: issued.userId, sessionId: issued.sessionId, deviceId: result.deviceId },
      config,
    )
    await writeAudit(db, {
      userId: issued.userId,
      event: 'refresh_success',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      details: { sessionId: issued.sessionId },
    })
    return {
      accessToken: access.token,
      refreshToken: issued.refreshToken,
      expiresInSeconds: access.expiresInSeconds,
      user: { id: user.id, email: user.email, displayName: user.displayName, status: user.status },
    }
  }

  async logout(
    identity: { userId: string; sessionId: string; deviceId: string },
    ctx: RequestContext,
  ): Promise<{ revoked: true }> {
    const { db, redis } = this.deps
    const revoked = await revokeSession(db, identity.sessionId, 'logout')
    if (revoked) {
      await publishRevocation(redis, { type: 'session_revoked', userId: identity.userId, sessionId: identity.sessionId, requestId: ctx.requestId })
    }
    await writeAudit(db, {
      userId: identity.userId,
      event: 'logout',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      details: { sessionId: identity.sessionId },
    })
    // Idempotent for the client even if the session was already gone.
    return { revoked: true }
  }

  async forgotPassword(input: { email: string }, ctx: RequestContext): Promise<{ accepted: true; message: string }> {
    const { db, config } = this.deps
    const rows = await db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.email, input.email))
      .limit(1)
    const user = rows[0]
    if (user && user.status !== 'disabled') {
      const rawToken = generateOpaqueToken()
      const expiresAt = new Date(Date.now() + config.RESET_TOKEN_TTL_SECONDS * 1000)
      await db.insert(verificationTokens).values({
        userId: user.id,
        purpose: 'password_reset',
        tokenHash: hashToken(rawToken),
        expiresAt,
      })
      const resetUrl = `${config.APP_BASE_URL}/reset-password?token=${rawToken}`
      await enqueueMail(db, {
        to: input.email,
        subject: 'Reset your password',
        purpose: 'password_reset',
        bodyText: [
          'A password reset was requested for your account.',
          `Open this one-time link within ${Math.round(config.RESET_TOKEN_TTL_SECONDS / 60)} minutes:`,
          resetUrl,
          'If you did not request this, ignore this message.',
        ].join('\n\n'),
      })
      await writeAudit(db, {
        userId: user.id,
        event: 'password_forgot_sent',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
    }
    return { accepted: true, message: NEUTRAL_ACCEPTED }
  }

  async resetPassword(
    input: { token: string; newPassword: string },
    ctx: RequestContext,
  ): Promise<{ status: 'password_reset' }> {
    const { db, config, hasher, redis } = this.deps
    const consumed = await this.consumeVerificationToken(input.token, 'password_reset')
    if (consumed === null) {
      await writeAudit(db, {
        event: 'password_reset_failed',
        requestId: ctx.requestId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      })
      throw new HttpApiError(400, 'invalid_token', 'Reset token is invalid, expired, or already used.')
    }
    const passwordHash = await hasher.hash(input.newPassword)
    // Presenting a valid reset token proves mailbox ownership: pending
    // accounts become verified as part of the reset.
    await db
      .update(users)
      .set({
        passwordHash,
        status: sql`CASE WHEN ${users.status} = 'pending_verification' THEN 'active'::account_status ELSE ${users.status} END`,
        emailVerifiedAt: sql`COALESCE(${users.emailVerifiedAt}, now())`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, consumed.userId))
    const revokedCount = await revokeAllUserSessions(db, consumed.userId, 'password_reset')
    await publishRevocation(redis, { type: 'password_reset', userId: consumed.userId, requestId: ctx.requestId })
    await writeAudit(db, {
      userId: consumed.userId,
      event: 'password_reset_success',
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      details: { revokedSessions: revokedCount },
    })
    return { status: 'password_reset' }
  }

  /**
   * One-shot token consumption in a single atomic UPDATE: concurrent uses of
   * the same token race on `used_at IS NULL` and only one wins.
   */
  private async consumeVerificationToken(
    rawToken: string,
    purpose: VerificationPurpose,
  ): Promise<{ userId: string } | null> {
    const { db, config } = this.deps
    const tokenHash = hashToken(rawToken)
    const consumed = await db
      .update(verificationTokens)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.usedAt),
          lt(sql`now()`, verificationTokens.expiresAt),
          lt(verificationTokens.attemptCount, config.MAX_TOKEN_VERIFY_ATTEMPTS),
        ),
      )
      .returning({ userId: verificationTokens.userId })
    const row = consumed[0]
    if (row !== undefined) {
      return { userId: row.userId }
    }
    // Record the failed attempt against a still-live row (expired / used /
    // over-limit states keep their audit trail without reopening the token).
    await db
      .update(verificationTokens)
      .set({ attemptCount: sql`${verificationTokens.attemptCount} + 1` })
      .where(
        and(
          eq(verificationTokens.tokenHash, tokenHash),
          eq(verificationTokens.purpose, purpose),
          isNull(verificationTokens.usedAt),
        ),
      )
    return null
  }

  private async issueVerificationToken(
    userId: string,
    purpose: VerificationPurpose,
    ttlSeconds: number,
    deliverTo: string,
  ): Promise<void> {
    const { db, config } = this.deps
    const rawToken = generateOpaqueToken()
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
    await db.insert(verificationTokens).values({
      userId,
      purpose,
      tokenHash: hashToken(rawToken),
      expiresAt,
    })
    if (purpose === 'verify_email') {
      const verifyUrl = `${config.APP_BASE_URL}/verify?token=${rawToken}`
      await enqueueMail(db, {
        to: deliverTo,
        subject: 'Verify your account',
        purpose,
        bodyText: [
          'Welcome! Confirm your address to activate the account.',
          `Open this one-time link within ${Math.round(ttlSeconds / 3600)} hours:`,
          verifyUrl,
        ].join('\n\n'),
      })
    }
  }
}
