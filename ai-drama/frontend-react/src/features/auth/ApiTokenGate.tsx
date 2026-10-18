/**
 * API 令牌门 — 服务端配置了 AI_DRAMA_API_TOKEN（或部署面仅允许回环而来源非回环）时，
 * 任意 /api/v1 请求 401 → client.ts 广播 huobao:api-unauthorized → 本组件弹窗：
 * 输入一次令牌存 localStorage（shared/api/token.ts），此后请求统一带 Bearer 头。
 * 保存后整页刷新：react-query 缓存与失败请求全部按新令牌重发，无需逐个重试。
 */
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { KeyRound } from 'lucide-react'
import { Modal } from '@/shared/ui/Modal'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { getApiToken, setApiToken } from '@/shared/api/token'

export function ApiTokenGate() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')

  useEffect(() => {
    const onUnauthorized = () => {
      // 回填已存令牌：输错时可见可改，不必从零输入
      setToken(getApiToken())
      setOpen(true)
    }
    window.addEventListener('huobao:api-unauthorized', onUnauthorized)
    return () => window.removeEventListener('huobao:api-unauthorized', onUnauthorized)
  }, [])

  const save = () => {
    const value = token.trim()
    if (!value) return
    setApiToken(value)
    globalThis.location.reload()
  }

  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      overlayClosable={false}
      title={t('auth.tokenTitle')}
      icon={<KeyRound size={18} className="text-brand-content" aria-hidden />}
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-content-muted">{t('auth.tokenHint')}</p>
        <form
          className="flex gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            save()
          }}
        >
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('auth.tokenPlaceholder')}
            type="password"
            autoFocus
            autoComplete="off"
          />
          <Button type="submit" variant="primary" disabled={!token.trim()}>
            {t('auth.tokenSave')}
          </Button>
        </form>
      </div>
    </Modal>
  )
}
