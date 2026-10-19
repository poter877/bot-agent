import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { adminApi, authSignIn, ApiError } from '@/lib/api'
import { Banner, btnPrimary, input } from './ui'

/** 登录 / 首启初始化（后端零管理员时自动切到初始化模式）。 */
export function LoginPage() {
  const navigate = useNavigate()
  const [mode, setMode] = useState<'login' | 'setup' | 'checking'>('checking')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    adminApi
      .bootstrap()
      .then((info) => setMode(info.initialized ? 'login' : 'setup'))
      .catch(() => setMode('login'))
  }, [])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      if (mode === 'setup') {
        await adminApi.setup({ email, password, confirm })
      } else {
        await authSignIn(email, password)
      }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '网络错误，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  if (mode === 'checking') {
    return <div className="flex min-h-screen items-center justify-center text-content-subtle">加载中…</div>
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[radial-gradient(ellipse_at_top,rgba(79,111,232,0.14),transparent_55%)] px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl border border-brand/40 bg-brand/10 text-[18px]">🛰️</div>
          <h1 className="text-[17px] font-semibold">运营管理台</h1>
          <p className="mt-1 text-[12.5px] text-content-muted">
            {mode === 'setup' ? '首次使用：创建第一个管理员账号' : 'bot-backend · 公司模型网关'}
          </p>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-4 rounded-2xl border border-line bg-ink-900/80 p-6 shadow-[0_8px_40px_rgba(0,0,0,0.35)]">
          {error && <Banner kind="err">{error}</Banner>}
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-content-muted">邮箱</span>
            <input className={input} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ops@company.com" autoFocus />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-[12px] font-medium text-content-muted">密码{mode === 'setup' ? '（至少 8 位）' : ''}</span>
            <input className={input} type="password" required minLength={mode === 'setup' ? 8 : undefined} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {mode === 'setup' && (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-content-muted">确认密码</span>
              <input className={input} type="password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
          )}
          <button type="submit" className={`${btnPrimary} mt-1 w-full py-2.5`} disabled={busy}>
            {busy ? '提交中…' : mode === 'setup' ? '创建管理员并进入后台' : '登录'}
          </button>
          {mode === 'setup' && (
            <p className="text-center text-[11.5px] leading-relaxed text-content-subtle">
              初始化完成后本向导自动关闭；后续账号与角色请在「用户」页管理。
            </p>
          )}
        </form>
      </div>
    </div>
  )
}
