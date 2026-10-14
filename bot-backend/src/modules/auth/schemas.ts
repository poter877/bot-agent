import { z } from 'zod'

/**
 * Strict DTOs: unknown fields are rejected so a client cannot smuggle
 * `user_id`, `role` or `owner_id` past validation. Identity is never taken
 * from the body — only from the verified auth context.
 */

export const emailField = z.string().trim().toLowerCase().max(254).pipe(z.email())

/** Length-first policy (OWASP); composition rules are deliberately absent. */
export const passwordField = z.string().min(10, 'password must be at least 10 characters').max(128)

export const tokenField = z.string().min(20).max(200)

export const registerSchema = z
  .strictObject({
    email: emailField,
    password: passwordField,
    displayName: z.string().trim().min(1).max(64).optional(),
  })
  .brand<'registerDto'>()

export const verifySchema = z.strictObject({ token: tokenField })

export const resendVerificationSchema = z.strictObject({ email: emailField })

export const loginSchema = z
  .strictObject({
    email: emailField,
    password: passwordField,
    deviceId: z.string().uuid().optional(),
    deviceLabel: z.string().trim().min(1).max(100).optional(),
  })
  .brand<'loginDto'>()

export const refreshSchema = z.strictObject({ refreshToken: tokenField })

export const forgotPasswordSchema = z.strictObject({ email: emailField })

export const resetPasswordSchema = z.strictObject({ token: tokenField, newPassword: passwordField })

export type RegisterDto = z.infer<typeof registerSchema>
export type LoginDto = z.infer<typeof loginSchema>
