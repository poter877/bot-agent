import { useState } from 'react'
import type { CreativeProject } from '@/entities/creative/model'
import type { ToolJob } from '@/entities/creative/tools'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { CreativeToolFiles } from './CreativeToolFiles'
export type ToolAction =
  | { type: 'resume'; job: ToolJob; remoteId?: string }
  | { type: 'apply'; job: ToolJob }
  | { type: 'import'; job: ToolJob; candidateId: string }
  | { type: 'restart'; job: ToolJob }
const statusNames = {
  queued: '等待执行',
  submitting: '正在提交',
  running: '制作中',
  completed: '已完成',
  failed: '需处理',
  uncertain: '提交结果待核实',
}
const kindNames = { lipsync: '数字人口型', rigging: '骨骼绑定', research: '联网资料', stock: '联网素材' }
export function CreativeToolJob({
  job,
  project,
  disabled,
  onAction,
  latest = false,
}: {
  job: ToolJob
  latest?: boolean
  project: CreativeProject
  disabled: boolean
  onAction: (action: ToolAction) => void
}) {
  const [remoteId, setRemoteId] = useState('')
  const active = ['queued', 'submitting', 'running'].includes(job.status)
  const shot = project.shots.find((s) => s.id === job.input.shotId)
  const applied = job.result.files?.some((f) => f.kind === 'video' && f.url === shot?.videoUrl)
  return (
    <details
      className="rounded-control border border-outline bg-elevated p-4"
      open={latest || job.status !== 'completed'}
    >
      <summary className="cursor-pointer break-words text-sm font-semibold">
        #{job.id} · {kindNames[job.kind]} · {statusNames[job.status]}
        {active && job.kind === 'rigging' ? ` ${job.progress}%` : ''}
        <span className="ml-2 font-normal text-content-muted">{job.input.query || shot?.title || ''}</span>
      </summary>
      <div className="mt-4 space-y-3">
        <p className="break-all text-xs text-content-muted">
          {new Date(job.createdAt).toLocaleString()}
          {job.remoteId ? ` · 服务任务：${job.remoteId}` : ''}
        </p>
        {job.error && (
          <p role="alert" className="text-sm text-danger">
            {job.error}
          </p>
        )}
        {job.status === 'uncertain' && (
          <label className="block space-y-2 text-xs">
            从服务商后台填写该任务编号，恢复查询
            <Input
              aria-label="服务商任务编号"
              value={remoteId}
              onChange={(e) => setRemoteId(e.target.value)}
              maxLength={200}
            />
          </label>
        )}
        {['failed', 'uncertain'].includes(job.status) && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={disabled || (job.status === 'uncertain' && !remoteId.trim())}
              onClick={() => onAction({ type: 'resume', job, remoteId: remoteId.trim() || undefined })}
            >
              {job.remoteId || job.status === 'uncertain' ? '恢复任务查询' : '重试任务'}
            </Button>
            {job.status === 'failed' && (
              <Button size="sm" disabled={disabled} onClick={() => onAction({ type: 'restart', job })}>
                重新制作
              </Button>
            )}
          </div>
        )}
        {job.status === 'completed' && (
          <Button size="sm" disabled={disabled} onClick={() => onAction({ type: 'restart', job })}>
            {job.kind === 'research' || job.kind === 'stock' ? '重新检索' : '重新制作'}
          </Button>
        )}
        {!!job.result.files?.length && <CreativeToolFiles files={job.result.files} />}
        {job.kind === 'lipsync' && job.status === 'completed' && (
          <Button
            size="sm"
            variant="primary"
            disabled={disabled || applied}
            onClick={() => onAction({ type: 'apply', job })}
          >
            {applied ? '已应用到镜头' : '应用到对应镜头'}
          </Button>
        )}
        {job.result.articles?.map((article) => (
          <article key={article.url} className="rounded-control border border-outline p-3">
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-brand-content underline"
            >
              {article.title} ↗
            </a>
            <p className="mt-2 max-h-40 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-content-muted">
              {article.content}
            </p>
          </article>
        ))}
        {job.result.articles?.length === 0 && (
          <p className="text-sm text-content-muted">未找到资料，请调整搜索词。</p>
        )}
        {job.result.candidates?.length === 0 && (
          <p className="text-sm text-content-muted">未找到素材，请调整搜索词。</p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {job.result.candidates?.map((candidate) => {
            const imported = project.production?.sources.some(
              (s) => s.id === job.result.imports?.[candidate.id],
            )
            return (
              <article key={candidate.id} className="overflow-hidden rounded-control border border-outline">
                <img
                  src={candidate.preview}
                  alt={candidate.title}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className="aspect-video w-full object-cover"
                />
                <div className="space-y-2 p-3">
                  <a
                    href={candidate.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block text-xs text-brand-content underline"
                  >
                    {candidate.title}
                    {candidate.duration ? ` · ${candidate.duration}s` : ''}
                  </a>
                  <p className="text-xs">
                    <a href={candidate.authorUrl} target="_blank" rel="noreferrer">
                      {candidate.author}
                    </a>{' '}
                    /{' '}
                    <a href="https://www.pexels.com" target="_blank" rel="noreferrer">
                      Pexels
                    </a>{' '}
                    ·{' '}
                    <a href={candidate.licenseUrl} target="_blank" rel="noreferrer" className="underline">
                      许可
                    </a>
                  </p>
                  <Button
                    size="sm"
                    disabled={disabled || imported}
                    onClick={() => onAction({ type: 'import', job, candidateId: candidate.id })}
                  >
                    {imported ? '已在素材库' : '下载到项目素材库'}
                  </Button>
                </div>
              </article>
            )
          })}
        </div>
      </div>
    </details>
  )
}
