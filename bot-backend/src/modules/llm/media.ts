import { isIP } from 'node:net'
import { z } from 'zod'
import type { LanguageModel } from 'ai'
import { HttpApiError } from '../../shared/http.js'
import type { LlmStreamRequest } from './request.js'
import type { ProviderKey } from './providers.js'

export const providerOptionsSchema = z.record(z.string(), z.record(z.string(), z.json()))

function isPublicMediaUrl(raw: string): boolean {
  if (!URL.canParse(raw)) return false
  const url = new URL(raw)
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password &&
    isIP(hostname) === 0 && hostname.includes('.') &&
    !/(^|\.)(localhost|local|internal|test|invalid)$/.test(hostname)
}

// JSON carries strings; AI SDK 7 requires URL instances in tagged URL data.
const mediaUrl = z.url().refine(isPublicMediaUrl, 'Media URLs must use public HTTP(S) hostnames without credentials.')
  .transform((value) => new URL(value))

const inlineData = z.string().min(1).refine(
  (value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value),
  'Inline media must be padded base64, without a data URL prefix.',
)

export const filePartSchema = z.object({
  type: z.literal('file'),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*(?:\/(?:[a-z0-9][a-z0-9!#$&^_.+-]*|\*))?$/i)
    .transform((value) => value.toLowerCase().replace(/\/\*$/, '')),
  data: z.discriminatedUnion('type', [
    z.object({ type: z.literal('data'), data: inlineData }).strict(),
    z.object({ type: z.literal('url'), url: mediaUrl }).strict(),
  ]),
  filename: z.string().min(1).max(500).optional(),
  providerOptions: providerOptionsSchema.optional(),
}).strict()

type FilePart = z.infer<typeof filePartSchema>
interface LocatedFile { role: 'user' | 'assistant' | 'tool'; part: FilePart }

function filesOf(request: LlmStreamRequest): LocatedFile[] {
  const files: LocatedFile[] = []
  for (const message of request.messages) {
    if (typeof message.content === 'string') continue
    for (const part of message.content) {
      if (part.type === 'file') files.push({ role: message.role, part })
      if (part.type === 'tool-result' && part.output.type === 'content') {
        for (const item of part.output.value) {
          if (item.type === 'file') files.push({ role: 'tool', part: item })
        }
      }
    }
  }
  return files
}

/** Check known adapter gaps before SSE starts: SDK adapters can silently omit
 * assistant files or stringify URL-only tool results, which loses perception. */
export async function validateMedia(request: LlmStreamRequest, provider: ProviderKey, model: LanguageModel): Promise<void> {
  const files = filesOf(request)
  if (files.length === 0) return
  const supportedUrls = typeof model === 'object' ? await model.supportedUrls : {}
  for (const { role, part } of files) {
    if (part.mediaType.split('/')[0] === 'video' && provider !== 'google') {
      throw new HttpApiError(400, 'unsupported_media', 'The selected model provider does not accept native video input. Select a video-capable Google model.')
    }
    if (role === 'assistant' && provider !== 'google') {
      throw new HttpApiError(400, 'unsupported_media', 'The selected provider cannot replay assistant file parts; use a provider that supports this conversation format.')
    }
    if (part.data.type !== 'url') continue
    if (provider === 'google' && role !== 'user') {
      throw new HttpApiError(400, 'media_inline_required', 'Google assistant and tool files require inline base64 data.')
    }
    const mediaType = part.mediaType.toLowerCase()
    const direct = Object.entries(supportedUrls).some(([pattern, urls]) =>
      (pattern === '*' || pattern === '*/*' || pattern.toLowerCase() === mediaType || pattern.toLowerCase() === `${mediaType.split('/')[0]}/*`) &&
      urls.some((regex) => regex.test(part.data.type === 'url' ? part.data.url.toString() : '')),
    )
    if (!direct) {
      throw new HttpApiError(400, 'media_inline_required', 'The selected model cannot receive this media URL directly. Send inline base64 data.')
    }
  }
}

/** Never let prompt normalization turn a media URL into a backend fetch. */
export const directMediaOnly: NonNullable<Parameters<typeof import('ai').streamText>[0]['experimental_download']> = async (downloads) =>
  downloads.map(({ isUrlSupportedByModel }) => {
    if (!isUrlSupportedByModel) throw new Error('Media URL requires inline base64 data; backend downloads are disabled.')
    return null
  })
