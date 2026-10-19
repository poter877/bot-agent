import { createBrowserRouter, redirect } from 'react-router'
import { ConsoleLayout } from '@/pages/ConsoleLayout'
import { LoginPage } from '@/pages/LoginPage'
import { StatusPage } from '@/pages/StatusPage'
import { UsersPage } from '@/pages/UsersPage'
import { UserDetailPage } from '@/pages/UserDetailPage'
import { ModelsPage } from '@/pages/ModelsPage'
import { RequestsPage } from '@/pages/RequestsPage'

/** 未登录（或非管理员）一律回登录页；登录态由后端 cookie 会话承载。 */
async function requireConsole() {
  try {
    const session = await fetch('/api/auth/get-session', { credentials: 'include' }).then((r) => r.json())
    const role = (session as { user?: { role?: string } } | null)?.user?.role
    if (role === 'admin') return null
  } catch {
    /* fallthrough */
  }
  return redirect('/login')
}

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      path: '/',
      element: <ConsoleLayout />,
      loader: requireConsole,
      children: [
        { index: true, element: <StatusPage /> },
        { path: 'users', element: <UsersPage /> },
        { path: 'users/:id', element: <UserDetailPage /> },
        { path: 'models', element: <ModelsPage /> },
          { path: 'requests', element: <RequestsPage /> },
      ],
    },
  ],
  // vite base='/console/'：生产同源挂在 /console，dev（30177）同样在 /console/ 下
  { basename: import.meta.env.BASE_URL.replace(/\/+$/, '') || '/' },
)
