import { expect, it, vi } from 'vitest'

import { readKey } from '@/lib/storage'

import { $dramaBaseUrl, DEFAULT_DRAMA_BASE_URL, normalizeDramaBaseUrl } from './url'

const KEY = 'hermes.desktop.drama.baseUrl'

it('prepends http:// to a bare host:port and strips any path', () => {
  expect(normalizeDramaBaseUrl('localhost:30172')).toBe('http://localhost:30172')
  expect(normalizeDramaBaseUrl('  bot-backend.internal:30172/drama/  ')).toBe('http://bot-backend.internal:30172')
})

it('keeps an explicit scheme and origin only', () => {
  expect(normalizeDramaBaseUrl('https://studio.example.com/#/projects')).toBe('https://studio.example.com')
})

it('rejects everything that is not an http(s) origin', () => {
  expect(normalizeDramaBaseUrl('')).toBeNull()
  expect(normalizeDramaBaseUrl('   ')).toBeNull()
  expect(normalizeDramaBaseUrl('not a url')).toBeNull()
  // A non-web scheme is refused, not repaired: prepending would parse
  // `ftp://host` as `http://ftp`.
  expect(normalizeDramaBaseUrl('ftp://localhost')).toBeNull()
  expect(normalizeDramaBaseUrl('http://')).toBeNull()
})

it('persists a saved origin', () => {
  localStorage.clear()
  $dramaBaseUrl.set('http://bot-backend.internal:30172')

  expect(readKey(KEY)).toBe('http://bot-backend.internal:30172')
})

it('seeds from a poisoned record as the default, never as the poison', async () => {
  localStorage.clear()
  localStorage.setItem(KEY, 'file:///etc')
  vi.resetModules()

  const fresh = await import('./url')

  expect(fresh.$dramaBaseUrl.get()).toBe(DEFAULT_DRAMA_BASE_URL)
})
