import { useQuery } from '@tanstack/react-query'
import type { CreativeDraft, CreativeProject } from '@/entities/creative/model'
import { parsePipelineAutomation } from '@/entities/creative/automation'
import {
  pipelineQueries,
  type PipelineAutomation,
  type PipelineToolPolicy,
} from '@/entities/creative/pipeline'
import { toolboxQueries } from '@/entities/creative/toolbox'
import { useProductionText } from '@/entities/creative/catalog'
import { Textarea } from '@/shared/ui/input'
import { CreativeField, CreativeSection, hintClass } from './CreativeFields'

const selectClass =
  'min-h-10 w-full rounded-control border border-outline bg-input px-3 text-sm text-content focus-visible:shadow-focus'
const selectionKeys: Record<string, string> = {
  researchTool: 'research',
  stockTool: 'stock',
  imageTool: 'image',
  videoTool: 'video',
  speechTool: 'speech',
  transcriptionTool: 'transcription',
  avatarTool: 'avatar',
  musicTool: 'music',
  modelTool: 'model3d',
}
const services = [
  ['researchTool', '资料检索', 'Research'],
  ['stockTool', '联网素材', 'Stock media'],
  ['transcriptionTool', '原稿识别服务', 'Transcription'],
  ['imageTool', '图像制作', 'Images'],
  ['videoTool', '视频制作', 'Video'],
  ['avatarTool', '数字人 / 口型服务', 'Avatar / lip sync'],
  ['speechTool', '旁白配音', 'Voiceover'],
  ['musicTool', '背景配乐', 'Music'],
  ['modelTool', '三维模型', '3D models'],
] as const

export function CreativePipelineAutomation({
  project,
  draft,
  disabled,
  onChange,
}: {
  project: CreativeProject
  draft: CreativeDraft
  disabled: boolean
  onChange: (update: (draft: CreativeDraft) => CreativeDraft) => void
}) {
  const text = useProductionText()
  const plan = useQuery(pipelineQueries.toolPlan(project.id, project.revision))
  const catalog = useQuery(toolboxQueries.catalog())
  const parsed = parsePipelineAutomation(draft.production?.fields.automation)
  const automation = parsed.value
  const tool = (id: string) => catalog.data?.tools.find((item) => item.id === id)
  const name = (id: string) => tool(id)?.name ?? id
  const relevant = (plan.data?.policies ?? []).filter(
    (policy) => policy.categories.includes(project.category) || policy.categories.includes('*'),
  )
  const choices = (key: string) =>
    relevant.filter(
      (policy) =>
        (policy.selectionKey === key || policy.selectionKey === selectionKeys[key]) &&
        policy.mode !== 'interactive',
    )
  const post = relevant.filter((policy) => policy.role === 'post' && policy.mode === 'selectable')
  const updateRaw = (raw: string) =>
    onChange((current) => ({
      ...current,
      production: {
        fields: { ...current.production?.fields, automation: raw },
        sources: current.production?.sources ?? [],
      },
    }))
  const update = (patch: Partial<PipelineAutomation>) =>
    updateRaw(JSON.stringify({ ...automation, ...patch }))
  const selectedTools = services
    .flatMap(([key]) => (automation[key] ? [automation[key]!] : []))
    .concat(automation.postTools ?? [])
  const reason = (policy: PipelineToolPolicy) =>
    `${policy.purpose}${tool(policy.toolId)?.available === false ? ` · ${tool(policy.toolId)?.reason || text('需要配置服务或安装依赖', 'Requires service setup or dependencies')}` : ''}`
  return (
    <CreativeSection
      title={text('流程自动制作', 'Workflow automation')}
      hint={text(
        '按当前视频类型串联素材分析、画面制作、声音与后期。保存后同步制作流程，实际任务与产物会显示在各阶段中。',
        'Connect source analysis, visuals, sound and finishing for this video type. Save and sync the workflow to see actual tasks and outputs in each stage.',
      )}
    >
      <fieldset
        disabled={disabled || !!parsed.error}
        className="grid min-w-0 gap-4 border-0 p-0 sm:grid-cols-2"
      >
        <CreativeField label={text('画面制作方式', 'Visual production')}>
          <select
            className={selectClass}
            value={automation.visual ?? 'auto'}
            onChange={(event) => update({ visual: event.target.value as PipelineAutomation['visual'] })}
          >
            {[
              ['auto', '按镜头内容自动选择', 'Choose for each shot'],
              ['generated', '生成图片或视频', 'Generate images or video'],
              ['diagram', '图表与示意动画', 'Diagrams and explanatory graphics'],
              ['math', '数学与公式动画', 'Math and formula animation'],
              ['character', '角色与动作动画', 'Character animation'],
              ['threejs', '三维场景动画', '3D scenes'],
              ['blender', '三维渲染', '3D rendering'],
              ['source', '仅使用已有素材', 'Use existing sources'],
            ].map(([value, zh, en]) => (
              <option key={value} value={value}>
                {text(zh, en)}
              </option>
            ))}
          </select>
        </CreativeField>
        <CreativeField label={text('素材分析方式', 'Source analysis')}>
          <select
            className={selectClass}
            value={automation.analysis ?? 'auto'}
            onChange={(event) => update({ analysis: event.target.value as PipelineAutomation['analysis'] })}
          >
            <option value="auto">{text('按流程自动检查与分析', 'Analyze for this workflow')}</option>
            <option value="vision">{text('增加画面内容分析', 'Include visual understanding')}</option>
            <option value="off">{text('关闭可选分析', 'Disable optional analysis')}</option>
          </select>
        </CreativeField>
        {services.map(([key, zh, en]) => {
          const options = choices(key)
          if (!options.length && !automation[key]) return null
          return (
            <CreativeField
              key={key}
              label={text(zh, en)}
              hint={
                options.find((policy) => policy.toolId === automation[key])
                  ? reason(options.find((policy) => policy.toolId === automation[key])!)
                  : undefined
              }
            >
              <select
                className={selectClass}
                value={automation[key] ?? ''}
                onChange={(event) => update({ [key]: event.target.value || undefined })}
              >
                <option value="">{text('按流程自动选择', 'Choose for this workflow')}</option>
                <option value="off">{text('不使用此项', 'Do not use')}</option>
                {automation[key] &&
                  automation[key] !== 'off' &&
                  !options.some((policy) => policy.toolId === automation[key]) && (
                    <option value={automation[key]}>
                      {name(automation[key]!)} · {text('已保存的选择', 'Saved selection')}
                    </option>
                  )}
                {options.map((policy) => (
                  <option key={policy.toolId} value={policy.toolId}>
                    {name(policy.toolId)}
                    {tool(policy.toolId)?.available === false ? ` · ${text('需配置', 'Setup required')}` : ''}
                  </option>
                ))}
              </select>
            </CreativeField>
          )
        })}
      </fieldset>
      {!!post.length && (
        <fieldset
          disabled={disabled || !!parsed.error}
          className="mt-4 grid min-w-0 gap-3 rounded-control border border-outline p-3 sm:grid-cols-2"
        >
          <legend className="px-1 text-xs font-semibold">
            {text('可选后期处理', 'Additional finishing')}
          </legend>
          {post.map((policy) => (
            <label key={policy.toolId} className="flex items-start gap-2 text-xs">
              <input
                className="mt-0.5 accent-brand"
                type="checkbox"
                checked={automation.postTools?.includes(policy.toolId) ?? false}
                onChange={(event) =>
                  update({
                    postTools: event.target.checked
                      ? [...(automation.postTools ?? []), policy.toolId]
                      : (automation.postTools?.filter((id) => id !== policy.toolId) ?? []),
                  })
                }
              />
              <span>
                <span className="block font-semibold">{name(policy.toolId)}</span>
                <span className={hintClass}>{reason(policy)}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {project.category === 'screen_demo' && (
        <label className="mt-4 flex items-start gap-2 text-xs">
          <input
            className="mt-0.5 accent-brand"
            type="checkbox"
            checked={automation.capture === true}
            disabled={disabled || !!parsed.error}
            onChange={(event) => update({ capture: event.target.checked })}
          />
          <span>
            {text(
              '允许本轮流程录制当前桌面；执行录制阶段时请准备好演示画面。',
              'Allow this workflow to record the current desktop; prepare the demonstration before the recording stage.',
            )}
          </span>
        </label>
      )}
      {selectedTools
        .filter((id) => tool(id)?.available === false)
        .map((id) => (
          <p key={id} className="mt-2 text-xs text-brand-content">
            {name(id)}：
            {tool(id)?.reason ||
              text(
                '需要配置服务或安装依赖；流程会在该步骤暂停。',
                'Setup is required; the workflow will pause at this step.',
              )}
          </p>
        ))}
      {(plan.isError || catalog.isError) && (
        <p className="mt-3 text-xs text-danger">
          {text(
            '制作能力暂时无法读取，已保存的设置会保留。',
            'Production capabilities could not be loaded. Saved settings are retained.',
          )}
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => {
              void plan.refetch()
              void catalog.refetch()
            }}
          >
            {text('重新读取', 'Reload')}
          </button>
        </p>
      )}
      <details className="mt-4 rounded-control bg-elevated p-3">
        <summary className="cursor-pointer text-xs font-semibold">
          {text('高级制作参数', 'Advanced production parameters')}
        </summary>
        <p className={`${hintClass} my-3`}>
          {text(
            '为选定工具补充专用参数时，填写 toolParameters 对象，以工具名称为键。画面、配音和产物依赖由流程自动传递；请勿填写密钥。',
            'Add provider parameters under toolParameters, keyed by tool name. The workflow supplies media, voice and dependencies. Do not enter credentials.',
          )}
        </p>
        <Textarea
          aria-label={text('高级制作设置', 'Advanced production settings')}
          className="font-mono text-xs"
          rows={7}
          spellCheck={false}
          disabled={disabled}
          value={draft.production?.fields.automation ?? '{}'}
          maxLength={20000}
          onChange={(event) => updateRaw(event.target.value)}
        />
      </details>
      {parsed.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {parsed.error}
        </p>
      )}
    </CreativeSection>
  )
}
