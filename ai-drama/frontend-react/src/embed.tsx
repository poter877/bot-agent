/**
 * 桌面嵌入入口 — hermes 桌面 app 的「视频工厂」页直接挂载本应用的 React 树。
 *
 * 与独立 SPA（main.tsx）的差异：
 * - memory history：路由状态在内存中，不碰宿主的地址栏（宿主 own /drama 这一跳）
 * - Provider 栈以 embed 模式运行：不写 document.title（窗口标题归宿主管），
 *   桌面桥不存在时相关组件自动 no-op
 * - API 仍是同源相对路径（/api/v1、/api/auth、/static）：宿主 dev server
 *   将这些前缀代理到 bot-backend，cookie 落在宿主 origin 上
 *
 * 样式由宿主 import app/styles/index.css，本入口不重复引入。
 */
import { useMemo } from 'react'
import { createMemoryRouter, RouterProvider } from 'react-router'

import { AppProviders } from './app/providers'
import { buildRoutes } from './app/router'
import { bootstrap } from './app/bootstrap'
import { initI18n } from '@/shared/config/i18n'
import { setStudioHost, type StudioHost } from '@/shared/studio/host'

bootstrap()
initI18n()

export function DramaApp({ initialPath = '/', host }: { initialPath?: string; host?: StudioHost | null }) {
  // 宿主能力注入：嵌入模式业务/账号走宿主通道；null/undefined = 独立浏览器版。
  setStudioHost(host ?? null)
  const router = useMemo(
    () => createMemoryRouter(buildRoutes(), { initialEntries: [initialPath] }),
    [initialPath],
  )

  return (
    <AppProviders embed>
      <RouterProvider router={router} />
    </AppProviders>
  )
}
