/**
 * 项目启动台统一管理短剧与创意视频；各类型拥有独立工作页面。
 * episode 使用 studio 布局（全屏）；其余使用 default 布局（顶栏壳）。
 * 路由组件 lazy 分包；无效参数呈现明确错误态（各 Route 内部处理）。
 */
import { lazy } from 'react'
import { createBrowserRouter, redirect } from 'react-router'
import { DefaultLayout } from './layouts/DefaultLayout'
import { StudioLayout } from './layouts/StudioLayout'
import { RouteError } from './RouteError'
import { probeSession } from '@/shared/api/session'

const ProjectsRoute = lazy(() => import('@/routes/projects/ProjectsRoute'))
const SettingsRoute = lazy(() => import('@/routes/settings/SettingsRoute'))
const DramaDetailRoute = lazy(() => import('@/routes/drama/DramaDetailRoute'))
const EpisodeWorkbenchRoute = lazy(() => import('@/routes/episode/EpisodeWorkbenchRoute'))
const CreativeRoute = lazy(() => import('@/routes/creative/CreativeRoute'))
const FilmWorkbenchRoute = lazy(() => import('@/routes/film/FilmWorkbenchRoute'))
const LoginRoute = lazy(() => import('@/routes/login/LoginRoute'))


/** 登录模式守卫：会话探测失败/未登录 → /login；旧模式（未配置公司后端）直通。 */
async function requireSession() {
  const { mode, user } = await probeSession()
  if (mode === 'login' && !user) return redirect('/login')
  return null
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginRoute /> },
  {
    element: <DefaultLayout />,
    errorElement: <RouteError />,
    loader: requireSession,
    children: [
      { path: '/', element: <ProjectsRoute /> },
      { path: '/settings', element: <SettingsRoute /> },
      { path: '/drama/:id', element: <DramaDetailRoute /> },
      { path: '/creative/:id', element: <CreativeRoute /> },
      { path: '/film/:id', element: <FilmWorkbenchRoute /> },
    ],
  },
  {
    path: '/drama/:id/episode/:episodeNumber',
    element: <StudioLayout />,
    errorElement: <RouteError />,
    loader: requireSession,
    children: [{ index: true, element: <EpisodeWorkbenchRoute /> }],
  },
  { path: '*', element: <RouteError /> },
])
