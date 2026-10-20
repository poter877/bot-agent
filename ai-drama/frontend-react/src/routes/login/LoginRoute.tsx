/**
 * 登录/注册页 — 账号体系在公司后端（bot-backend / Better Auth），
 * 经 /api/v1/auth/* 同源代理交互；成功后回到来源页（默认启动台）。
 */
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import brandLogo from '@/assets/brand-logo.png'

type Mode = 'signin' | 'signup'

export function LoginRoute() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [mode, setMode] = useState<Mode>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setError('')
    setBusy(true)
    try {
      const path = mode === 'signin' ? '/api/auth/sign-in/email' : '/api/auth/sign-up/email'
      const body = mode === 'signin'
        ? { email, password }
        : { email, password, name: email.split('@')[0] || '用户' }
      const res = await fetch(path, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as { message?: string; code?: number } | null
        const fallback = mode === 'signin' ? '登录失败：邮箱或密码不正确' : '注册失败：请检查邮箱与密码（至少 8 位）'
        throw new Error(payload?.message || fallback)
      }
      navigate('/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误，请稍后重试')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-app px-4">
      <div className="w-full max-w-[380px]">
        <div className="mb-8 flex flex-col items-center gap-2">
          <img src={brandLogo} alt="" className="h-11 w-11 rounded-xl object-contain" />
          <h1 className="text-lg font-bold text-content">{t('common.appName', '视频工厂')}</h1>
          <p className="text-[12.5px] text-content-muted">使用平台账号登录后继续</p>
        </div>
        <div className="mb-4 flex rounded-pill bg-sunken p-1">
          {([['signin', '登录'], ['signup', '注册']] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`flex-1 rounded-pill px-3 py-1.5 text-[13px] font-semibold transition-colors ${mode === value ? 'bg-elevated text-content shadow-[0_1px_4px_rgba(0,0,0,0.12)]' : 'text-content-muted'}`}
              onClick={() => { setMode(value); setError('') }}
            >
              {label}
            </button>
          ))}
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3.5 rounded-panel border border-outline bg-surface p-6 shadow-panel">
          {error && <div role="alert" className="rounded-panel border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[13px] text-danger">{error}</div>}
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">邮箱</span>
            <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoFocus />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-[550] text-content-secondary">密码{mode === 'signup' ? '（至少 8 位）' : ''}</span>
            <Input type="password" required minLength={mode === 'signup' ? 8 : undefined} autoComplete={mode === 'signin' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <Button type="submit" className="mt-1 w-full" disabled={busy}>
            {busy && <Loader2 size={13} className="animate-spin" />}
            {busy ? '提交中…' : mode === 'signin' ? '登录' : '注册并登录'}
          </Button>
          <p className="text-center text-micro leading-relaxed text-content-subtle">账号由平台管理后台统一管理；忘记密码请联系管理员。</p>
        </form>
      </div>
    </div>
  )
}

export default LoginRoute
