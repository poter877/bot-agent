/**
 * cn — className 合并（clsx + tailwind-merge）。
 *
 * 合并器只处理约定冲突组（如 bg-* 互斥、text-* 的字号/颜色组、rounded-*、
 * shadow-*）；cascade、状态 variants 与 DOM 层级不由 cn 解决。
 * 自定义语义 token（text-ui、rounded-panel、shadow-focus、bg-brand-gradient）
 * 的分组在 customConfig 显式登记，并有契约测试（cn.test.ts）保证不被误删。
 */
import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['ui', 'form', 'body', 'caption', 'micro', 'tiny'] }],
      'text-color': [
        {
          text: [
            'content',
            'content-secondary',
            'content-muted',
            'content-subtle',
            'brand',
            'brand-content',
            'on-action',
            'danger',
            'success',
            'info',
            'warning',
          ],
        },
      ],
      rounded: [{ rounded: ['item', 'control', 'panel', 'dialog', 'pill'] }],
      shadow: [{ shadow: ['focus', 'panel', 'card', 'dialog', 'raise', 'raised', 'item', 'brand-glow'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
