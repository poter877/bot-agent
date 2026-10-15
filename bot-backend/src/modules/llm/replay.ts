import { z } from 'zod'
import { providerOptionsSchema } from './media.js'

/** SDK output calls this metadata; SDK prompt input calls it options. Keep
 * the provider namespaces and opaque values intact across that boundary. */
export const replayFields = {
  providerMetadata: providerOptionsSchema.optional(),
  providerOptions: providerOptionsSchema.optional(),
}

interface ReplayFields {
  providerMetadata?: z.infer<typeof providerOptionsSchema>
  providerOptions?: z.infer<typeof providerOptionsSchema>
}

export function withReplayOptions<T extends ReplayFields>(part: T): Omit<T, 'providerMetadata'> {
  const { providerMetadata, providerOptions, ...content } = part
  if (providerMetadata === undefined) return { ...content, ...(providerOptions === undefined ? {} : { providerOptions }) } as Omit<T, 'providerMetadata'>
  const options = { ...providerMetadata }
  for (const [provider, values] of Object.entries(providerOptions ?? {})) {
    options[provider] = { ...options[provider], ...values }
  }
  return { ...content, providerOptions: options } as Omit<T, 'providerMetadata'>
}
