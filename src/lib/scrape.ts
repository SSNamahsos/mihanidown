import {extensionFor, isMediaMime, safeFilename} from './format.js'
import {httpFetch, type FrontReply} from './front.js'

/**
 * Last resort for pages no extractor claims: fetch the HTML and read the media
 * out of it. Open Graph and Twitter Card tags first because they are what a page
 * publishes *on purpose*, then <video>/<img>/<source>, then JSON-LD.
 *
 * Deliberately regex-based rather than a DOM parser: pulling in a full HTML
 * parser to read a dozen attributes is not worth the dependency, and this only
 * ever runs on markup we are going to show to a human anyway.
 */

export type ScrapedMedia = {
  url: string
  kind: 'video' | 'audio' | 'image' | 'file'
  label: string
  mime?: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type ScrapeResult =
  | {ok: true; page: {url: string; title: string; description?: string; image?: string}; media: ScrapedMedia[]}
  | {ok: false; error: string}

const MAX_HTML_BYTES = 4 * 1024 * 1024

export async function scrapePage(url: string, signal?: AbortSignal): Promise<ScrapeResult> {
  let response: FrontReply
  try {
    response = await httpFetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      signal,
    })
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : 'the page could not be reached'}
  }

  if (!response.ok) return {ok: false, error: `the page answered ${response.status}`}

  const contentType = response.headers.get('content-type') ?? ''
  if (!contentType.includes('html')) {
    return {ok: false, error: `the page is ${contentType.split(';')[0] || 'not html'}`}
  }

  const body = await readCapped(response)
  const base = response.finalUrl || url
  const media = collectMedia(body, base)

  const title =
    metaContent(body, 'og:title') ??
    metaContent(body, 'twitter:title') ??
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body)?.[1]?.trim() ??
    base

  return {
    ok: true,
    page: {
      url: base,
      title: decodeEntities(safeFilename(title, 'page')),
      description: metaContent(body, 'og:description') ?? metaContent(body, 'description'),
      image: metaContent(body, 'og:image'),
    },
    media,
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const decoder = new TextDecoder('utf-8', {fatal: false})
  let out = ''
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_HTML_BYTES) {
      await reader.cancel()
      break
    }
    out += decoder.decode(value, {stream: true})
  }
  return out
}

function collectMedia(html: string, base: string): ScrapedMedia[] {
  const found = new Map<string, ScrapedMedia>()
  const add = (raw: string | undefined, kind: ScrapedMedia['kind'], label: string, mime?: string) => {
    if (!raw) return
    const absolute = absolutize(raw.trim(), base)
    if (!absolute || !/^https?:/i.test(absolute)) return
    if (found.has(absolute)) return
    // Some pages declare og:video pointing at *themselves* — YouTube's watch
    // page is the canonical case — which would make the picker offer the HTML
    // as a download. The page is not media; it is where we are already.
    if (samePage(absolute, base)) return
    found.set(absolute, {
      url: absolute,
      kind,
      label,
      mime: mime ?? guessMime(absolute),
    })
  }

  // 1. Open Graph / Twitter Card — the page's own declaration of what it is.
  for (const property of ['og:video', 'og:video:secure_url', 'og:video:url', 'og:audio', 'og:image', 'twitter:player:stream']) {
    add(metaContent(html, property), property.includes('audio') ? 'audio' : property.includes('image') ? 'image' : 'video', property, metaContent(html, `${property}:type`))
  }
  add(metaContent(html, 'twitter:image'), 'image', 'twitter:image')
  add(metaContent(html, 'twitter:image:src'), 'image', 'twitter:image:src')

  // 2. Elements. <source> inside <video> is where adaptive streams live.
  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const src = attr(match[0], 'src')
    const type = attr(match[0], 'type') ?? undefined
    const isAudio = type?.startsWith('audio/')
    add(src, isAudio ? 'audio' : 'video', type ?? 'source', type)
  }
  for (const match of html.matchAll(/<video\b[^>]*>/gi)) {
    add(attr(match[0], 'src'), 'video', 'video', attr(match[0], 'type') ?? undefined)
    add(attr(match[0], 'poster'), 'image', 'poster')
  }
  for (const match of html.matchAll(/<audio\b[^>]*>/gi)) {
    add(attr(match[0], 'src'), 'audio', 'audio', attr(match[0], 'type') ?? undefined)
  }
  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0]
    const src = attr(tag, 'src') ?? attr(tag, 'data-src') ?? attr(tag, 'data-lazy-src')
    const width = Number.parseInt(attr(tag, 'width') ?? '0', 10)
    const height = Number.parseInt(attr(tag, 'height') ?? '0', 10)
    const dimensions = width > 0 && height > 0 ? ` ${width}x${height}` : ''
    add(src, 'image', `img${dimensions}`)
  }

  // 3. JSON-LD VideoObject contentUrl
  for (const match of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    const body = match[1]
    if (!body) continue
    for (const urlMatch of body.matchAll(/"(?:contentUrl|embedUrl)"\s*:\s*"([^"]+)"/g)) {
      add(urlMatch[1], 'video', 'json-ld')
    }
  }

  // 4. A bare media url the page links to directly.
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+\.(?:mp4|webm|m4v|mov|mp3|m4a|flac)(\?[^"']*)?)["']/gi)) {
    const href = match[1]
    if (href === undefined) continue
    const audio = /\.(?:mp3|m4a|flac)(?:\?|$)/i.test(href)
    add(href, audio ? 'audio' : 'video', 'link')
  }

  return [...found.values()]
}

function metaContent(html: string, property: string): string | undefined {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, 'i'),
    new RegExp(`<meta[^>]+content=["'][^"']*["'][^>]*(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, 'i'),
  ]
  for (const pattern of patterns) {
    const tag = pattern.exec(html)?.[0]
    if (tag) {
      const value = attr(tag, 'content')
      if (value) return value
    }
  }
  return undefined
}

function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const direct = new RegExp(`\\b${escaped}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1]
  if (direct !== undefined) return direct
  const single = new RegExp(`\\b${escaped}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1]
  if (single !== undefined) return single
  return new RegExp(`\\b${escaped}\\s*=\\s*([^\\s>]+)`, 'i').exec(tag)?.[1]
}

/** True when the candidate is the page we scraped, modulo hash and case. */
function samePage(candidate: string, base: string): boolean {
  try {
    const a = new URL(candidate)
    const b = new URL(base)
    return a.protocol === b.protocol && a.host === b.host && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, '')
  } catch {
    return false
  }
}

export function absolutize(candidate: string, base: string): string | null {
  try {
    const resolved = new URL(candidate, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:' ? resolved.toString() : null
  } catch {
    return null
  }
}

function guessMime(url: string): string | undefined {
  const ext = extensionFor(undefined, url)
  if (!ext) return undefined
  return `application/${ext}`
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

export function decodeEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, m => ENTITIES[m] ?? m)
}

/** Group scraped results so the sheet can present them as a list, not a wall. */
export function groupByKind(media: ScrapedMedia[]): Record<ScrapedMedia['kind'], ScrapedMedia[]> {
  const groups: Record<ScrapedMedia['kind'], ScrapedMedia[]> = {video: [], audio: [], image: [], file: []}
  for (const item of media) groups[item.kind].push(item)
  return groups
}

export {isMediaMime}