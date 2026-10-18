// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CreativeProductionFiles } from './CreativeProductionFiles'

afterEach(cleanup)

it('previews actual images, video and audio while retaining downloads for data outputs', () => {
  const { container } = render(
    <CreativeProductionFiles
      files={[
        { kind: 'image', name: '示意图', url: 'static/creative/1/diagram.png' },
        { kind: 'video', name: '成片', url: '/static/creative/1/final.mp4' },
        { kind: 'audio', name: '配乐', url: '/static/creative/1/music.wav' },
        { kind: 'data', name: '分析结果', url: '/static/creative/1/report.json' },
      ]}
    />,
  )
  expect(screen.getByRole('img', { name: '示意图' }).getAttribute('src')).toBe(
    '/static/creative/1/diagram.png',
  )
  expect(container.querySelector('video')?.getAttribute('src')).toBe('/static/creative/1/final.mp4')
  expect(container.querySelector('audio')?.getAttribute('src')).toBe('/static/creative/1/music.wav')
  expect(screen.getByRole('link', { name: '分析结果' }).getAttribute('download')).toBe('')
  expect(container.querySelector('iframe')).toBeNull()
})

it('does not render executable or protocol-relative output URLs', () => {
  const { container } = render(
    <CreativeProductionFiles
      files={[
        { kind: 'image', name: '无效图片', url: 'javascript:alert(1)' },
        { kind: 'data', name: '无效页面', url: '//untrusted.test/payload.html' },
      ]}
    />,
  )
  expect(container.querySelector('a, img, iframe')).toBeNull()
  expect(screen.getByText('无效图片：输出地址无法预览')).toBeTruthy()
})
