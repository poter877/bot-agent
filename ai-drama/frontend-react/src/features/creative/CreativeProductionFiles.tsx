import { Download } from 'lucide-react'
import { creativeMediaUrl } from '@/entities/creative/model'
import type { ToolboxFile } from '@/entities/creative/toolbox'
import { CreativeToolFiles } from './CreativeToolFiles'

function outputUrl(value: string) {
  const url = creativeMediaUrl(value)
  return /^(\/[^/]|https?:\/\/)/i.test(url) ? url : ''
}

export function CreativeProductionFiles({ files }: { files: ToolboxFile[] }) {
  return (
    <div className="grid min-w-0 gap-3 xl:grid-cols-2">
      {files.map((file) => {
        const url = outputUrl(file.url)
        if (!url)
          return (
            <p key={file.url} className="text-xs text-content-muted">
              {file.name}：输出地址无法预览
            </p>
          )
        return (
          <div key={file.url} className="min-w-0 space-y-2 rounded-control border border-outline p-3">
            {file.kind === 'model' ? (
              <CreativeToolFiles files={[{ ...file, url, kind: 'model' }]} />
            ) : (
              <>
                <a
                  href={url}
                  download
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex max-w-full items-center gap-2 break-all text-xs text-brand-content underline"
                >
                  <Download size={13} className="shrink-0" aria-hidden />
                  {file.name}
                </a>
                {file.kind === 'image' && (
                  <img
                    src={url}
                    alt={file.name}
                    loading="lazy"
                    className="max-h-72 max-w-full rounded-control object-contain"
                  />
                )}
                {file.kind === 'video' && (
                  <video
                    aria-label={file.name}
                    src={url}
                    controls
                    preload="metadata"
                    className="max-h-72 w-full rounded-control"
                  />
                )}
                {file.kind === 'audio' && (
                  <audio aria-label={file.name} src={url} controls preload="metadata" className="w-full" />
                )}
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
