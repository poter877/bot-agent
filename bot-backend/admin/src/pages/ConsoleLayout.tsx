import { NavLink, Outlet, useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'

const NAV = [
  { to: '/', label: '状态', end: true },
  { to: '/users', label: '用户' },
  { to: '/models', label: '模型' },
  { to: '/requests', label: '请求' },
]

export function ConsoleLayout() {
  const navigate = useNavigate()
  const session = useQuery({
    queryKey: ['console-session'],
    queryFn: () => fetch('/api/auth/get-session', { credentials: 'include' }).then((r) => r.json()) as Promise<{ user?: { email?: string } } | null>,
    staleTime: 60_000,
  })

  async function signOut() {
    await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' }).catch(() => null)
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex min-h-screen">
      <aside className="fixed inset-y-0 left-0 flex w-[200px] flex-col border-r border-line bg-ink-900">
        <div className="flex h-[56px] items-center gap-2.5 border-b border-line px-5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-brand/40 bg-brand/10 text-[13px]">🛰️</span>
          <span className="text-[13.5px] font-semibold">运营管理台</span>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 p-3">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={'end' in item && item.end}
              className={({ isActive }) =>
                `rounded-lg px-3 py-2 text-[13px] transition ${isActive ? 'bg-brand/12 font-medium text-brand' : 'text-content-muted hover:bg-white/5 hover:text-content'}`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-line p-3">
          <div className="truncate px-3 text-[12px] text-content-muted">{session.data?.user?.email ?? '…'}</div>
          <button onClick={signOut} className="mt-2 w-full rounded-lg px-3 py-1.5 text-left text-[12.5px] text-content-muted transition hover:bg-white/5 hover:text-content">
            退出登录
          </button>
        </div>
      </aside>
      <main className="ml-[200px] flex-1 px-7 py-6">
        <Outlet />
      </main>
    </div>
  )
}
