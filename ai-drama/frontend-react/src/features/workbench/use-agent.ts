/** Agent chat hook（旧 useAgent）：全局单飞锁 + toast；结果经 onDone 回调交给调用方刷新。
 *  编排走桌面宿主 Agent 车道（runStudioTask）——服务端 /agent/:type/chat 代调已随
 *  HERMES_AGENT_* 退役删除；无宿主车道（独立浏览器）时明确提示需桌面 app。 */
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { toastError } from '@/shared/lib/errors'
import { runStudioTask } from '@/shared/studio/agent-task'

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
      _model?: string,
      _configId?: number,
    ) => {
      if (running) {
        toast.warning(t('composables.agent.busy'))
        return
      }
      const task = runStudioTask(type, `${msg}（dramaId=${dramaId}, episodeId=${episodeId}）`, {
        title: `视频工厂 · ${type} · ep${episodeId}`,
      })
      if (!task) {
        toast.warning('此操作需要桌面 app 中的 AI 会话（独立浏览器版不支持编排任务）')
        return
      }
      setRunning(true)
      setRunningType(type)
      try {
        await task.run
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
