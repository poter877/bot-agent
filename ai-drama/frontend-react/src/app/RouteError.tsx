/** 路由级错误边界与 404：无效参数/深链接刷新不白屏 */
import { useTranslation } from 'react-i18next'
import { useRouteError, useNavigate } from 'react-router'
import { Button } from '@/shared/ui/button'

export function RouteError() {
  const { t } = useTranslation()
  const error = useRouteError()
  const navigate = useNavigate()
  const message = error instanceof Error && error.message ? error.message : t('errors.unknown')

  return (
    <div className="flex h-full items-center justify-center overflow-auto">
      <div className="flex flex-col items-center gap-2.5 p-8 text-center">
        <div className="text-[40px] font-extrabold text-content-subtle">:(</div>
        <h1 className="text-lg text-content">{t('routeError.title')}</h1>
        <p className="max-w-[420px] text-[13px] break-words text-content-muted">{message}</p>
        <Button variant="primary" onClick={() => navigate('/')}>
          {t('routeError.backHome')}
        </Button>
      </div>
    </div>
  )
}
