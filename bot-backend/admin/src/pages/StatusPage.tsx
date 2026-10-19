import { useQuery } from '@tanstack/react-query'
import { adminApi } from '@/lib/api'
import { Badge, Card, Spinner, Stat } from './ui'

function uptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return d > 0 ? `${d} 天 ${h} 小时` : h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
}

export function StatusPage() {
  const { data, isLoading, isError } = useQuery({ queryKey: ['status'], queryFn: adminApi.status, refetchInterval: 30_000 })
  if (isLoading) return <Spinner />
  if (isError || !data) return <div className="text-content-muted">状态加载失败，请刷新重试。</div>
  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-[16px] font-semibold">服务状态</h1>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-3.5">
        <Stat label="PostgreSQL" value={data.dbOk ? '正常' : '异常'} ok={data.dbOk} sub={data.dbOk ? '连接健康' : '无法连接'} />
        <Stat label="Redis" value={data.redisOk ? '正常' : '异常'} ok={data.redisOk} sub={data.redisOk ? '连接健康' : '无法连接'} />
        <Stat label="已运行" value={uptime(data.uptimeSeconds)} />
        <Stat label="活跃流式请求" value={data.activeStreams ?? '—'} />
      </div>
      <div className="grid grid-cols-2 gap-5">
        <Card title="账号">
          <div className="flex items-center gap-6 text-[13px]">
            <span className="text-content-muted">总数 <b className="ml-1 text-[16px] text-content">{data.totalUsers}</b></span>
            <span className="text-content-muted">管理员 <b className="ml-1 text-[16px] text-content">{data.adminUsers}</b></span>
            <span className="text-content-muted">停用 <b className="ml-1 text-[16px] text-content">{data.bannedUsers}</b></span>
          </div>
        </Card>
        <Card title="模型目录">
          <div className="flex items-center gap-6 text-[13px]">
            <span className="text-content-muted">启用 <b className="ml-1 text-[16px] text-content">{data.modelsEnabled}</b></span>
            <span className="text-content-muted">总计 <b className="ml-1 text-[16px] text-content">{data.modelsTotal}</b></span>
          </div>
        </Card>
      </div>
      <Card title="近 24 小时请求">
        <div className="flex items-center gap-4">
          <Badge tone="ok">完成 {data.dayComplete}</Badge>
          <Badge tone="bad">失败 {data.dayFailed}</Badge>
          <Badge tone="warn">拦截 {data.dayRejected}</Badge>
        </div>
      </Card>
    </div>
  )
}
