import { api, TIMEOUT } from '@/shared/api/client'
import type { CreativeDraft, CreativeProject } from './model'

export const creativeApi = {
  get: (id: number, signal?: AbortSignal) => api.get<CreativeProject>(`/creative/${id}`, { signal }),
  save: (id: number, draft: CreativeDraft) => api.put<CreativeProject>(`/creative/${id}`, draft),
  plan: (id: number, revision: number) => api.post<CreativeProject>(`/creative/${id}/plan`, { revision }, { timeoutMs: TIMEOUT.agent }),
  approve: (id: number, revision: number) => api.post<CreativeProject>(`/creative/${id}/approve`, { revision }),
  generate: (id: number, shotId: string, kind: 'image' | 'video', revision: number) =>
    api.post<CreativeProject>(`/creative/${id}/shots/${encodeURIComponent(shotId)}/generate`, { kind, revision }),
  render: (id: number, revision: number, options?: { individual?: boolean; shotIds?: string[] }) => api.post<CreativeProject>(`/creative/${id}/render`, { revision, ...options }),
  sourceUpload: (id: number, revision: number, file: File) => api.upload<CreativeProject>(`/creative/${id}/sources/upload?revision=${revision}`, file, { timeoutMs: 300000 }),
  sourceTranscribe: (id:number,revision:number,sourceId:string) => api.post<CreativeProject>(`/creative/${id}/sources/${encodeURIComponent(sourceId)}/transcribe`,{revision},{timeoutMs:360000}),
  sourceArrange: (id: number, input: { revision: number; sourceId: string; selections?: { start: number; end: number; title: string; caption: string }[]; srt?: string; replace?: boolean }) => api.post<CreativeProject>(`/creative/${id}/sources/arrange`, input),
  translate: (id: number, revision: number) => api.post<CreativeProject>(`/creative/${id}/translate`, { revision }, { timeoutMs: TIMEOUT.agent }),
}
