import { useEffect, useState } from 'react'

/**
 * 门户壳：两个子应用的运行时切换入口。
 * 子前端地址解析序：构建时注入（生产）→ 运行时探测（开发）→ 同源相对路径。
 * 「打开新窗口」按钮给需要独立标签页/开发者工具的场景。
 */

declare const __PORTAL_DRAMA_URL__: string
declare const __PORTAL_DASHBOARD_URL__: string

const PROBE_PATHS: Record<string, string> = {
  drama: '/login',      // SPA 路由，任意路径返回 HTML
  dashboard: '/',       // FastAPI 首页
}

function resolveUrl(app: 'drama' | 'dashboard', devPort: number, buildInject: string): string {
  if (buildInject) return buildInject
  // 生产：同源反代路径（nginx /drama/ → bot-backend，/hermes/ → dashboard）
  // 开发：直连各 dev server 端口
  if (import.meta.env.DEV) return `http://localhost:${devPort}${PROBE_PATHS[app]}`
  return app === 'drama' ? '/drama/' : '/hermes/'
}

const APPS = [
  {
    id: 'drama' as const,
    label: '视频工厂',
    desc: 'ai-drama · 项目 / 分镜 / 制作',
    icon: '🎬',
    resolve: () => resolveUrl('drama', 30170, __PORTAL_DRAMA_URL__),
  },
  {
    id: 'dashboard' as const,
    label: 'Hermes',
    desc: 'gateway · 会话 / 文件 / 编排',
    icon: '🛰️',
    resolve: () => resolveUrl('dashboard', 30176, __PORTAL_DASHBOARD_URL__),
  },
]

export function App() {
  const [active, setActive] = useState<'drama' | 'dashboard'>(
    () => (sessionStorage.getItem('portal:app') as 'drama' | 'dashboard') || 'drama',
  )
  const [src, setSrc] = useState('')
  const [loading, setLoading] = useState(true)

  const app = APPS.find((a) => a.id === active)!

  useEffect(() => {
    sessionStorage.setItem('portal:app', active)
    setSrc(app.resolve())
    setLoading(true)
  }, [active, app])

  return (
    <div style={{ display: 'flex', height: '100vh' }}>
      <aside
        style={{
          width: 200,
          flexShrink: 0,
          borderRight: '1px solid #2a3448',
          background: '#10151f',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid #2a3448',
            fontWeight: 650,
            fontSize: 14,
          }}
        >
          bot-agent
        </div>
        <nav style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {APPS.map((a) => (
            <button
              key={a.id}
              onClick={() => setActive(a.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 13,
                fontWeight: a.id === active ? 550 : 400,
                color: a.id === active ? '#6f8ff5' : '#8b96ab',
                background: a.id === active ? 'rgba(111,143,245,0.08)' : 'transparent',
                transition: 'background 120ms',
              }}
            >
              <span style={{ fontSize: 16 }}>{a.icon}</span>
              <span>
                {a.label}
                <span style={{ display: 'block', fontSize: 11, opacity: 0.6 }}>{a.desc}</span>
              </span>
            </button>
          ))}
        </nav>
        <div style={{ marginTop: 'auto', padding: '12px 16px', borderTop: '1px solid #2a3448' }}>
          <a
            href={src || '#'}
            target="_blank"
            rel="noopener"
            style={{ color: '#5d6880', fontSize: 12, textDecoration: 'none' }}
          >
            ↗ 在新窗口打开
          </a>
        </div>
      </aside>
      <main style={{ flex: 1, position: 'relative' }}>
        {loading && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#5d6880',
              zIndex: 0,
            }}
          >
            <span
              style={{
                width: 20,
                height: 20,
                border: '2px solid #2a3448',
                borderTopColor: '#6f8ff5',
                borderRadius: '50%',
                animation: 'spin 0.8s linear infinite',
              }}
            />
          </div>
        )}
        <iframe
          key={active}
          src={src}
          title={app.label}
          onLoad={() => setLoading(false)}
          style={{
            width: '100%',
            height: '100%',
            border: 'none',
            position: 'relative',
            zIndex: 1,
            background: '#0b0f17',
          }}
        />
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </main>
    </div>
  )
}
