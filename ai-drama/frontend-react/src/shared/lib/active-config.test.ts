import { expect, it } from 'vitest'

import type { AiConfig } from '@/entities/ai-config/model'

import { pickActiveConfig } from './active-config'

const row = (id: number, over: Partial<AiConfig> = {}): AiConfig => ({
  id,
  models: [],
  serviceType: 'text',
  provider: 'company',
  name: `row-${id}`,
  baseUrl: '',
  apiKey: '',
  endpoint: '',
  queryEndpoint: '',
  priority: 0,
  isDefault: false,
  isActive: true,
  temperature: null,
  createdAt: '',
  updatedAt: '',
  ...over
})

it('picks the highest-priority active row, tie-breaking by lowest id like the backend rankConfigs', () => {
  expect(pickActiveConfig([row(9), row(1), row(5)])?.id).toBe(1)
  expect(pickActiveConfig([row(1), row(7, { priority: 2 })])?.id).toBe(7)
})

it('ignores inactive rows entirely', () => {
  expect(pickActiveConfig([row(9, { isActive: false })])).toBeNull()
  expect(pickActiveConfig([row(3, { isActive: false }), row(8)])?.id).toBe(8)
})

it('returns null for an empty list', () => {
  expect(pickActiveConfig([])).toBeNull()
})
