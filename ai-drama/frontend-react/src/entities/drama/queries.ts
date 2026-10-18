/** 项目查询：queryOptions 与路由 loader、页面 useQuery 共用 */
import { queryOptions } from '@tanstack/react-query'
import { qk } from '@/shared/api/query-keys'
import { dramaApi } from './api'
import type { DramaListFilters } from './model'

export const dramaQueries = {
  list: (filters: DramaListFilters = {}) =>
    queryOptions({
      queryKey: qk.dramas(filters),
      queryFn: ({ signal }) => dramaApi.list(filters, signal),
      staleTime: 20_000,
      gcTime: 5 * 60_000,
    }),

  detail: (dramaId: number) =>
    queryOptions({
      queryKey: qk.dramaDetail(dramaId),
      queryFn: ({ signal }) => dramaApi.get(dramaId, signal),
      enabled: Number.isInteger(dramaId) && dramaId > 0,
      staleTime: 20_000,
      gcTime: 5 * 60_000,
    }),
}
