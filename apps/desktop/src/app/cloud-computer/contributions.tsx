import { lazy, Suspense, useEffect } from 'react'

import { ROUTES_AREA, SIDEBAR_NAV_AREA, type SidebarNavContribution } from '@/app/routes'
import { registry } from '@/contrib/registry'

import { useCloudComputerCopy } from './copy'

const Page = lazy(async () => ({ default: (await import('./page')).CloudComputerPage }))

const renderPage = () => (
  <Suspense>
    <Page />
  </Suspense>
)

export function CloudComputerContributions() {
  const t = useCloudComputerCopy()

  useEffect(
    () =>
      registry.registerMany([
        {
          area: ROUTES_AREA,
          id: 'cloud-computer:page',
          data: { path: '/cloud-computer' },
          title: t.title,
          render: renderPage
        },
        {
          area: SIDEBAR_NAV_AREA,
          id: 'cloud-computer:nav',
          data: { path: '/cloud-computer', label: t.title, codicon: 'vm' } satisfies SidebarNavContribution
        }
      ]),
    [t.title]
  )

  return null
}
