import {
  jsonRequest,
  num,
  outputJson,
  outputRemote,
  required,
  serviceUrl,
  str,
  type OutputKind,
  type ProviderContext,
  type ProviderDependencies,
  type ProviderResult,
} from './provider-runtime.js'
export const stockToolSpecs = {
  pexels_image: { serviceType: 'stock', provider: 'pexels', model: 'search' },
  pexels_video: { serviceType: 'stock', provider: 'pexels', model: 'search' },
  pexels: { serviceType: 'stock', provider: 'pexels', model: 'search' },
  pixabay_image: { serviceType: 'stock', provider: 'pixabay', model: 'search' },
  pixabay_video: { serviceType: 'stock', provider: 'pixabay', model: 'search' },
  freesound_music: {
    serviceType: 'stock',
    provider: 'freesound',
    model: 'search',
  },
  unsplash: { serviceType: 'stock', provider: 'unsplash', model: 'search' },
  nasa: {
    serviceType: 'stock',
    provider: 'nasa',
    model: 'search',
    requiresApiKey: false,
  },
  wikimedia: {
    serviceType: 'stock',
    provider: 'wikimedia',
    model: 'search',
    requiresApiKey: false,
  },
  archive_org: {
    serviceType: 'stock',
    provider: 'archive_org',
    model: 'search',
    requiresApiKey: false,
  },
  loc: {
    serviceType: 'stock',
    provider: 'loc',
    model: 'search',
    requiresApiKey: false,
  },
} as const
interface StockItem {
  id: string
  title: string
  url: string
  preview?: string
  downloadUrl?: string
  kind: 'image' | 'video' | 'audio'
  author?: string
  license: string
  licenseUrl?: string
  duration?: number
}
function imageOrVideo(ctx: ProviderContext) {
  return ctx.toolId.endsWith('_video') || str(ctx.args, 'media_type') === 'video' ? 'video' : 'image'
}
const domains: Record<string, string[]> = {
  pexels: ['pexels.com', 'videos.pexels.com'],
  pixabay: ['pixabay.com', 'pixabaycdn.com'],
  freesound: ['freesound.org'],
  unsplash: ['unsplash.com'],
  nasa: ['nasa.gov'],
  wikimedia: ['wikimedia.org'],
  archive_org: ['archive.org'],
  loc: ['loc.gov'],
}
export async function runStock(ctx: ProviderContext, deps: ProviderDependencies): Promise<ProviderResult> {
  const config = ctx.config!,
    provider = config.provider,
    query = required(ctx.args, ['query', 'search_query', 'prompt'], '素材搜索词'),
    count = Math.round(num(ctx.args, ['count', 'limit', 'per_page'], 8, 1, 30)),
    media = imageOrVideo(ctx),
    base = serviceUrl(config, ''),
    items: StockItem[] = [],
    tracking = new Map<string, string>()
  const get = (suffix: string, params: Record<string, string>, headers: Record<string, string> = {}) =>
    jsonRequest(ctx, deps, `${base}${suffix}?${new URLSearchParams(params)}`, {
      headers,
    })
  if (provider === 'pexels') {
    const data = await get(
      media === 'video' ? '/v1/videos/search' : '/v1/search',
      {
        query,
        per_page: String(count),
        orientation: str(ctx.args, 'orientation', 'landscape'),
      },
      { Authorization: config.apiKey },
    )
    if (media === 'image')
      for (const p of data.photos || [])
        items.push({
          id: String(p.id),
          title: p.alt || query,
          url: p.url,
          preview: p.src?.medium,
          downloadUrl: p.src?.large2x || p.src?.original,
          kind: 'image',
          author: p.photographer,
          license: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
        })
    else
      for (const p of data.videos || []) {
        const variants = (p.video_files || [])
          .filter((v: any) => v.file_type === 'video/mp4' && v.width <= 1920)
          .sort((a: any, b: any) => (b.width || 0) - (a.width || 0))
        items.push({
          id: String(p.id),
          title: query,
          url: p.url,
          preview: p.image,
          downloadUrl: variants[0]?.link,
          kind: 'video',
          author: p.user?.name,
          license: 'Pexels License',
          licenseUrl: 'https://www.pexels.com/license/',
          duration: p.duration,
        })
      }
  } else if (provider === 'pixabay') {
    const data = await get(media === 'video' ? '/api/videos/' : '/api/', {
      key: config.apiKey,
      q: query,
      per_page: String(Math.max(3, count)),
      safesearch: 'true',
      ...(media === 'image' ? { image_type: 'photo' } : {}),
    })
    for (const p of data.hits || [])
      items.push({
        id: String(p.id),
        title: p.tags || query,
        url: p.pageURL,
        preview: p.previewURL,
        downloadUrl:
          media === 'video'
            ? p.videos?.medium?.url || p.videos?.small?.url
            : p.largeImageURL || p.webformatURL,
        kind: media,
        author: p.user,
        license: 'Pixabay Content License',
        licenseUrl: 'https://pixabay.com/service/license-summary/',
        duration: p.duration,
      })
  } else if (provider === 'freesound') {
    const data = await get(
      '/apiv2/search/text/',
      {
        query,
        page_size: String(count),
        fields: 'id,name,url,username,license,previews,duration',
      },
      { Authorization: `Token ${config.apiKey}` },
    )
    for (const p of data.results || [])
      items.push({
        id: String(p.id),
        title: p.name,
        url: p.url,
        downloadUrl: p.previews?.['preview-hq-mp3'] || p.previews?.['preview-lq-mp3'],
        kind: 'audio',
        author: p.username,
        license: p.license || '请核对来源授权',
        licenseUrl: p.license,
        duration: p.duration,
      })
  } else if (provider === 'unsplash') {
    const data = await get(
      '/search/photos',
      { query, per_page: String(count) },
      { Authorization: `Client-ID ${config.apiKey}`, 'Accept-Version': 'v1' },
    )
    for (const p of data.results || []) {
      if (typeof p.links?.download_location === 'string') tracking.set(p.id, p.links.download_location)
      items.push({
        id: p.id,
        title: p.alt_description || p.description || query,
        url: p.links?.html,
        preview: p.urls?.small,
        downloadUrl: p.urls?.regular,
        kind: 'image',
        author: p.user?.name,
        license: 'Unsplash License',
        licenseUrl: 'https://unsplash.com/license',
      })
    }
  } else if (provider === 'nasa') {
    const data = await get('/search', {
      q: query,
      media_type: media,
      page_size: String(count),
    })
    for (const p of data.collection?.items || []) {
      const entry = p.data?.[0] || {},
        id = entry.nasa_id
      let downloadUrl = p.links?.[0]?.href
      if (media === 'video' && typeof p.href === 'string') {
        const u = new URL(p.href)
        if (u.hostname.endsWith('.nasa.gov') || u.hostname === 'nasa.gov') {
          const asset = await jsonRequest(ctx, deps, p.href)
          downloadUrl = Array.isArray(asset)
            ? asset.find((v: any) => typeof v === 'string' && /~(medium|small)\.mp4$/.test(v))
            : undefined
        }
      }
      items.push({
        id: String(id),
        title: entry.title || query,
        url: `https://images.nasa.gov/details/${encodeURIComponent(String(id))}`,
        preview: p.links?.[0]?.href,
        downloadUrl,
        kind: media,
        author: entry.photographer || entry.center,
        license: 'NASA 使用政策；请核对个别第三方素材署名',
        licenseUrl: 'https://www.nasa.gov/nasa-brand-center/images-and-media/',
        duration: undefined,
      })
    }
  } else if (provider === 'wikimedia') {
    const data = await get('/w/api.php', {
      action: 'query',
      format: 'json',
      generator: 'search',
      gsrsearch: `${query} filetype:${media === 'video' ? 'video' : 'bitmap'}`,
      gsrnamespace: '6',
      gsrlimit: String(count),
      prop: 'imageinfo',
      iiprop: 'url|extmetadata',
      iiurlwidth: '640',
    })
    for (const p of Object.values(data.query?.pages || {}) as any[]) {
      const i = p.imageinfo?.[0]
      if (!i) continue
      const meta = i.extmetadata || {}
      const clean = (v: any) =>
        String(v?.value || '')
          .replace(/<[^>]*>/g, '')
          .slice(0, 1000)
      items.push({
        id: String(p.pageid),
        title: p.title,
        url: i.descriptionurl,
        preview: i.thumburl,
        downloadUrl: i.url,
        kind: media,
        author: clean(meta.Artist),
        license: clean(meta.LicenseShortName) || '请核对来源授权',
        licenseUrl: clean(meta.LicenseUrl),
      })
    }
  } else if (provider === 'archive_org') {
    const data = await get('/advancedsearch.php', {
      q: `(${query}) AND mediatype:${media === 'video' ? 'movies' : 'image'}`,
      output: 'json',
      'fl[]': 'identifier,title,creator,licenseurl',
      rows: String(count),
      page: '1',
    })
    for (const p of data.response?.docs || []) {
      const id = String(p.identifier)
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(id)) continue
      const meta = await jsonRequest(ctx, deps, `${base}/metadata/${encodeURIComponent(id)}`),
        files = (meta.files || []).filter((f: any) =>
          media === 'video' ? /\.mp4$/i.test(f.name) : /\.(jpg|png|jpeg)$/i.test(f.name),
        )
      const file = files.find((f: any) => f.source === 'original') || files[0]
      items.push({
        id,
        title: p.title || query,
        url: `https://archive.org/details/${id}`,
        preview: `https://archive.org/services/img/${id}`,
        downloadUrl: file
          ? `${base}/download/${encodeURIComponent(id)}/${encodeURIComponent(file.name)}`
          : undefined,
        kind: media,
        author: Array.isArray(p.creator) ? p.creator.join(', ') : p.creator,
        license: String(meta.metadata?.licenseurl || p.licenseurl || '请核对条目权利说明'),
        licenseUrl: meta.metadata?.licenseurl,
      })
    }
  } else if (provider === 'loc') {
    const data = await get('/search/', {
      q: query,
      fo: 'json',
      c: String(count),
      fa: `original-format:${media === 'video' ? 'film, video' : 'photo, print, drawing'}`,
    })
    for (const p of data.results || []) {
      items.push({
        id: p.id || p.url,
        title: p.title || query,
        url: p.url || p.id,
        preview: p.image_url?.[0],
        downloadUrl: media === 'image' ? p.image_url?.at(-1) : undefined,
        kind: media,
        author: p.contributor?.join(', '),
        license: p.rights?.join(' ') || '请查看条目的 Rights & Access',
        licenseUrl: p.url || p.id,
      })
    }
  } else throw new Error('此素材服务尚不受支持')
  const limited = items.slice(0, count),
    files: ProviderResult['files'] = []
  let attribution = ''
  if (ctx.args.download === true) {
    const selected = str(ctx.args, 'selected_id'),
      chosen = selected
        ? limited.find((i) => i.id === selected)
        : limited[Math.round(num(ctx.args, 'index', 0, 0, Math.max(0, limited.length - 1)))]
    if (!chosen?.downloadUrl) throw new Error('没有可直接下载的选中素材，请先查看搜索结果或重新选择')
    attribution = [chosen.author, chosen.url, chosen.license, chosen.licenseUrl].filter(Boolean).join(' · ')
    const track = tracking.get(chosen.id)
    if (track) {
      if (new URL(track).origin !== new URL(base).origin) throw new Error('Unsplash 返回的下载跟踪地址无效')
      await jsonRequest(ctx, deps, track, {
        headers: { Authorization: `Client-ID ${config.apiKey}` },
      })
    }
    files.push(await outputRemote(ctx, deps, chosen.downloadUrl, chosen.kind, domains[provider]))
    files.push(await outputJson(ctx, { provider, query, source: chosen }, 'source-credit.json'))
  } else files.push(await outputJson(ctx, { provider, query, items: limited }, 'stock-search.json'))
  ctx.progress(100)
  return {
    summary:
      ctx.args.download === true ? '素材已导入，来源和授权信息已保存' : `找到 ${limited.length} 条素材`,
    files,
    data: { provider, query, items: limited, attribution },
  }
}
