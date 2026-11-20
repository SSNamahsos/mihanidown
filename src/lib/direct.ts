import fs from 'node:fs'
import fsPromises from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {safeFilename, extensionFor} from './format.js'
import {httpFetch} from './front.js'

/**
 * The generic path: any URL that isn't a page is just bytes. This is a real
 * downloader, not a fetch — ranged resume, streamed writes, live throughput,
 * Content-Disposition filenames and redirect following.
 */

export type Remote = {
  url: string
  /** after redirects */
  finalUrl: string
  contentType?: string
  contentLength?: number
  acceptRanges: boolean
  filename: string
  etag?: string
  lastModified?: string
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

export type ProbeRemote = {ok: true; remote: Remote} | {ok: false; error: string; contentType?: string}

export async function probeRemote(url: string, signal?: AbortSignal): Promise<ProbeRemote> {
  const headers: Record<string, string> = {
    'user-agent': UA,
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
  }

  // HEAD is cheaper but plenty of CDNs answer it with 405 or lie about length,
  // so fall back to a one-byte ranged GET before giving up on metadata.
  let response = await httpFetch(url, {method: 'HEAD', headers, signal}).catch(() => null)
  if (!response || !response.ok || !response.headers.get('content-length')) {
    response = await httpFetch(url, {
      method: 'GET',
      headers: {...headers, range: 'bytes=0-0'},
      signal,
    }).catch(() => null)
    if (response?.ok) await response.body?.cancel()
  }

  if (!response) return {ok: false, error: 'the host did not answer'}
  if (!response.ok && response.status !== 206) {
    return {ok: false, error: `the host answered ${response.status}`, contentType: response.headers.get('content-type') ?? undefined}
  }

  const contentType = response.headers.get('content-type') ?? undefined
  const disposition = response.headers.get('content-disposition') ?? undefined
  const contentRange = response.headers.get('content-range') ?? undefined

  // "bytes 0-0/12345" is the only reliable total when the server answered 206.
  let contentLength = toInt(response.headers.get('content-length'))
  if (contentRange) {
    const total = Number.parseInt(contentRange.split('/')[1] ?? '', 10)
    if (Number.isFinite(total)) contentLength = total
  }

  return {
    ok: true,
    remote: {
      url,
      finalUrl: response.finalUrl || url,
      contentType,
      contentLength: contentLength && contentLength > 0 ? contentLength : undefined,
      acceptRanges: (response.headers.get('accept-ranges') ?? '').toLowerCase().includes('bytes'),
      filename: filenameFor(url, disposition, contentType, contentLength),
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
    },
  }
}

function toInt(value: string | null): number | undefined {
  if (!value) return undefined
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function filenameFor(
  url: string,
  disposition: string | undefined,
  contentType: string | undefined,
  contentLength: number | undefined,
): string {
  if (disposition) {
    const star = /filename\*\s*=\s*[A-Za-z0-9-]*'[^']*'([^;]+)/i.exec(disposition)?.[1]
    const plain = /filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i.exec(disposition)
    const candidate = star ?? plain?.[1] ?? plain?.[2]
    if (candidate) {
      const decoded = decodeURIComponent(candidate.trim().replace(/^"|"$/g, ''))
      const safe = safeFilename(decoded, 'download')
      if (safe.length > 0) return safe
    }
  }
  let pathname = ''
  try {
    pathname = decodeURIComponent(new URL(url).pathname)
  } catch {
    pathname = ''
  }
  const last = pathname.split('/').filter(Boolean).at(-1)
  const base = last ? safeFilename(last, '') : ''
  const withExt = base && base.includes('.') ? base : extensionFor(contentType, url) ? `${base || 'download'}.${extensionFor(contentType, url)}` : base
  if (withExt) return withExt
  if (contentLength !== undefined) return `download-${contentLength}.bin`
  return extensionFor(contentType) ? `download.${extensionFor(contentType)}` : 'download'
}

/* ------------------------------------------------------------------ *
 * Transfer
 * ------------------------------------------------------------------ */

export type DirectProgress = {
  received: number
  total?: number
  speed: number
  eta?: number
  resumedFrom: number
}

export type DirectOptions = {
  url: string
  outDir: string
  filename: string
  remote: Remote
  signal?: AbortSignal
  onProgress?: (p: DirectProgress) => void
}

export type DirectResult = {
  file: string
  bytes: number
  resumed: boolean
}

export async function downloadDirect(opts: DirectOptions): Promise<DirectResult> {
  await fsPromises.mkdir(opts.outDir, {recursive: true})
  const target = path.join(opts.outDir, opts.filename)
  const partial = `${target}.part`

  let resumeFrom = 0
  try {
    const stat = await fsPromises.stat(partial)
    // a stale partial larger than the target is worse than no partial
    if (stat.size > 0 && (opts.remote.contentLength === undefined || stat.size < opts.remote.contentLength)) {
      resumeFrom = stat.size
    } else {
      await fsPromises.rm(partial, {force: true})
    }
  } catch {
    /* no partial yet */
  }

  const headers: Record<string, string> = {'user-agent': UA, accept: '*/*'}
  if (resumeFrom > 0 && opts.remote.acceptRanges) {
    headers['range'] = `bytes=${resumeFrom}-`
    if (opts.remote.etag) headers['if-range'] = opts.remote.etag
  }

  const response = await httpFetch(opts.url, {headers, signal: opts.signal})
  if (!response.ok && response.status !== 206) {
    throw new Error(`the host answered ${response.status} ${response.statusText}`)
  }
  if (!response.body) throw new Error('the host sent an empty body')

  const resumed = response.status === 206
  const lengthHeader = toInt(response.headers.get('content-length'))
  const total = opts.remote.contentLength ?? (resumed && lengthHeader ? resumeFrom + lengthHeader : lengthHeader)

  let received = resumeFrom
  let lastTick = Date.now()
  let lastBytes = received
  const source = Readable.fromWeb(response.body as never)

  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    const now = Date.now()
    if (now - lastTick < 200) return
    const speed = ((received - lastBytes) * 1000) / (now - lastTick)
    lastTick = now
    lastBytes = received
    opts.onProgress?.({
      received,
      total,
      speed,
      eta: speed > 0 && total ? (total - received) / speed : undefined,
      resumedFrom: resumeFrom,
    })
  })

  const sink = fs.createWriteStream(partial, {flags: resumed ? 'r+' : 'w'})
  try {
    await pipeline(source, sink, {signal: opts.signal})
  } catch (error) {
    await fsPromises.rm(partial, {force: true}).catch(() => undefined)
    throw error
  }

  await fsPromises.rename(partial, target)
  return {file: target, bytes: received, resumed: resumeFrom > 0}
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fsPromises.access(file)
    return true
  } catch {
    return false
  }
}

export async function fileSize(file: string): Promise<number | undefined> {
  try {
    const stat = await fsPromises.stat(file)
    return stat.size
  } catch {
    return undefined
  }
}