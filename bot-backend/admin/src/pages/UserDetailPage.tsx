import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi } from '@/lib/api'
import { Badge, Banner, btnPrimary, Card, Field, input, Spinner, td, th } from './ui'

/** 用户详情：资料、额度（每日 token / 并发 / 模型白名单）与近期请求。 */
export function UserDetailPage() {
  const { id = '' } = useParams()
  const queryClient = useQueryClient()
  const { data, isLoading, isError } = useQuery({ queryKey: ['user', id], queryFn: () => adminApi.userDetail(id) })
  const [dailyTokenLimit, setDailyTokenLimit] = useState('')
  const [concurrencyLimit, setConcurrencyLimit] = useState('')
  const [modelAllowlist, setModelAllowlist] = useState('')
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!data) return
    setDailyTokenLimit(data.quota?.dailyTokenLimit?.toString() ?? '')
    setConcurrencyLimit(data.quota?.concurrencyLimit?.toString() ?? '')
    try {
      setModelAllowlist(data.quota?.modelAllowlist ? JSON.parse(data.quota.modelAllowlist).join(', ') : '')
    } catch {
      setModelAllowlist('')
    }
  }, [data])

  const save = useMutation({
    mutationFn: () => adminApi.saveQuota(id, { dailyTokenLimit, concurrencyLimit, modelAllowlist }),
    onSuccess: () => {
      setSaved(true)
      setError('')
      void queryClient.invalidateQueries({ queryKey: ['user', id] })
    },
    onError: (err) => setError(err.message),
  })

  if (isLoading) return <Spinner />
  if (isError || !data) return <div className="text-content-muted">用户不存在或加载失败。</div>
  const { user: profile } = data

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3 text-[13px] text-content-muted">
        <Link to="/users" className="hover:text-brand">← 返回用户列表</Link>
      </div>
      <div className="flex items-center gap-4">
        <h1 className="text-[16px] font-semibold">{profile.email}</h1>
        {profile.role === 'admin' ? <Badge tone="ok">管理员</Badge> : <Badge tone="off">用户</Badge>}
        {profile.banned && <Badge tone="bad">已停用</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-5">
        <Card title="资料">
          <dl className="grid grid-cols-[120px_1fr] gap-y-2.5 text-[13px]">
            <dt className="text-content-muted">名称</dt><dd>{profile.name}</dd>
            <dt className="text-content-muted">注册时间</dt><dd>{new Date(profile.createdAt).toLocaleString('zh-CN', { hour12: false })}</dd>
            <dt className="text-content-muted">今日 Token</dt><dd>{data.todayTokens.toLocaleString()}</dd>
            {profile.banReason && (<><dt className="text-content-muted">停用原因</dt><dd className="text-red-300">{profile.banReason}</dd></>)}
          </dl>
        </Card>
        <Card title="额度限制">
          <form
            className="flex flex-col gap-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              setSaved(false)
              save.mutate()
            }}
          >
            {error && <Banner kind="err">{error}</Banner>}
            {saved && <Banner kind="ok">额度已保存（15 秒内对全部实例生效）</Banner>}
            <Field label="每日 Token 上限" hint="留空表示不限制">
              <input className={input} type="number" min={0} value={dailyTokenLimit} onChange={(e) => setDailyTokenLimit(e.target.value)} placeholder="不限" />
            </Field>
            <Field label="并发上限" hint="留空使用默认值">
              <input className={input} type="number" min={1} value={concurrencyLimit} onChange={(e) => setConcurrencyLimit(e.target.value)} placeholder="默认" />
            </Field>
            <Field label="模型白名单" hint="逗号分隔的目录 id；留空表示不限制">
              <input className={input} value={modelAllowlist} onChange={(e) => setModelAllowlist(e.target.value)} placeholder="glm-4.7, kimi-k2" />
            </Field>
            <button type="submit" className={`${btnPrimary} w-fit`} disabled={save.isPending}>
              {save.isPending ? '保存中…' : '保存额度'}
            </button>
          </form>
        </Card>
      </div>
      <Card title="近期请求（最近 20 条）">
        <table className="w-full">
          <thead className="bg-ink-850">
            <tr>
              <th className={th}>时间</th>
              <th className={th}>路由</th>
              <th className={th}>模型</th>
              <th className={th}>状态</th>
              <th className={th}>Tokens</th>
              <th className={th}>耗时</th>
            </tr>
          </thead>
          <tbody>
            {data.requests.map((row) => (
              <tr key={row.id} className="border-t border-line/60">
                <td className={`${td} text-content-muted`}>{new Date(row.createdAt).toLocaleString('zh-CN', { hour12: false })}</td>
                <td className={td}>{row.route}</td>
                <td className={td}>{row.modelId ?? '—'}</td>
                <td className={td}>
                  {row.status === 'complete' ? <Badge tone="ok">完成</Badge> : row.status === 'failed' ? <Badge tone="bad">失败</Badge> : <Badge tone="warn">拦截</Badge>}
                </td>
                <td className={td}>{(row.inputTokens ?? 0) + (row.outputTokens ?? 0)}</td>
                <td className={td}>{row.latencyMs != null ? `${row.latencyMs} ms` : '—'}</td>
              </tr>
            ))}
            {data.requests.length === 0 && (
              <tr><td className={`${td} text-content-muted`} colSpan={6}>暂无请求记录</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
