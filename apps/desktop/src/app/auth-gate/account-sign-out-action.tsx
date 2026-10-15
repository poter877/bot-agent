import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { $accountAuth } from '@/store/account-auth'

import { signOutAccount } from './account-auth-lifecycle'

export function AccountSignOutAction() {
  const { t } = useI18n()
  const account = useStore($accountAuth)

  if (account.phase !== 'authenticated') { return null }

  return (
    <Button onClick={() => { void signOutAccount() }} size="sm" variant="ghost">
      {t.accountAuth.signOutAction}
    </Button>
  )
}
