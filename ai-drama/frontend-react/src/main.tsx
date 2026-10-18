import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router/dom'
import { initI18n } from '@/shared/config/i18n'
import { AppProviders } from './app/providers'
import { router } from './app/router'
import { bootstrap } from './app/bootstrap'

import './app/styles/index.css'

initI18n()
bootstrap()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
)
