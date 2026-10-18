/**
 * 全局 Provider 组合：QueryClient（应用生命周期内稳定创建一次）、
 * sonner Toaster（跟随主题）、迁移遮罩、桌面桥订阅、语言切换确认宿主、文档标题。
 */
import { useMemo, useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'sonner'
import { useTranslation } from 'react-i18next'
import { useTheme } from '@/shared/config/theme'
import { DesktopBootstrap } from '@/features/desktop-operations/DesktopBootstrap'
import { MigrationOverlay } from '@/features/desktop-operations/MigrationOverlay'
import { LanguageSwitchHost } from '@/features/preferences/LanguageSwitchHost'

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // 本地后端：不被 navigator.onLine 阻断；AI 上游不可达仍由后端反馈
        networkMode: 'always',
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        // 写请求不自动重试，避免重复受理生成任务
        networkMode: 'always',
        retry: false,
      },
    },
  })
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  const { resolvedTheme } = useTheme()
  const queryClient = useMemo(createQueryClient, [])

  // 响应式文档标题
  useEffect(() => {
    document.title = t('app.title')
  }, [t])

  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster position="top-right" duration={3000} theme={resolvedTheme} />
      <MigrationOverlay />
      <LanguageSwitchHost />
      <DesktopBootstrap />
    </QueryClientProvider>
  )
}
