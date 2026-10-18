// @vitest-environment jsdom
import { creativeCatalogApi } from '@/entities/creative/catalog'
import { publicCreativeCatalog } from '../../../../backend/src/services/creative-catalog'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { dramaQueries } from '@/entities/drama/queries'
import { mapDrama } from '@/entities/drama/model'
import { qk } from '@/shared/api/query-keys'
import { initI18n } from '@/shared/config/i18n'
import { ProjectsPage } from './ProjectsPage'

vi.mock('@/shared/lib/tour', () => ({ autoTour: vi.fn(), startTour: vi.fn() }))

function Location() {
  return <output aria-label="当前路径">{useLocation().pathname}</output>
}

function renderProjects(projectType: 'drama' | 'creative' = 'drama') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(dramaQueries.list().queryKey, { items: [mapDrama({ id: 7, title: '审查测试项目', project_type: projectType, creative_category: projectType === 'creative' ? 'product' : null })], total: 1 })
  client.setQueryData(qk.stylePresets(false), [])
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter><ProjectsPage /><Location /></MemoryRouter>
    </QueryClientProvider>,
  )
  return screen.getByRole('button', { name: '打开项目 审查测试项目' })
}

beforeEach(async () => {
  vi.spyOn(creativeCatalogApi, 'list').mockResolvedValue(publicCreativeCatalog())
  await initI18n().changeLanguage('zh')
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Project card keyboard interactions', { timeout: 30_000 }, () => {
  it.each(['{Enter}', ' '])('opens a nested status menu with %s without navigating', async (key) => {
    const user = userEvent.setup()
    const card = renderProjects()
    within(card).getByRole('button', { name: '待开始' }).focus()
    await user.keyboard(key)

    expect(screen.getByLabelText('当前路径').textContent).toBe('/')
    expect(screen.getByRole('menu')).toBeTruthy()
  })

  it('opens a nested actions menu with Enter without navigating', async () => {
    const user = userEvent.setup()
    const card = renderProjects()
    within(card).getByRole('button', { name: '更多' }).focus()
    await user.keyboard('{Enter}')

    expect(screen.getByLabelText('当前路径').textContent).toBe('/')
    expect(screen.getByRole('menuitem', { name: '删除项目' })).toBeTruthy()
  })

  it.each(['{Enter}', ' '])('still opens the project when %s targets the card itself', async (key) => {
    const user = userEvent.setup()
    renderProjects().focus()
    await user.keyboard(key)

    expect(screen.getByLabelText('当前路径').textContent).toBe('/drama/7')
  })
})


describe('Creative project entry points', () => {
  it('opens creative cards with the keyboard in their independent workspace', async () => {
    const user = userEvent.setup()
    renderProjects('creative').focus()
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText('当前路径').textContent).toBe('/creative/7')
  })
  it('opens creative projects from the actions menu', async () => {
    const user = userEvent.setup()
    const card = renderProjects('creative')
    await user.click(within(card).getByRole('button', { name: '更多' }))
    await user.click(screen.getByRole('menuitem', { name: '打开项目' }))
    expect(screen.getByLabelText('当前路径').textContent).toBe('/creative/7')
  })
  it('filters project types without changing legacy drama defaults', async () => {
    const user = userEvent.setup()
    renderProjects('creative')
    await user.click(screen.getByRole('button', { name: '短剧项目' }))
    expect(screen.queryByRole('button', { name: '打开项目 审查测试项目' })).toBeNull()
    await user.click(screen.getByRole('button', { name: '创意视频' }))
    expect(screen.getByRole('button', { name: '打开项目 审查测试项目' })).toBeTruthy()
    expect(mapDrama({ id: 1 }).projectType).toBe('drama')
  })
})
