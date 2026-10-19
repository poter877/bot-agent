import { useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { adminApi, type UserRow } from '@/lib/api'
import { Badge, Banner, btn, btnDanger, input, Spinner, td, th } from './ui'

function fmtDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false })
}

export function UsersPage() {
  const queryClient = useQueryClient()
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const { data, isLoading } = useQuery({ queryKey: ['users', query], queryFn: () => adminApi.users(query) })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['users'] })
  const roleMutation = useMutation({
    mutationFn: ({ id, role }: { id: string; role: 'admin' | 'user' }) => adminApi.setUserRole(id, role),
    onSuccess: invalidate,
    onError: (err) => setError(err.message),
  })
  const banMutation = useMutation({
    mutationFn: ({ id, banned }: { id: string; banned: boolean }) => (banned ? adminApi.unbanUser(id) : adminApi.banUser(id)),
    onSuccess: invalidate,
    onError: (err) => setError(err.message),
  })

  function toggleRole(row: UserRow) {
    const next: 'admin' | 'user' = row.role === 'admin' ? 'user' : 'admin'
    const word = next === 'admin' ? '提升为管理员' : '降级为普通用户'
    if (window.confirm(`确认将 ${row.email} ${word}？`)) roleMutation.mutate({ id: row.id, role: next })
  }

  function toggleBan(row: UserRow) {
    const word = row.banned ? '启用' : '停用（其全部会话将立即吊销）'
    if (window.confirm(`确认${word} ${row.email}？`)) banMutation.mutate({ id: row.id, banned: row.banned })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-[16px] font-semibold">用户</h1>
        <input className={`${input} w-[260px]`} placeholder="搜索邮箱或名称…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {error && <Banner kind="err">{error}</Banner>}
      <div className="overflow-hidden rounded-xl border border-line bg-ink-900/70">
        <table className="w-full">
          <thead className="bg-ink-850">
            <tr>
              <th className={th}>邮箱</th>
              <th className={th}>名称</th>
              <th className={th}>角色</th>
              <th className={th}>状态</th>
              <th className={th}>注册时间</th>
              <th className={th}>操作</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr><td className={td} colSpan={6}><Spinner /></td></tr>
            )}
            {data?.map((row) => (
              <tr key={row.id} className="border-t border-line/60 hover:bg-white/[0.02]">
                <td className={td}>
                  <Link to={`/users/${row.id}`} className="text-brand hover:underline">{row.email}</Link>
                </td>
                <td className={td}>{row.name}</td>
                <td className={td}>{row.role === 'admin' ? <Badge tone="ok">管理员</Badge> : <Badge tone="off">用户</Badge>}</td>
                <td className={td}>{row.banned ? <Badge tone="bad">已停用</Badge> : <Badge tone="ok">正常</Badge>}</td>
                <td className={`${td} text-content-muted`}>{fmtDate(row.createdAt)}</td>
                <td className={td}>
                  <div className="flex gap-2">
                    <button className={btn} onClick={() => toggleRole(row)}>{row.role === 'admin' ? '降级' : '设为管理员'}</button>
                    <button className={row.banned ? btn : btnDanger} onClick={() => toggleBan(row)}>{row.banned ? '启用' : '停用'}</button>
                  </div>
                </td>
              </tr>
            ))}
            {data && data.length === 0 && (
              <tr><td className={`${td} text-content-muted`} colSpan={6}>没有匹配的用户</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
