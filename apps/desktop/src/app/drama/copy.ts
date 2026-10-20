import { useI18n } from '@/i18n'
import type { BundledLocale } from '@/i18n'

// The embedded studio renders its OWN localized copy (i18next, four locales);
// this is the shell's label for the sidebar row and the workspace tab.
const en = { title: 'Video studio' }

const copy: Record<BundledLocale, typeof en> = {
  en,
  zh: { title: '视频工厂' },
  'zh-hant': { title: '影片工廠' },
  ja: { title: '動画スタジオ' },
  de: { title: 'Videostudio' },
  fr: { title: 'Studio vidéo' },
  es: { title: 'Estudio de vídeo' },
  ru: { title: 'Видеостудия' },
  ar: { title: 'استوديو الفيديو' }
}

export function useDramaCopy() {
  const { locale } = useI18n()

  return copy[locale as BundledLocale] ?? en
}
