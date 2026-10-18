import { useQuery } from '@tanstack/react-query'
import { api } from '@/shared/api/client'
import { useUiLocale } from '@/shared/config/use-locale'
export type CatalogText = { zh: string; en: string; ja: string; ko: string }
export interface CreativeRecipe {
  id: string; group: 'story' | 'business' | 'presenter' | 'reuse'; title: CatalogText; description: CatalogText
  duration: number; mediaType: 'image' | 'video'; source: 'optional' | 'video' | 'audio-video'
  fields: { key: string; label: CatalogText; placeholder: CatalogText }[]
  steps: CatalogText[]; note: CatalogText
}
export const creativeCatalogApi = { list: (signal?: AbortSignal) => api.get<CreativeRecipe[]>('/creative/catalog', { signal }) }
export function useCreativeCatalog(enabled = true) {
  return useQuery({ queryKey: ['creative-catalog'], queryFn: ({ signal }) => creativeCatalogApi.list(signal), staleTime: 300000, enabled })
}
export function useCatalogText() {
  const locale = useUiLocale()
  return (value?: CatalogText) => value?.[locale] || value?.en || ''
}
export function useProductionText() {
  const locale = useUiLocale()
  return (zh: string, en: string) => locale === 'zh' ? zh : en
}
