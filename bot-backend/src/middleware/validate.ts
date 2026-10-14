import { zValidator } from '@hono/zod-validator'
import type { z } from 'zod'
import { HttpApiError } from '../shared/http.js'

/**
 * Shared Zod validation hook with a uniform 400 contract. DTO schemas are
 * strict objects: unknown fields are rejected, so a client cannot smuggle
 * `user_id`, `role` or `owner_id` past the validation layer. Use zValidator
 * inline in routes so `c.req.valid()` stays fully typed.
 */
export const validationHook: Parameters<typeof zValidator>[2] = (result) => {
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue?.path.length ? issue.path.join('.') : 'request'
    throw new HttpApiError(400, 'validation_failed', `Invalid request: ${where} ${issue?.message ?? 'is invalid'}.`)
  }
}

export type InferDto<Schema extends z.ZodType> = z.output<Schema>
