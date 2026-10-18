import { queryOptions } from '@tanstack/react-query'
import { creativeApi } from './api'
import { hasCreativeActivity } from './model'
import { WORKSPACE_SCOPE } from '@/shared/api/query-keys'

export const creativeQueries = {
  detail: (id: number) => queryOptions({
    queryKey: ['workspace', WORKSPACE_SCOPE, 'creative', id] as const,
    queryFn: ({ signal }) => creativeApi.get(id, signal),
    enabled: Number.isInteger(id) && id > 0,
    staleTime: 5000,
    refetchInterval: (query) => query.state.data && hasCreativeActivity(query.state.data) ? 2500 : false,
  }),
}
