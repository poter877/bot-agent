/** AI 配置查询 */
import { queryOptions } from '@tanstack/react-query'
import { qk } from '@/shared/api/query-keys'
import { aiConfigApi, aiProviderApi } from './model'

export const aiConfigQueries = {
  list: (serviceType?: string) =>
    queryOptions({
      queryKey: qk.aiConfigs(serviceType),
      queryFn: ({ signal }) => aiConfigApi.list(serviceType as 'text' | 'image' | 'video' | undefined, signal),
      staleTime: 30_000,
    }),
  providers: () =>
    queryOptions({
      queryKey: qk.aiProviders(),
      queryFn: ({ signal }) => aiProviderApi.list(signal),
      staleTime: 5 * 60_000,
    }),
}
