// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mapDrama } from '@/entities/drama/model'
import { qk } from '@/shared/api/query-keys'
import { initI18n } from '@/shared/config/i18n'
import { DramaDetailPage } from './DramaDetailPage'

beforeEach(async () => { await initI18n().changeLanguage('zh') })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Asset card keyboard actions', { timeout: 30_000 }, () => {
  it.each(['characters', 'scenes', 'props'] as const)('uploads from a %s card without also opening its editor', async (resource) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(qk.dramaDetail(7), mapDrama({ id: 7, title: '素材交互样例', [resource]: [{ id: 8, name: '验证素材', location: '验证场景' }] }))
    const chooseFile = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {})
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={['/drama/7']}><Routes><Route path="/drama/:id" element={<DramaDetailPage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    await user.click(screen.getByRole('button', { name: /素材库/ }))
    screen.getByRole('button', { name: '上传' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(chooseFile).toHaveBeenCalledOnce()
  })
})
