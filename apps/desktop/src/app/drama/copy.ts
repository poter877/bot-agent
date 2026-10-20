import { useI18n } from '@/i18n'
import type { BundledLocale } from '@/i18n'

const en = {
  title: 'Video studio',
  loading: 'Opening the video studio…',
  unreachableTitle: 'Cannot reach the video studio',
  unreachableDescription: 'Check that bot-backend is running and the address is correct.',
  retry: 'Retry',
  reload: 'Reload',
  openExternal: 'Open in browser',
  editUrl: 'Change address',
  urlLabel: 'Service address',
  invalidUrl: 'Enter an http(s) address, e.g. http://localhost:30172',
  save: 'Save',
  cancel: 'Cancel'
}

const copy: Record<BundledLocale, typeof en> = {
  en,
  zh: {
    title: '视频工厂',
    loading: '正在打开视频工厂…',
    unreachableTitle: '无法连接视频工厂',
    unreachableDescription: '请确认 bot-backend 已启动，且服务地址正确。',
    retry: '重试',
    reload: '刷新',
    openExternal: '在浏览器中打开',
    editUrl: '更改地址',
    urlLabel: '服务地址',
    invalidUrl: '请输入 http(s) 地址，例如 http://localhost:30172',
    save: '保存',
    cancel: '取消'
  },
  'zh-hant': {
    title: '影片工廠',
    loading: '正在開啟影片工廠…',
    unreachableTitle: '無法連線影片工廠',
    unreachableDescription: '請確認 bot-backend 已啟動，且服務位址正確。',
    retry: '重試',
    reload: '重新整理',
    openExternal: '在瀏覽器開啟',
    editUrl: '變更位址',
    urlLabel: '服務位址',
    invalidUrl: '請輸入 http(s) 位址，例如 http://localhost:30172',
    save: '儲存',
    cancel: '取消'
  },
  ja: {
    title: '動画スタジオ',
    loading: '動画スタジオを開いています…',
    unreachableTitle: '動画スタジオに接続できません',
    unreachableDescription: 'bot-backend が起動していて、サービスアドレスが正しいか確認してください。',
    retry: '再試行',
    reload: '再読み込み',
    openExternal: 'ブラウザで開く',
    editUrl: 'アドレスを変更',
    urlLabel: 'サービスアドレス',
    invalidUrl: 'http(s) のアドレスを入力してください（例: http://localhost:30172）',
    save: '保存',
    cancel: 'キャンセル'
  },
  de: {
    title: 'Videostudio',
    loading: 'Videostudio wird geöffnet…',
    unreachableTitle: 'Videostudio nicht erreichbar',
    unreachableDescription: 'Prüfe, ob bot-backend läuft und die Dienstadresse stimmt.',
    retry: 'Erneut versuchen',
    reload: 'Neu laden',
    openExternal: 'Im Browser öffnen',
    editUrl: 'Adresse ändern',
    urlLabel: 'Dienstadresse',
    invalidUrl: 'Gib eine http(s)-Adresse ein, z. B. http://localhost:30172',
    save: 'Speichern',
    cancel: 'Abbrechen'
  },
  fr: {
    title: 'Studio vidéo',
    loading: 'Ouverture du studio vidéo…',
    unreachableTitle: 'Studio vidéo inaccessible',
    unreachableDescription: "Vérifie que bot-backend est en cours d'exécution et que l'adresse du service est correcte.",
    retry: 'Réessayer',
    reload: 'Recharger',
    openExternal: 'Ouvrir dans le navigateur',
    editUrl: "Changer l'adresse",
    urlLabel: 'Adresse du service',
    invalidUrl: 'Saisis une adresse http(s), p. ex. http://localhost:30172',
    save: 'Enregistrer',
    cancel: 'Annuler'
  },
  es: {
    title: 'Estudio de vídeo',
    loading: 'Abriendo el estudio de vídeo…',
    unreachableTitle: 'No se puede conectar al estudio de vídeo',
    unreachableDescription: 'Comprueba que bot-backend esté en ejecución y que la dirección del servicio sea correcta.',
    retry: 'Reintentar',
    reload: 'Recargar',
    openExternal: 'Abrir en el navegador',
    editUrl: 'Cambiar dirección',
    urlLabel: 'Dirección del servicio',
    invalidUrl: 'Introduce una dirección http(s), p. ej. http://localhost:30172',
    save: 'Guardar',
    cancel: 'Cancelar'
  },
  ru: {
    title: 'Видеостудия',
    loading: 'Открываем видеостудию…',
    unreachableTitle: 'Видеостудия недоступна',
    unreachableDescription: 'Проверьте, что bot-backend запущен и адрес сервиса указан верно.',
    retry: 'Повторить',
    reload: 'Обновить',
    openExternal: 'Открыть в браузере',
    editUrl: 'Изменить адрес',
    urlLabel: 'Адрес сервиса',
    invalidUrl: 'Введите http(s)-адрес, например http://localhost:30172',
    save: 'Сохранить',
    cancel: 'Отмена'
  },
  ar: {
    title: 'استوديو الفيديو',
    loading: 'جارٍ فتح استوديو الفيديو…',
    unreachableTitle: 'تعذّر الوصول إلى استوديو الفيديو',
    unreachableDescription: 'تأكد من تشغيل bot-backend ومن صحة عنوان الخدمة.',
    retry: 'إعادة المحاولة',
    reload: 'إعادة التحميل',
    openExternal: 'فتح في المتصفح',
    editUrl: 'تغيير العنوان',
    urlLabel: 'عنوان الخدمة',
    invalidUrl: 'أدخل عنوان http(s)، مثل http://localhost:30172',
    save: 'حفظ',
    cancel: 'إلغاء'
  }
}

export function useDramaCopy() {
  const { locale } = useI18n()

  return copy[locale as BundledLocale] ?? en
}
