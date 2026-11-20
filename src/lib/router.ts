import {probe, buildChoices, buildDirectChoice, type Environment, type ProbeSuccess, type Choice} from './ytdlp.js'
import {probeRemote, type Remote} from './direct.js'
import {groupByKind, scrapePage, type ScrapedMedia} from './scrape.js'
import {extensionFor, formatBytes, isAudioMime, isImageMime, isVideoMime} from './format.js'

/**
 * Route a url to whichever of the three engines can actually serve it.
 *
 * A cheap HEAD goes first because it settles the common case in ~200ms: if the
 * host answers with an image or a binary, we already know the filename, the size
 * and whether the server honours ranges, and we can draw a plate before a single
 * byte of the body is fetched. Only when the answer is HTML (or the host is
 * uncooperative) do we pay for the yt-dlp ladder, and scraping is the last
 * resort for pages no extractor claims.
 */
export type Resolved =
  | {kind: 'ytdlp'; probe: ProbeSuccess; choices: Choice[]; warning?: string}
  | {kind: 'direct'; remote: Remote; choices: Choice[]}
  | {
      kind: 'scrape'
      page: {url: string; title: string; description?: string; image?: string}
      groups: ReturnType<typeof groupByKind>
      media: ScrapedMedia[]
      choices: Choice[]
    }

export type ResolveHooks = {
  /** short status line, e.g. `HEAD probe` or `trying tv client` */
  status: (message: string) => void
  signal?: AbortSignal
}

const MEDIA_EXTENSIONS =
  /\.(jpe?g|png|webp|gif|avif|bmp|tiff?|svg|ico|mp4|webm|m4v|mov|mkv|avi|flv|mp3|m4a|aac|flac|opus|ogg|wav|pdf|zip|tar|gz)$/i

/** Query strings matter more than paths: CDN urls rarely end in an extension. */
function looksLikeDirectFile(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (MEDIA_EXTENSIONS.test(url.pathname)) return true
    const last = url.pathname.split('/').at(-1) ?? ''
    return last.includes('.') && MEDIA_EXTENSIONS.test(last)
  } catch {
    return false
  }
}

/**
 * Turn what was typed into something yt-dlp can act on.
 *
 * A link stays a link. A bare hostname gets the scheme people leave off. Anything
 * else is treated as words to search YouTube for, because typing a video's title
 * is what a person does when they do not have the link — and yt-dlp already
 * speaks `ytsearch<n>:<terms>`, so the ladder, the plate and the picker all work
 * on whatever comes back without a second code path.
 */
export function asTarget(input: string): string {
  const text = input.trim()
  if (!text) return text
  if (/^https?:\/\//i.test(text)) return text
  // `youtube.com/watch?v=…` with no scheme
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(:\d+)?(\/\S*)?$/i.test(text)) return `https://${text}`
  if (/^[\w.-]+$/.test(text) && !text.includes(' ')) {
    // One word with no dot is still more likely a search than a host.
    return `ytsearch1:${text}`
  }
  return `ytsearch1:${text}`
}

/** True when the text is a real link, so the direct engine is worth asking. */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

export async function resolve(
  url: string,
  env: Environment,
  options: {quality?: number} = {},
  hooks: ResolveHooks,
): Promise<Resolved | {kind: 'failed'; error: string; attempts: {client: string; error: string}[]}> {
  const {status, signal} = hooks
  // Everything downstream uses one string: the probe, the plate and the eventual
  // download have to ask for the same thing, or a search picks one video and
  // fetches another.
  const target = asTarget(url)
  const search = !isHttpUrl(target)

  if (!search) {
    if (looksLikeDirectFile(target)) {
      const direct = await probeRemote(target, signal)
      if (direct.ok) return {kind: 'direct', remote: direct.remote, choices: directChoices(direct.remote)}
      // an extension is a guess, not a promise — fall through rather than fail
    } else {
      status('HEAD probe')
      const direct = await probeRemote(target, signal)
      if (direct.ok && !isHtml(direct.remote.contentType)) {
        return {kind: 'direct', remote: direct.remote, choices: directChoices(direct.remote)}
      }
      if (direct.ok && isHtml(direct.remote.contentType)) {
        status('trying player clients')
        const probeResult = await probe(env, target, signal)
        if (probeResult.ok) {
          return {
            kind: 'ytdlp',
            probe: probeResult,
            choices: buildChoices(probeResult.info, options.quality),
            warning: describeWarnings(probeResult),
          }
        }
        status('reading the page directly')
        const scraped = await scrapePage(target, signal)
        if (scraped.ok && scraped.media.length > 0) {
          return {
            kind: 'scrape',
            page: scraped.page,
            groups: groupByKind(scraped.media),
            media: scraped.media,
            choices: await scrapedChoices(scraped.media),
          }
        }
        return {kind: 'failed', error: probeResult.error, attempts: probeResult.attempts}
      }
      // HEAD failed outright — the host may still serve the body fine.
    }
  }

  status(search ? 'searching youtube' : 'trying player clients')
  const probeResult = await probe(env, target, signal)
  if (probeResult.ok) {
    return {
      kind: 'ytdlp',
      probe: probeResult,
      choices: buildChoices(probeResult.info, options.quality),
      warning: describeWarnings(probeResult),
    }
  }

  if (search) return {kind: 'failed', error: probeResult.error, attempts: probeResult.attempts}

  status('reading the page directly')
  const scraped = await scrapePage(target, signal)
  if (scraped.ok && scraped.media.length > 0) {
    return {
      kind: 'scrape',
      page: scraped.page,
      groups: groupByKind(scraped.media),
      media: scraped.media,
      choices: await scrapedChoices(scraped.media),
    }
  }

  return {kind: 'failed', error: probeResult.error, attempts: probeResult.attempts}
}

function isHtml(contentType: string | undefined): boolean {
  return Boolean(contentType?.toLowerCase().includes('html'))
}

export function directChoices(remote: Remote): Choice[] {
  const size = remote.contentLength
  const ext = (extensionFor(remote.contentType, remote.finalUrl) ?? 'bin').slice(0, 8)
  const kind: Choice['kind'] = isImageMime(remote.contentType)
    ? 'image'
    : isVideoMime(remote.contentType)
      ? 'video'
      : isAudioMime(remote.contentType)
        ? 'audio'
        : 'file'
  return [
    {
      kind,
      label: `${ext.toUpperCase()} · ${kind === 'file' ? 'original file' : 'original'}`,
      detail: [
        (remote.contentType?.split(';')[0]?.replace(/^(image|video|audio)\//, '') ?? ext).slice(0, 11),
        remote.acceptRanges ? 'resumable' : 'one shot',
        formatBytes(size),
      ],
      args: ['-f', 'best'],
      estimate: size,
    },
  ]
}

function describeWarnings(probe: ProbeSuccess): string | undefined {
  const token = probe.warnings.find(w => /po.?token|sabr/i.test(w))
  if (token) {
    return 'YouTube withheld the top formats without a proof-of-origin token — a local provider unlocks them.'
  }
  return probe.warnings[0]
}

/* ------------------------------------------------------------------ *
 * Scraped media -> choices, so the picker looks the same for all three engines
 * ------------------------------------------------------------------ */

/**
 * Scraped media -> choices, so the picker looks the same whichever engine
 * answered. Sizes are unknown until asked for, so probe the first handful in
 * parallel and let the sheet print real numbers instead of guesses.
 */
export async function scrapedChoices(media: ScrapedMedia[], limit = 12): Promise<Choice[]> {
  const head = media.slice(0, limit)
  const sizes = await Promise.all(
    head.map(async item => {
      try {
        const probed = await probeRemote(item.url)
        return probed.ok ? probed.remote.contentLength : undefined
      } catch {
        return undefined
      }
    }),
  )

  return head.map((item, index) => {
    const ext = (extensionFor(item.mime, item.url) ?? 'bin').slice(0, 8)
    const size = sizes[index]
    return {
      kind: item.kind,
      label: item.label === 'link' ? `${ext} \u00b7 linked from the page` : `${ext} \u00b7 ${item.label}`,
      detail: [ext, item.kind.slice(0, 8), formatBytes(size)],
      args: ['-f', 'best'],
      estimate: size,
      /** headless mode needs the original url for a scraped row */
      sourceUrl: item.url,
    }
  })
}

export {buildDirectChoice, groupByKind}