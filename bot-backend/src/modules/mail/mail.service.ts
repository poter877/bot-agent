import { and, eq, lt, sql } from 'drizzle-orm'
import nodemailer from 'nodemailer'
import type { Db } from '../../db/client.js'
import { mailOutbox } from '../../db/schema.js'
import type { Config } from '../../config/env.js'
import type { Logger } from '../../shared/logger.js'

/**
 * Outbox-based mail delivery. Request paths only enqueue; a background worker
 * drains pending rows with bounded retries so verification / recovery mail
 * survives transient SMTP failures without blocking or retrying inside the
 * request. Send failures never mark an account verified.
 */

export interface MailTransport {
  send(input: { to: string; subject: string; bodyText: string }): Promise<void>
}

export class LogTransport implements MailTransport {
  constructor(private readonly logger: Logger) {}

  async send(input: { to: string; subject: string; bodyText: string }): Promise<void> {
    // Development transport only: the body (which carries the one-time link)
    // goes to the local log instead of a real mailbox. Production refuses to
    // boot with this transport selected.
    this.logger.info({ to: input.to, subject: input.subject }, `outbox[log-transport]: ${input.bodyText}`)
  }
}

export class SmtpTransport implements MailTransport {
  private readonly transporter: import('nodemailer').Transporter

  constructor(private readonly config: Config) {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
    })
  }

  async send(input: { to: string; subject: string; bodyText: string }): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.MAIL_FROM,
      to: input.to,
      subject: input.subject,
      text: input.bodyText,
    })
  }
}

export function createMailTransport(config: Config, logger: Logger): MailTransport {
  if (config.MAIL_TRANSPORT === 'smtp') {
    return new SmtpTransport(config)
  }
  return new LogTransport(logger)
}

export async function enqueueMail(
  db: Db,
  input: { to: string; subject: string; bodyText: string; purpose: string },
): Promise<void> {
  await db.insert(mailOutbox).values({
    toEmail: input.to,
    subject: input.subject,
    bodyText: input.bodyText,
    purpose: input.purpose,
  })
}

export class OutboxWorker {
  private timer: NodeJS.Timeout | null = null
  private running = false

  constructor(
    private readonly db: Db,
    private readonly transport: MailTransport,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.drainOnce()
    }, this.config.MAIL_OUTBOX_POLL_MS)
    this.timer.unref()
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    while (this.running) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  /**
   * Claiming is a single UPDATE ... RETURNING: concurrent instances (or a
   * concurrent drain on this one) serialize on the row, the second claimant
   * re-evaluates the predicate and sees the incremented attempts count, so
   * each pending mail is claimed by exactly one worker.
   */
  async drainOnce(): Promise<number> {
    if (this.running) return 0
    this.running = true
    try {
      const claimed = await this.db
        .update(mailOutbox)
        .set({ attempts: sql`${mailOutbox.attempts} + 1` })
        .where(and(eq(mailOutbox.status, 'pending'), lt(mailOutbox.attempts, this.config.MAIL_OUTBOX_MAX_ATTEMPTS)))
        .returning({
          id: mailOutbox.id,
          toEmail: mailOutbox.toEmail,
          subject: mailOutbox.subject,
          bodyText: mailOutbox.bodyText,
          attempts: mailOutbox.attempts,
        })

      for (const entry of claimed) {
        try {
          await this.transport.send({ to: entry.toEmail, subject: entry.subject, bodyText: entry.bodyText })
          await this.db
            .update(mailOutbox)
            .set({ status: 'sent', sentAt: new Date(), lastError: null })
            .where(eq(mailOutbox.id, entry.id))
        } catch (error) {
          const message = (error instanceof Error ? error.message : String(error)).slice(0, 500)
          const exhausted = entry.attempts >= this.config.MAIL_OUTBOX_MAX_ATTEMPTS
          await this.db
            .update(mailOutbox)
            .set(exhausted ? { status: 'failed', lastError: message } : { lastError: message })
            .where(eq(mailOutbox.id, entry.id))
          this.logger.warn({ request_id: entry.id, err: message }, 'mail_send_failed')
        }
      }
      return claimed.length
    } finally {
      this.running = false
    }
  }
}
