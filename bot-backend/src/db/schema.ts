import { relations } from 'drizzle-orm'
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Account data lives only in PostgreSQL. Token columns store SHA-256 hashes —
 * raw verification / refresh tokens exist only in the response that carries
 * them to the client and inside the mail body being delivered.
 */

export const accountStatus = pgEnum('account_status', [
  'pending_verification',
  'active',
  'disabled',
])

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Normalized login identifier: trimmed, lowercased. */
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    status: accountStatus('status').notNull().default('pending_verification'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_uq').on(table.email)],
)

export const loginSessions = pgTable(
  'login_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    deviceId: text('device_id').notNull(),
    deviceLabel: text('device_label'),
    /** Rotation family: all sessions minted from one login share this id. */
    familyId: uuid('family_id').notNull(),
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    replacedBySessionId: uuid('replaced_by_session_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('login_sessions_refresh_hash_uq').on(table.refreshTokenHash),
    index('login_sessions_user_idx').on(table.userId),
    index('login_sessions_family_idx').on(table.familyId),
  ],
)

export const verificationPurpose = pgEnum('verification_purpose', [
  'verify_email',
  'password_reset',
])

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: verificationPurpose('purpose').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    attemptCount: integer('attempt_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('verification_tokens_hash_uq').on(table.tokenHash),
    index('verification_tokens_user_purpose_idx').on(table.userId, table.purpose),
  ],
)

export const authAudit = pgTable(
  'auth_audit',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    /** Null for events against unknown accounts (e.g. login miss). */
    userId: uuid('user_id'),
    event: text('event').notNull(),
    requestId: text('request_id'),
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Structured context. Must not contain passwords or raw tokens. */
    details: jsonb('details'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('auth_audit_user_created_idx').on(table.userId, table.createdAt)],
)

export const mailStatus = pgEnum('mail_status', ['pending', 'sent', 'failed'])

export const mailOutbox = pgTable(
  'mail_outbox',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    toEmail: text('to_email').notNull(),
    subject: text('subject').notNull(),
    bodyText: text('body_text').notNull(),
    purpose: text('purpose').notNull(),
    status: mailStatus('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
  },
  (table) => [index('mail_outbox_status_idx').on(table.status, table.createdAt)],
)

export const usersRelations = relations(users, ({ many }) => ({
  loginSessions: many(loginSessions),
  verificationTokens: many(verificationTokens),
}))

export const loginSessionsRelations = relations(loginSessions, ({ one }) => ({
  user: one(users, { fields: [loginSessions.userId], references: [users.id] }),
}))

export type User = typeof users.$inferSelect
export type LoginSession = typeof loginSessions.$inferSelect
export type VerificationToken = typeof verificationTokens.$inferSelect
export type MailOutboxEntry = typeof mailOutbox.$inferSelect
