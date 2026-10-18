/** Agent chat hook（旧 useAgent）：全局单飞锁 + toast；结果经 onDone 回调交给调用方刷新 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { agentChat } from '@/entities/ai-config/workspace-api'
import { toastError } from '@/shared/lib/errors'

export function useAgent() {
  const { t } = useTranslation()
  const [running, setRunning] = useState(false)
  const [runningType, setRunningType] = useState<string | null>(null)

  const run = useCallback(
    async (
      type: string,
      msg: string,
      dramaId: number,
      episodeId: number,
      onDone?: () => void,
      model?: string,
      configId?: number,
    ) => {
      if (running) {
        toast.warning(t('composables.agent.busy'))
        return
      }
      setRunning(true)
      setRunningType(type)
      try {
        await agentChat(type, {
          message: msg,
          drama_id: dramaId,
          episode_id: episodeId,
          model: model || undefined,
          config_id: configId || undefined,
        })
        toast.success(t('composables.agent.done'))
        onDone?.()
      } catch (err) {
        toastError(err)
      } finally {
        setRunning(false)
        setRunningType(null)
      }
    },
    [running, t],
  )

  return { running, runningType, run }
}
