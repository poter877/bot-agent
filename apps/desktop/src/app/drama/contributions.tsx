import { lazy, Suspense, useEffect } from 'react'

import { ROUTES_AREA, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import { registry } from '@/contrib/registry'

import { useDramaCopy } from './copy'

const Page = lazy(async () => ({ default: (await import('./page')).DramaPage }))

const renderPage = () => (
  <Suspense>
    <Page />
  </Suspense>
)

export function DramaContributions() {
  const t = useDramaCopy()

  useEffect(
    () =>
      registry.registerMany([
        {
          area: ROUTES_AREA,
          id: 'drama:page',
          data: { path: '/drama' },
          title: t.title,
          render: renderPage
        },
        {
          area: SIDEBAR_NAV_AREA,
          id: 'drama:nav',
          data: { path: '/drama', label: t.title, codicon: 'device-camera-video' } satisfies SidebarNavContribution
        }
      ]),
    [t.title]
  )

  return null
}
