import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronDown } from 'lucide-react'
import { adminApi, type CredentialHint, type RegistryModelMeta, type RegistryProvider } from '@/lib/api'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const MEDIA_PROVIDERS = new Set(['fal', 'openai', 'google', 'xai', 'volcengine', 'minimax', 'aliyun', 'kling'])
const KIND_LABELS: Record<string, string> = { text: '文本', image: '图片', video: '视频', speech: '语音', transcription: '转写' }

function kindsOf(meta: RegistryModelMeta): string[] {
  const output = new Set(meta.modalities?.output ?? ['text'])
  const inputSet = new Set(meta.modalities?.input ?? [])
  const kinds: string[] = []
  if (output.has('text')) kinds.push('text')
  if (output.has('image')) kinds.push('image')
  if (output.has('video')) kinds.push('video')
  if (output.has('audio')) kinds.push('speech')
  if (inputSet.has('audio') && !output.has('audio')) kinds.push('transcription')
  return kinds.length ? kinds : ['text']
}

function RegistryCombobox(props: {
  value: string
  onValueChange: (value: string) => void
  onPick?: (value: string) => void
  options: Array<{ id: string; label: string }>
  placeholder: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filtered = query
    ? props.options.filter((o) => o.id.includes(query.toLowerCase()) || o.label.toLowerCase().includes(query.toLowerCase()))
    : props.options
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" className="h-9 w-full justify-between font-normal">
          <span className={cn('truncate', !props.value && 'text-muted-foreground')}>{props.value || props.placeholder}</span>
          <ChevronDown className="opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="p-0">
        <div className="border-b p-2">
          <Input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索…" className="h-8" />
        </div>
        <div className="max-h-60 overflow-auto">
          {filtered.map((o) => (
            <button
              type="button"
              key={o.id}
              className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-[13px] transition-colors hover:bg-accent"
              onClick={() => {
                props.onValueChange(o.id)
                props.onPick?.(o.id)
                setOpen(false)
                setQuery('')
              }}
            >
              <span className="truncate">{o.label}</span>
              <span className="text-[11px] text-muted-foreground">{o.id}</span>
              {props.value === o.id && <Check className="h-3.5 w-3.5 shrink-0 text-primary" />}
            </button>
          ))}
          {filtered.length === 0 && (
            <div className="px-3 py-3 text-[12px] text-muted-foreground">无匹配项 — 关闭后可直接使用手输值</div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function KindBadges({ kinds, enabled, unsupported }: { kinds: string[]; enabled: Set<string>; unsupported: boolean }) {
  return (
    <div className="flex flex-wrap gap-1">
      {kinds.map((kind) => {
        const isMedia = kind !== 'text'
        const blocked = isMedia && unsupported
        return (
          <Badge
            key={kind}
            variant={enabled.has(kind) ? 'success' : blocked ? 'warning' : 'outline'}
            title={blocked ? '该厂商的媒体能力未接入媒体网关，勾选仅对文本生效' : undefined}
          >
            {KIND_LABELS[kind] ?? kind}
            {blocked ? '（未接入）' : ''}
          </Badge>
        )
      })}
    </div>
  )
}

/** 单个已配置 Provider 的可启用模型表（可折叠）。 */
function ProviderModelsSection(props: {
  providerId: string
  baseUrl: string
  defaultOpen: boolean
}) {
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(props.defaultOpen)
  const [error, setError] = useState('')
  const registryQuery = useQuery({ queryKey: ['registry'], queryFn: adminApi.registry, staleTime: Infinity })
  const registry: RegistryProvider[] = registryQuery.data ?? []
  const meta = registry.find((p) => p.id === props.providerId)
  const models = useMemo(() => Object.entries(meta?.models ?? {}), [meta])
  const { data: textRows } = useQuery({ queryKey: ['models'], queryFn: adminApi.models })
  const { data: mediaRows } = useQuery({ queryKey: ['media-models'], queryFn: adminApi.mediaModels })

  useEffect(() => setOpen(props.defaultOpen), [props.defaultOpen])

  function enabledKinds(modelId: string): Set<string> {
    const enabled = new Set<string>()
    for (const row of textRows ?? []) {
      if (row.provider === props.providerId && (row.model === modelId || row.id === modelId) && row.enabled) enabled.add('text')
    }
    for (const row of mediaRows ?? []) {
      if (row.provider === props.providerId && row.model === modelId && row.enabled) enabled.add(row.kind)
    }
    return enabled
  }

  const setEnabled = useMutation({
    mutationFn: async (input: { modelId: string; meta: RegistryModelMeta; kind: string; enable: boolean }) => {
      const { modelId, meta, kind, enable } = input
      if (kind === 'text') {
        const existing = textRows?.find((row) => row.provider === props.providerId && (row.model === modelId || row.id === modelId))
        await adminApi.saveModel({
          id: modelId, provider: props.providerId, model: modelId,
          displayName: existing?.displayName ?? meta.name,
          baseURL: existing?.baseUrl ?? props.baseUrl ?? undefined,
          enabled: enable,
        })
        return
      }
      const existing = mediaRows?.find((row) => row.provider === props.providerId && row.model === modelId && row.kind === kind)
      await adminApi.saveMediaModel({
        id: modelId, kind, provider: props.providerId, model: modelId,
        displayName: existing?.displayName ?? meta.name,
        enabled: enable,
      })
    },
    onSuccess: () => {
      setError('')
      void queryClient.invalidateQueries({ queryKey: ['models'] })
      void queryClient.invalidateQueries({ queryKey: ['media-models'] })
    },
    onError: (err) => setError(err.message),
  })

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>
          {meta?.name ?? props.providerId} 的模型（{models.length}）
          <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">{props.baseUrl}</span>
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
          <ChevronDown className={cn('transition-transform', open && 'rotate-180')} />
        </Button>
      </CardHeader>
      {open && (
        <CardContent className="space-y-2 p-0">
          {error && (
            <div className="mx-5 mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-red-300">{error}</div>
          )}
          {models.length === 0 ? (
            <div className="p-5 text-[13px] text-muted-foreground">该厂商暂无模型记录</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10" />
                  <TableHead>模型</TableHead>
                  <TableHead>能力</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {models.map(([modelId, modelMeta]) => {
                  const enabled = enabledKinds(modelId)
                  const kinds = kindsOf(modelMeta)
                  const checked = kinds.some((kind) => enabled.has(kind))
                  const mediaUnsupported = kinds.some((kind) => kind !== 'text') && !MEDIA_PROVIDERS.has(props.providerId)
                  return (
                    <TableRow key={modelId}>
                      <TableCell>
                        <Checkbox
                          checked={checked}
                          disabled={setEnabled.isPending}
                          onCheckedChange={(value) => {
                            // 一行一个勾选框：勾选/取消作用于该模型的全部可用模态
                            const enable = value === true
                            for (const kind of kinds) setEnabled.mutate({ modelId, meta: modelMeta, kind, enable })
                          }}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{modelMeta.name}</div>
                        <div className="text-[11px] text-muted-foreground">{modelId}</div>
                      </TableCell>
                      <TableCell>
                        <KindBadges kinds={kinds} enabled={enabled} unsupported={mediaUnsupported} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
          {models.length > 0 && MEDIA_PROVIDERS.has(props.providerId) === false && (
            <div className="px-5 pb-4 text-[11.5px] text-muted-foreground">
              提示：勾选只写入文本目录；图片/视频/语音需厂商已接入媒体网关（openai/google/xai/volcengine/minimax/aliyun/fal/kling）。
            </div>
          )}
        </CardContent>
      )}
    </Card>
  )
}

/** 模型目录页：配置 Provider → 勾选启用该厂商的模型。 */
export function ModelsPage() {
  const queryClient = useQueryClient()
  const registryQuery = useQuery({ queryKey: ['registry'], queryFn: adminApi.registry, staleTime: Infinity })
  const registry: RegistryProvider[] = registryQuery.data ?? []
  const credentialsQuery = useQuery({ queryKey: ['credentials'], queryFn: adminApi.credentials })
  const credentials: CredentialHint[] = credentialsQuery.data ?? []

  const { data: textRows } = useQuery({ queryKey: ['models'], queryFn: adminApi.models })
  const { data: mediaRows } = useQuery({ queryKey: ['media-models'], queryFn: adminApi.mediaModels })

  // ── 添加模型（Provider 配置）──
  const [provider, setProvider] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [formError, setFormError] = useState('')
  const [formOk, setFormOk] = useState('')
  const providerMeta = registry.find((p) => p.id === provider)

  const refreshCatalog = () => {
    void queryClient.invalidateQueries({ queryKey: ['models'] })
    void queryClient.invalidateQueries({ queryKey: ['media-models'] })
    void queryClient.invalidateQueries({ queryKey: ['credentials'] })
  }

  const saveProvider = useMutation({
    mutationFn: () => adminApi.saveCredential({ provider: provider.trim(), baseUrl: baseUrl.trim() || undefined, apiKey }),
    onSuccess: (res) => {
      setFormOk(`Provider ${res.provider} 已保存（${res.baseUrl}）`)
      setFormError('')
      setApiKey('')
      refreshCatalog()
    },
    onError: (err) => {
      setFormOk('')
      setFormError(err.message)
    },
  })

  const catalogCount = (textRows?.length ?? 0) + (mediaRows?.length ?? 0)

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[16px] font-semibold">模型目录</h1>
      {(formError || formOk) && (
        <div className={cn('rounded-md border px-4 py-2.5 text-[13px]', formError ? 'border-destructive/30 bg-destructive/10 text-red-300' : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300')}>
          {formError || formOk}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>添加模型</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-end gap-x-4 gap-y-3.5"
            onSubmit={(e) => {
              e.preventDefault()
              setFormOk('')
              saveProvider.mutate()
            }}
          >
            <div className="space-y-1.5">
              <Label>Provider（AI SDK 支持列表，models.dev 注册表）</Label>
              <RegistryCombobox
                value={provider}
                onValueChange={(v) => setProvider(v.toLowerCase())}
                onPick={(v) => {
                  setProvider(v)
                  setBaseUrl(registry.find((p) => p.id === v)?.api ?? '')
                }}
                options={registry.map((p) => ({ id: p.id, label: p.name }))}
                placeholder="zhipuai / moonshotai / volcengine / openai / …"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-base-url">Base URL（留空用注册表默认端点）</Label>
              <Input id="provider-base-url" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={providerMeta?.api ?? 'https://…'} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="provider-api-key">API Key（只写不回显{providerMeta?.env[0] ? ` · 环境变量 ${providerMeta.env[0]}` : ''}）</Label>
              <Input id="provider-api-key" type="password" autoComplete="off" required value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
            </div>
            <Button type="submit" disabled={saveProvider.isPending || !provider}>
              {saveProvider.isPending ? '保存中…' : '保存'}
            </Button>
          </form>
          <p className="mt-3 text-[11.5px] text-muted-foreground">
            保存后，下方会出现该 Provider 可开启的模型列表；勾选即写入目录并即刻对 ai-drama 生效。已有目录条目：{catalogCount}
          </p>
        </CardContent>
      </Card>

      {credentials.map((cred) => (
        <ProviderModelsSection
          key={`${cred.provider}::${cred.baseUrl}`}
          providerId={cred.provider}
          baseUrl={cred.baseUrl}
          defaultOpen
        />
      ))}
      {credentials.length === 0 && !credentialsQuery.isLoading && (
        <Card>
          <CardContent className="text-[13px] text-muted-foreground">
            还没有配置任何 Provider — 在上方选择厂商、填写 API Key 并保存，这里就会列出可开启的模型。
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>已启用的模型</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {(textRows?.length ?? 0) + (mediaRows?.length ?? 0) === 0 ? (
            <div className="p-5 text-[13px] text-muted-foreground">目录为空</div>
          ) : (
            <>
              {textRows && textRows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>目录 ID</TableHead>
                      <TableHead>展示名</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>默认</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {textRows.map((row) => (
                      <TableRow key={row.id}>
                        <TableCell className="font-medium">{row.id}</TableCell>
                        <TableCell>{row.displayName ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{row.provider}</TableCell>
                        <TableCell><Badge variant="secondary">文本</Badge></TableCell>
                        <TableCell>{row.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="outline">停用</Badge>}</TableCell>
                        <TableCell>{row.isDefault ? <Badge variant="warning">默认</Badge> : '—'}</TableCell>
                        <TableCell>
                          <div className="flex gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                void adminApi.saveModel({ id: row.id, provider: row.provider, model: row.model, displayName: row.displayName ?? undefined, baseURL: row.baseUrl ?? undefined, enabled: !row.enabled })
                                  .then(refreshCatalog)
                              }}
                            >
                              {row.enabled ? '停用' : '启用'}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {mediaRows && mediaRows.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>目录 ID</TableHead>
                      <TableHead>展示名</TableHead>
                      <TableHead>Provider</TableHead>
                      <TableHead>类型</TableHead>
                      <TableHead>状态</TableHead>
                      <TableHead>操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mediaRows.map((row) => (
                      <TableRow key={`${row.kind}-${row.id}`}>
                        <TableCell className="font-medium">{row.id}</TableCell>
                        <TableCell>{row.displayName ?? '—'}</TableCell>
                        <TableCell className="text-muted-foreground">{row.provider}</TableCell>
                        <TableCell><Badge variant="secondary">{KIND_LABELS[row.kind] ?? row.kind}</Badge></TableCell>
                        <TableCell>{row.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="outline">停用</Badge>}</TableCell>
                        <TableCell>—</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>

    </div>
  )
}
