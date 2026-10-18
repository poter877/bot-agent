/** 上传 API（multipart；响应 { url, path }） */
import { api } from '@/shared/api/client'

export interface UploadResult {
  url: string
  path: string
}

export const uploadApi = {
  image: (file: File, signal?: AbortSignal) => api.upload<UploadResult>('/upload/image', file, { signal }),
  video: (file: File, signal?: AbortSignal) => api.upload<UploadResult>('/upload/video', file, { signal }),
  audio: (file: File, signal?: AbortSignal) => api.upload<UploadResult>('/upload/audio', file, { signal }),
}
