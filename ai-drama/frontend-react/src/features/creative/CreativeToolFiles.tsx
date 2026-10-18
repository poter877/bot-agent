import { createElement, useEffect, useState } from 'react'
import type { ToolFile } from '@/entities/creative/tools'
import { Button } from '@/shared/ui/button'
function ModelPreview({ file }: { file: ToolFile }) {
  const [open, setOpen] = useState(false),
    [ready, setReady] = useState(false),
    [error, setError] = useState(false)
  useEffect(() => {
    if (!open) return
    let active = true
    void import('@google/model-viewer')
      .then(() => {
        if (active) setReady(true)
      })
      .catch(() => {
        if (active) setError(true)
      })
    return () => {
      active = false
    }
  }, [open])
  return (
    <>
      <Button size="sm" onClick={() => setOpen(!open)}>
        {open ? '收起模型' : '预览模型与动作'}
      </Button>
      {open &&
        (error ? (
          <p role="alert">预览组件无法加载，请下载模型检查。</p>
        ) : ready ? (
          createElement('model-viewer', {
            src: file.url,
            'camera-controls': true,
            autoplay: true,
            'auto-rotate': true,
            alt: file.name,
            style: { width: '100%', height: 320 },
            onError: () => setError(true),
          })
        ) : (
          <p role="status">正在加载三维预览…</p>
        ))}
    </>
  )
}
export function CreativeToolFiles({ files }: { files: ToolFile[] }) {
  return (
    <div className="space-y-3">
      {files.map((file) => (
        <div key={file.url} className="space-y-2 rounded-control border border-outline p-3">
          <a href={file.url} download className="text-sm text-brand-content underline">
            下载 {file.name}
          </a>
          {file.metadata && (
            <p className="text-xs text-content-muted">
              {file.metadata.meshes} 个网格 · {file.metadata.joints} 个关节 · {file.metadata.animations}{' '}
              段动画
            </p>
          )}
          {file.kind === 'video' ? (
            <video src={file.url} controls preload="metadata" className="max-h-72 w-full rounded-control" />
          ) : file.url.endsWith('.glb') ? (
            <ModelPreview file={file} />
          ) : null}
        </div>
      ))}
    </div>
  )
}
