import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { toolApi, toolQueries, type ToolJob, type ToolKind } from '@/entities/creative/tools'
import type { CreativeDraft, CreativeProject } from '@/entities/creative/model'
import { Button } from '@/shared/ui/button'
import { Input } from '@/shared/ui/input'
import { BaseSelect } from '@/shared/ui/BaseSelect'
import { Modal } from '@/shared/ui/Modal'
import { CreativeField, CreativeSection, MediaUpload } from './CreativeFields'
import { CreativeToolJob, type ToolAction } from './CreativeToolJob'
import { CreativeToolFiles } from './CreativeToolFiles'

export function CreativeToolsPanel({
  project,
  draft,
  disabled,
  canRun,
  onChange,
  onProjectUpdated,
  onBusyChange,
}: {
  project: CreativeProject
  draft: CreativeDraft
  disabled: boolean
  canRun: boolean
  onChange: (fn: (draft: CreativeDraft) => CreativeDraft) => void
  onProjectUpdated: (project: CreativeProject) => void
  onBusyChange: (busy: boolean) => void
}) {
  const client = useQueryClient(),
    query = useQuery(toolQueries.project(project.id))
  const [search, setSearch] = useState(''),
    [media, setMedia] = useState<'image' | 'video'>('video'),
    [shotId, setShotId] = useState(''),
    [modelId, setModelId] = useState(''),
    [height, setHeight] = useState('1.7')
  const [confirmation, setConfirmation] = useState<ToolJob | null>(null)
  const fields = draft.production?.fields ?? {}
  const setField = (key: string, value: string) =>
    onChange((d) => ({
      ...d,
      production: { sources: d.production?.sources ?? [], fields: { ...d.production?.fields, [key]: value } },
    }))
  const mutation = useMutation({
    mutationFn: async (operation: () => Promise<unknown>) => operation(),
    onSuccess: () => client.invalidateQueries({ queryKey: toolQueries.project(project.id).queryKey }),
  })
  useEffect(() => {
    onBusyChange(mutation.isPending)
    return () => onBusyChange(false)
  }, [mutation.isPending, onBusyChange])
  const locked = disabled || mutation.isPending,
    taskLocked = !canRun || locked
  const start = (kind: ToolKind, input: ToolJob['input'], force = false) =>
    mutation.mutate(() => toolApi.start(project.id, project.revision, kind, input, force))
  const action = (item: ToolAction) => {
    if (item.type === 'restart') {
      setConfirmation(item.job)
      return
    }
    mutation.mutate(async () => {
      if (item.type === 'resume') return toolApi.resume(project.id, item.job.id, item.remoteId)
      const saved =
        item.type === 'apply'
          ? await toolApi.apply(project.id, item.job.id, project.revision)
          : await toolApi.import(project.id, item.job.id, item.candidateId, project.revision)
      onProjectUpdated(saved)
    })
  }
  const toggle = (key: string, value: string, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        disabled={locked}
        checked={fields[key] === value}
        onChange={(e) => setField(key, e.target.checked ? value : '')}
      />
      {label}
    </label>
  )
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-brand-soft p-4">
        <p className="text-sm">手动制作或加入自动流程；所有任务与产物保存在当前项目。</p>
        <Link to="/settings" className="text-sm text-brand-content underline">
          配置模型与服务 ↗
        </Link>
      </div>
      {!canRun && (
        <p role="status" className="text-sm text-brand-content">
          请先保存项目修改，并等待当前编辑操作完成。
        </p>
      )}
      {mutation.isError && (
        <p role="alert" className="rounded-control bg-danger-soft p-3 text-sm text-danger">
          {mutation.error.message}
        </p>
      )}
      {mutation.isPending && (
        <p role="status" className="text-sm text-content-muted">
          正在处理，请等待完成…
        </p>
      )}
      {query.isError && (
        <div role="alert">
          {query.error.message}
          <Button onClick={() => void query.refetch()}>重新读取任务</Button>
        </div>
      )}
      <CreativeSection
        title="联网资料与素材"
        hint="资料保留原始出处；素材下载后进入创作需求的原始素材区，可用于分镜。请核对资料准确性和素材适用范围。"
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
          <CreativeField label="搜索主题">
            <Input
              value={search}
              maxLength={500}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="例如：深海生物、城市夜景"
              disabled={locked}
            />
          </CreativeField>
          <CreativeField label="素材类型">
            <BaseSelect
              value={media}
              onChange={(v) => setMedia(v as 'image' | 'video')}
              searchable={false}
              disabled={locked}
              options={[
                { value: 'video', label: '视频' },
                { value: 'image', label: '图片' },
              ]}
            />
          </CreativeField>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            disabled={taskLocked || !search.trim()}
            onClick={() => start('research', { query: search })}
          >
            搜索资料
          </Button>
          <Button
            disabled={taskLocked || !search.trim()}
            onClick={() => start('stock', { query: search, media })}
          >
            搜索素材
          </Button>
        </div>
        <div className="mt-5 space-y-3 border-t border-outline pt-4">
          {toggle('researchMode', 'tavily', '流程开始时自动检索资料')}
          {fields.researchMode === 'tavily' && (
            <CreativeField label="资料检索词（留空使用创作主题）">
              <Input
                value={fields.researchQuery || ''}
                maxLength={500}
                disabled={locked}
                onChange={(e) => setField('researchQuery', e.target.value)}
              />
            </CreativeField>
          )}
          {toggle('stockMode', 'pexels', '流程开始时自动搜索并导入补充素材')}
          {fields.stockMode === 'pexels' && (
            <div className="grid gap-3 sm:grid-cols-3">
              <CreativeField label="素材搜索词">
                <Input
                  value={fields.stockQuery || ''}
                  maxLength={500}
                  disabled={locked}
                  onChange={(e) => setField('stockQuery', e.target.value)}
                  placeholder="留空使用创作主题"
                />
              </CreativeField>
              <CreativeField label="自动素材类型">
                <BaseSelect
                  value={fields.stockMedia || 'video'}
                  onChange={(v) => setField('stockMedia', v)}
                  disabled={locked}
                  searchable={false}
                  options={[
                    { value: 'video', label: '视频' },
                    { value: 'image', label: '图片' },
                  ]}
                />
              </CreativeField>
              <CreativeField label="自动导入数量">
                <BaseSelect
                  value={fields.stockCount || '1'}
                  onChange={(v) => setField('stockCount', v)}
                  disabled={locked}
                  searchable={false}
                  options={[1, 2, 3].map((n) => ({ value: String(n), label: `${n} 个` }))}
                />
              </CreativeField>
            </div>
          )}
        </div>
      </CreativeSection>
      <CreativeSection
        title="数字人口型同步"
        hint="先在画面编排中给镜头上传人物视频（或人物图）和逐镜头配音。自动模式会处理有旁白或配音的镜头；人物图需要 sync-3。"
      >
        <CreativeField label="需要同步的镜头">
          <BaseSelect
            value={shotId}
            onChange={setShotId}
            disabled={locked}
            placeholder="选择镜头"
            options={project.shots.map((s) => ({
              value: s.id,
              label: `${s.title} · ${s.duration}s${s.audioUrl ? ' · 已有配音' : ''}`,
            }))}
          />
        </CreativeField>
        <Button
          className="mt-3"
          disabled={taskLocked || !shotId}
          onClick={() => start('lipsync', { shotId })}
        >
          开始口型同步
        </Button>
        <div className="mt-4">{toggle('lipSyncMode', 'sync', '在素材制作阶段自动同步口型并替换镜头')}</div>
      </CreativeSection>
      <CreativeSection
        title="三维骨骼绑定"
        hint="上传面向正前方（+Z）、四肢清晰的人形 GLB，纹理需嵌入文件，最大 50MB。输出可下载并预览；绑定模型仍需后续渲染才能作为影片镜头。"
        action={
          <MediaUpload
            accept=".glb,model/gltf-binary"
            label="上传人形 GLB"
            disabled={taskLocked}
            onFile={(file) =>
              mutation.mutate(async () => {
                if (file.size > 50 * 1024 * 1024) throw new Error('GLB 不能超过50MB')
                const model = await toolApi.upload(project.id, file)
                setModelId(String(model.id))
                return model
              })
            }
          />
        }
      >
        <div className="grid gap-3 sm:grid-cols-[1fr_150px]">
          <CreativeField label="角色模型">
            <BaseSelect
              value={modelId}
              onChange={setModelId}
              disabled={locked}
              placeholder="选择已上传模型"
              options={(query.data?.models || []).map((m) => ({ value: String(m.id), label: m.name }))}
            />
          </CreativeField>
          <CreativeField label="身高（米）">
            <Input
              type="number"
              min={0.1}
              max={10}
              step={0.1}
              value={height}
              disabled={locked}
              onChange={(e) => setHeight(e.target.value)}
            />
          </CreativeField>
        </div>
        <Button
          className="mt-3"
          disabled={
            taskLocked ||
            !modelId ||
            !Number.isFinite(Number(height)) ||
            Number(height) < 0.1 ||
            Number(height) > 10
          }
          onClick={() => start('rigging', { modelId: Number(modelId), height: Number(height) })}
        >
          开始骨骼绑定
        </Button>
        {modelId && query.data?.models.find((m) => String(m.id) === modelId) && (
          <div className="mt-3">
            <CreativeToolFiles
              files={query.data.models
                .filter((m) => String(m.id) === modelId)
                .map((m) => ({ ...m, kind: 'model' as const }))}
            />
          </div>
        )}
        {project.category === 'character_animation' && (
          <div className="mt-4 space-y-3 border-t border-outline pt-4">
            {toggle('rigMode', 'meshy', '在角色动画流程中自动绑定骨骼')}
            {fields.rigMode === 'meshy' && (
              <div className="grid gap-3 sm:grid-cols-2">
                <CreativeField label="自动绑定的模型">
                  <BaseSelect
                    value={fields.rigModelId || ''}
                    disabled={locked}
                    onChange={(v) => setField('rigModelId', v)}
                    placeholder="选择模型"
                    options={(query.data?.models || []).map((m) => ({ value: String(m.id), label: m.name }))}
                  />
                </CreativeField>
                <CreativeField label="自动绑定身高（米）">
                  <Input
                    type="number"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={fields.rigHeight || '1.7'}
                    disabled={locked}
                    onChange={(e) => setField('rigHeight', e.target.value)}
                  />
                </CreativeField>
              </div>
            )}
          </div>
        )}
      </CreativeSection>
      <CreativeSection
        title="任务与产物"
        hint="重新打开项目后仍可查看记录。恢复查询复用已有服务任务；重新制作会提交新任务。"
      >
        {query.isPending ? (
          <p role="status">正在读取任务…</p>
        ) : !query.data?.jobs.length ? (
          <p className="text-sm text-content-muted">暂无任务，完成服务配置后即可开始。</p>
        ) : (
          <div className="space-y-3">
            {query.data.jobs.map((job,index) => (
              <CreativeToolJob
                key={job.id}
                latest={index===0}
                job={job}
                project={project}
                disabled={taskLocked}
                onAction={action}
              />
            ))}
          </div>
        )}
      </CreativeSection>
      <Modal
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null)
        }}
        title="重新制作"
        footer={
          <>
            <Button onClick={() => setConfirmation(null)}>取消</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (!confirmation) return
                const { shotId, modelId, height, query, media } = confirmation.input
                start(confirmation.kind, { shotId, modelId, height, query, media }, true)
                setConfirmation(null)
              }}
            >
              提交新任务
            </Button>
          </>
        }
      >
        <p className="text-sm">
          这会向服务商提交新任务，并可能再次使用账户额度。已有产物会保留。若只是查询中断，请使用「恢复任务查询」。
        </p>
      </Modal>
    </div>
  )
}
