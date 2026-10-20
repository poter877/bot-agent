import { type Codec, persistentAtom } from '@/lib/persisted'

/**
 * Where the video studio (ai-drama, served by bot-backend) answers. The
 * desktop talks to it as a plain web origin; dev and the trio stack both
 * expose bot-backend on localhost:30172, so that is the no-config default.
 */
export const DEFAULT_DRAMA_BASE_URL = 'http://localhost:30172'

// Machine-global on purpose: the studio's location is a property of this
// machine's deployment, not of a profile or connection, so it deliberately
// stays out of the profile-keyed storage families.
const BASE_URL_KEY = 'hermes.desktop.drama.baseUrl'

/** User input → web origin, or null when it isn't one. Prepends `http://` so
 *  a bare `host:port` still works, and strips any path — the SPA owns
 *  routing, the embedder only needs the origin. An input that already carries
 *  a NON-web scheme is refused, never repaired: prepending would let
 *  `ftp://host` parse as `http://ftp` (and a poisoned stored record steer the
 *  guest at an unintended origin). */
export function normalizeDramaBaseUrl(raw: string): null | string {
  const trimmed = raw.trim()

  if (!trimmed) {
    return null
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && !/^https?:\/\//i.test(trimmed)) {
    return null
  }

  const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`

  try {
    const url = new URL(candidate)

    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null
  } catch {
    return null
  }
}

const baseUrlCodec: Codec<string> = {
  // A stored value the normalizer rejects (hand-edited, an older shape) falls
  // back to the default instead of poisoning every guest src with it.
  decode: raw => normalizeDramaBaseUrl(raw) ?? DEFAULT_DRAMA_BASE_URL,
  encode: value => value
}

export const $dramaBaseUrl = persistentAtom(BASE_URL_KEY, DEFAULT_DRAMA_BASE_URL, baseUrlCodec)
