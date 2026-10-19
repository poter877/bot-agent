import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { adminApi } from '@/lib/api'
import { Badge, Spinner, td, th } from './ui'

const FILTERS = [
  { value: '', label: '全部' },
  { value: 'complete', label: '完成' },
  { value: 'failed', label: '失败' },
  { value: 'rejected', label: '拦截' },
] as const

/** 模型网关请求日志（最近 200 条），用于失败排查。 */
export function RequestsPage() {
  const [status, setStatus] = useState('')
  const { data, isLoading } = useQuery({ queryKey: ['requests', status], queryFn: () => adminApi.requests(status), refetchInterval: 15_000 })

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[16px] font-semibold">请求日志</h1>
        <div className="flex gap-1.5">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              onClick={() => setStatus(f.value)}
              className={`rounded-lg border px-3 py-1.5 text-[12.5px] transition ${
                status === f.value ? 'border-brand/60 bg-brand/10 text-brand' : 'border-line text-content-muted hover:text-content'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <div className="overflow-hidden rounded-xl border border-line bg-ink-900/70">
        <table className="w-full">
          <thead className="bg-ink-850">
            <tr>
              <th className={th}>时间</th>
              <th className={th}>用户</th>
              <th className={th}>模型</th>
              <th className={th}>状态</th>
              <th className={th}>错误码</th>
              <th className={th}>Tokens</th>
              <th className={th}>耗时</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <tr><td className={td} colSpan={7}><Spinner /></td></tr>}
            {data?.map((row) => (
              <tr key={row.id} className="border-t border-line/60 hover:bg-white/[0.02]">
                <td className={`${td} whitespace-nowrap text-content-muted`}>{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                <td className={td}>{row.email ?? row.userId ?? '—'}</td>
                <td className={td}>{row.modelId ?? '—'}</td>
                <td className={td}>
                  {row.status === 'complete' ? <Badge tone="ok">完成</Badge> : row.status === 'failed' ? <Badge tone="bad">失败</Badge> : <Badge tone="warn">拦截</Badge>}
                </td>
                <td className={`${td} font-mono text-[12px] text-content-muted`}>{row.errorCode ?? '—'}</td>
                <td className={td}>{(row.inputTokens ?? 0) + (row.outputTokens ?? 0)}</td>
                <td className={td}>{row.latencyMs != null ? `${row.latencyMs} ms` : '—'}</td>
              </tr>
            ))}
            {data && data.length === 0 && (
              <tr><td className={`${td} text-content-muted`} colSpan={7}>暂无记录</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
