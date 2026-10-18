/** workspace scope：数据工作区身份的非敏感代次标识，进入 queryKey 前缀。 */
export const WORKSPACE_SCOPE = 'default'

export const qk = {
  dramas: (filters?: object) =>
    ['workspace', WORKSPACE_SCOPE, 'dramas', 'list', filters ?? {}] as const,
  dramaDetail: (dramaId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'dramas', dramaId, 'detail'] as const,
  episodeResource: (episodeId: number, resource: string) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, resource] as const,
  episodeJobs: (episodeId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, 'jobs'] as const,
  episodePipeline: (episodeId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, 'pipeline'] as const,
  extractStatus: (episodeId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, 'extract-status'] as const,
  promptBatch: (episodeId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, 'prompt-batch'] as const,
  merges: (episodeId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'episodes', episodeId, 'merges'] as const,
  task: (taskId: number) =>
    ['workspace', WORKSPACE_SCOPE, 'tasks', taskId] as const,
  aiConfigs: (type?: string) =>
    ['workspace', WORKSPACE_SCOPE, 'ai-configs', type ?? 'all'] as const,
  aiProviders: () => ['workspace', WORKSPACE_SCOPE, 'ai-providers'] as const,
  skills: (lang: string) => ['workspace', WORKSPACE_SCOPE, 'skills', lang] as const,
  prompts: (lang: string) => ['workspace', WORKSPACE_SCOPE, 'prompts', lang] as const,
  promptDetail: (type: string, lang: string) =>
    ['workspace', WORKSPACE_SCOPE, 'prompts', lang, type] as const,
  stylePresets: (all: boolean) =>
    ['workspace', WORKSPACE_SCOPE, 'style-presets', { all }] as const,
  storage: () => ['workspace', WORKSPACE_SCOPE, 'storage'] as const,
  serverUpdate: () => ['workspace', WORKSPACE_SCOPE, 'server-update'] as const,
  contentLanguage: () => ['workspace', WORKSPACE_SCOPE, 'settings', 'content-language'] as const,
}

/**
 * 存储目录迁移成功后调用：取消旧查询并整体清缓存，防止旧目录缓存污染新目录。
 * 页面随后整页 reload，重新以新数据源水合。
 */
export function resetWorkspaceCache(queryClient: { cancelQueries: () => Promise<void>; clear: () => void }) {
  void queryClient.cancelQueries()
  queryClient.clear()
}
