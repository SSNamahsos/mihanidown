import {spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {formatBytes} from './format.js'
import type {Diagnosis} from './errors.js'

/* ------------------------------------------------------------------ *
 * The player-client ladder
 * ------------------------------------------------------------------ *
 *
 * YouTube serves different clients from different trust tiers, and which tier
 * challenges you changes every few weeks. Rather than hardcode one client and
 * hope, mihanidown walks a ladder and keeps the rung that worked — then reuses it
 * for the download itself. That reuse matters: probing with `tv` and downloading
 * with `web` is how you get a 403 on a url that just resolved fine.
 *
 * Two rules shape the order:
 *
 *   1. `tv` yields 1080p with no proof-of-origin token, so it leads when we are
 *      anonymous. It must NOT be paired with browser cookies — yt-dlp refuses
 *      that combination — so it sinks to the bottom when cookies are present.
 *   2. `web` gives the best formats but withholds anything above 360p without a
 *      PO token. It only climbs the ladder when a local provider is wired up.
 */

export type Rung = {
  /** value for youtube:player_client */
  client: string
  /** what the user sees while this rung is being tried */
  note: string
  /** safe to combine with --cookies-from-browser */
  cookieSafe: boolean
}

const ANONYMOUS: Rung[] = [
  {client: 'tv', note: 'tv · no token needed', cookieSafe: false},
  {client: 'web_safari', note: 'web_safari · no token needed', cookieSafe: true},
  {client: 'mweb', note: 'mweb · mobile web', cookieSafe: true},
  {client: 'android_vr', note: 'android_vr · vr', cookieSafe: true},
  {client: 'web_embedded', note: 'web_embedded', cookieSafe: true},
  {client: 'default', note: 'yt-dlp defaults', cookieSafe: true},
]

const WITH_COOKIES: Rung[] = [
  {client: 'web_safari', note: 'web_safari + your session', cookieSafe: true},
  {client: 'mweb', note: 'mweb + your session', cookieSafe: true},
  {client: 'web_embedded', note: 'web_embedded + your session', cookieSafe: true},
  {client: 'android_vr', note: 'android_vr + your session', cookieSafe: true},
  {client: 'web', note: 'web + your session', cookieSafe: true},
  {client: 'tv', note: 'tv · cookies off for this rung', cookieSafe: false},
]

/**
 * `web` earns its place at the front only when a PO-Token provider can actually
 * answer, otherwise it silently hands back 360p and the picker lies about it.
 */
function buildLadder(options: {cookies?: string; poToken: boolean; forced?: string}): Rung[] {
  if (options.forced) {
    return [{client: options.forced, note: `${options.forced} · forced`, cookieSafe: options.forced !== 'tv'}]
  }
  const base = options.cookies ? [...WITH_COOKIES] : [...ANONYMOUS]
  if (options.poToken) {
    const web: Rung = {client: 'web', note: 'web · with proof-of-origin token', cookieSafe: true}
    const at = base.findIndex(r => r.client === 'web')
    if (at === -1) base.unshift(web)
    else base.splice(at, 0, web)
  }
  return base
}

/* ------------------------------------------------------------------ *
 * Metadata shapes
 * ------------------------------------------------------------------ */

export type RawFormat = {
  format_id?: string
  ext?: string
  vcodec?: string
  acodec?: string
  height?: number | null
  width?: number | null
  fps?: number | null
  abr?: number | null
  tbr?: number | null
  vbr?: number | null
  filesize?: number | null
  filesize_approx?: number | null
  format_note?: string | null
  protocol?: string
  language?: string | null
}

export type MediaInfo = {
  title?: string
  uploader?: string
  channel?: string
  duration?: number | null
  width?: number | null
  height?: number | null
  description?: string | null
  thumbnail?: string
  webpage_url?: string
  original_url?: string
  extractor?: string
  extractor_key?: string
  ext?: string
  filesize?: number | null
  filesize_approx?: number | null
  formats?: RawFormat[]
  entries?: MediaInfo[]
  _type?: string
  playlist_title?: string
  playlist_count?: number | null
  is_live?: boolean
  age_limit?: number
  availability?: string
}

export type Environment = {
  ytdlp: string
  ffmpeg?: string
  poTokenProvider?: string
  deno?: string
  cookies?: string
  forcedClient?: string
  /**
   * Set when the front is running: `--proxy` at the local port, and the flag that
   * lets it present its own certificate. Appended to every call, including the
   * download from a cached info json — those urls are fetched by yt-dlp, so they
   * need the front as much as the page did.
   */
  frontArgs?: string[]
}

export function poTokenArgs(env: Environment): string[] {
  if (!env.poTokenProvider) return []
  // `script` runs the provider in-process and needs a JS runtime to execute
  // YouTube's own challenge code; `bgutilhttp` talks to a local server.
  if (env.poTokenProvider.endsWith('.py')) {
    const args = ['--extractor-args', `youtube:pot=script+${env.poTokenProvider}`]
    if (env.deno) args.push('--js-runtimes', 'deno')
    return args
  }
  if (env.poTokenProvider === 'deno') {
    return ['--extractor-args', 'youtube:pot=script', '--js-runtimes', 'deno']
  }
  return ['--extractor-args', `youtube:pot=bgutilhttp+http://localhost:4416`]
}

function ladderFor(env: Environment): Rung[] {
  return buildLadder({
    cookies: env.cookies,
    poToken: poTokenArgs(env).length > 0,
    forced: env.forcedClient,
  })
}

function rungArgs(rung: Rung, env: Environment, withCookies: boolean): string[] {
  const args = ['--extractor-args', `youtube:player_client=${rung.client}`]
  if (withCookies && rung.cookieSafe && env.cookies) args.push('--cookies-from-browser', env.cookies)
  args.push(...poTokenArgs(env))
  return args
}

/* ------------------------------------------------------------------ *
 * Probing
 * ------------------------------------------------------------------ */

export type ProbeSuccess = {
  ok: true
  info: MediaInfo
  rung: Rung
  /** warnings worth surfacing without failing the fetch */
  warnings: string[]
}

export type ProbeFailure = {
  ok: false
  /** best error text we collected across the whole ladder */
  error: string
  /** rungs that were tried, in order, with their outcome */
  attempts: {client: string; error: string}[]
}

export type ProbeResult = ProbeSuccess | ProbeFailure


export async function probe(env: Environment, url: string, signal?: AbortSignal): Promise<ProbeResult> {
  const ladder = ladderFor(env)
  const attempts: {client: string; error: string}[] = []
  const warnings: string[] = []

  for (const rung of ladder) {
    if (signal?.aborted) break
    const args = ['-J', '--no-playlist', '--no-simulate', ...rungArgs(rung, env, true), ...(env.frontArgs ?? []), url]

    let result: {code: number | null; stdout: string; stderr: string}
    try {
      result = await run(env.ytdlp, args, signal)
    } catch (error) {
      // A binary that will not start — wrong architecture, blocked by policy, a
      // `.cmd` shim we deliberately refuse to shell out to — is a rung failure
      // like any other. It must not take the whole fetch down.
      attempts.push({client: rung.client, error: describeSpawnError(error, env.ytdlp)})
      continue
    }
    const stderr = result.stderr.trim()

    if (result.code === 0 && result.stdout.trim().length > 0) {
      let info: MediaInfo
      try {
        info = JSON.parse(result.stdout) as MediaInfo
      } catch {
        attempts.push({client: rung.client, error: 'yt-dlp returned something that is not JSON'})
        continue
      }

      // A playlist or a single media object — both are usable.
      if (info._type === 'playlist' || Array.isArray(info.entries)) {
        const entries = info.entries ?? []
        if (entries.length === 1) {
          // One result is a video wearing a playlist's clothes — which is exactly
          // what a search returns. Unwrap it, or the picker sees a playlist with
          // no formats and no thumbnail and offers one blind "best available".
          const only = entries[0] as MediaInfo
          return finish({...only, original_url: only.original_url ?? info.original_url}, rung, collectWarnings(stderr))
        }
        if (entries.length > 1) return finish(info, rung, collectWarnings(stderr))
        attempts.push({client: rung.client, error: 'playlist came back empty'})
        continue
      }
      // A PO-Token warning means this rung's answer is downgraded, but it is
      // still a working answer — keep it and let the UI explain the ceiling.
      return finish(info, rung, collectWarnings(stderr))
    }

    attempts.push({client: rung.client, error: lastErrorLine(stderr) || `exit ${result.code}`})
  }

  return {
    ok: false,
    error: attempts.at(-1)?.error ?? 'yt-dlp could not read this url',
    attempts,
  }

  async function finish(info: MediaInfo, rung: Rung, collected: string[]): Promise<ProbeSuccess> {
    return {ok: true, info, rung, warnings: [...warnings, ...collected]}
  }
}

function collectWarnings(stderr: string): string[] {
  return stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('WARNING:'))
    .map(l => l.replace(/^WARNING:\s*/, ''))
}

function lastErrorLine(stderr: string): string {
  const lines = stderr
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('ERROR:'))
  const last = lines.at(-1)
  return last ? last.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/, '').slice(0, 200) : ''
}

/**
 * Turn a spawn rejection into something a person can act on.
 *
 * The EINVAL case is worth naming: on Windows a `.cmd` or `.bat` shim cannot be
 * spawned directly, and we do not use `shell: true` because the url goes
 * through these arguments and shell-parsing it would be an injection.
 */
function describeSpawnError(error: unknown, binary: string): string {
  const code = (error as {code?: string} | null)?.code ?? ''
  if (code === 'EINVAL') {
    return `${binary} could not be started directly (a .cmd/.bat shim cannot be). Point mihanidown at the real executable.`
  }
  if (code === 'ENOENT') return `${binary} is not there any more. Press ^r to re-resolve it.`
  if (code === 'EACCES') return `${binary} is not executable by this user.`
  if (code === 'ENOSPC') return 'the disk is full.'
  const message = error instanceof Error ? error.message : String(error)
  return `${binary} would not start: ${message}`.slice(0, 200)
}

/* ------------------------------------------------------------------ *
 * Choices
 * ------------------------------------------------------------------ */

export type ChoiceKind = 'video' | 'audio' | 'image' | 'file' | 'all'

export type Choice = {
  kind: ChoiceKind
  label: string
  /** columns shown in the list: height/codec, container, estimated size */
  detail: [string, string, string]
  /** yt-dlp format selector */
  format?: string
  args: string[]
  /** estimated total bytes for the meter */
  estimate?: number
  /** set when the row came from a scraped page rather than an extractor */
  sourceUrl?: string
}

const MAX_VIDEO_ROWS = 9

function scoreVideo(f: RawFormat): number {
  let score = f.tbr ?? f.vbr ?? 0
  if (f.ext === 'mp4') score += 10_000
  // avc1 plays everywhere; prefer it over vp9/av1 at equal bitrate
  if (f.vcodec?.startsWith('avc')) score += 5_000
  if (f.protocol === 'm3u8_native' || f.protocol === 'http_dash_segments') score -= 5_000
  return score
}

function audioOnlyFormats(formats: RawFormat[]): RawFormat[] {
  return formats.filter(f => f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'))
}

/** Video with no audio of its own: needs a merge, so needs ffmpeg. */
function videoOnlyFormats(formats: RawFormat[]): RawFormat[] {
  return formats.filter(f => f.vcodec && f.vcodec !== 'none' && (f.acodec === 'none' || !f.acodec) && typeof f.height === 'number')
}

/** Video and audio already in one file: fetchable in a single request. */
function muxedFormats(formats: RawFormat[]): RawFormat[] {
  return formats.filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec && f.acodec !== 'none' && typeof f.height === 'number')
}

function bestAudio(formats: RawFormat[]): RawFormat | undefined {
  return [...audioOnlyFormats(formats)].sort(
    (a, b) => (b.abr ?? b.tbr ?? 0) - (a.abr ?? a.tbr ?? 0),
  )[0]
}

/** A direct file url: one entry, no ladder of heights. */
export function buildDirectChoice(info: MediaInfo): Choice[] {
  const size = info.filesize ?? info.filesize_approx ?? undefined
  const ext = (info.ext ?? 'bin').slice(0, 8)
  const stream = info.formats?.[0]
  // With no format list at all — which is what a plain image or file url looks
  // like — the extension is the only signal there is.
  const kind: ChoiceKind = stream
    ? stream.vcodec && stream.vcodec !== 'none'
      ? 'image'
      : stream.acodec && stream.acodec !== 'none'
        ? 'audio'
        : 'file'
    : IMAGE_EXTENSIONS.has(ext) || ext === 'svg'
      ? 'image'
      : VIDEO_EXTENSIONS.has(ext)
        ? 'video'
        : AUDIO_EXTENSIONS.has(ext)
          ? 'audio'
          : 'file'
  const geometry = info.width && info.height ? `${info.width}x${info.height}`.slice(0, 11) : ext
  return [
    {
      kind,
      label: `${ext.toUpperCase()} · original file`,
      detail: [geometry, 'source', formatBytes(size)],
      args: ['-f', 'best'],
      estimate: size,
    },
  ]
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'bmp', 'tif', 'tiff', 'ico'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'm4v', 'mov', 'mkv', 'avi', 'flv', 'mpg', 'mpeg'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'flac', 'opus', 'ogg', 'wav'])

/**
 * Build the picker's rows.
 *
 * Three things are deliberate here:
 *
 *  - One row per height, split streams preferred. A pre-merged file at a height
 *    that a split stream already covers is noise, and listing it would mean the
 *    same picture twice with two different sizes.
 *  - Estimates are honest about which kind of row they are: a split row is the
 *    video file plus the audio track, a pre-merged row is the file itself.
 *  - The three detail columns are fixed-width on screen, so their contents are
 *    written to fit: geometry in 11 cells, a codec or mode word in 8, a size in
 *    9. Anything longer is truncated on screen, which is worse than never
 *    writing it.
 */
export function buildChoices(info: MediaInfo, limit?: number): Choice[] {
  const formats = info.formats ?? []
  if (formats.length === 0) return buildDirectChoice(info)

  const audio = bestAudio(formats)
  const audioSize = audio?.filesize ?? audio?.filesize_approx ?? undefined
  const split = videoOnlyFormats(formats)
  const muxed = muxedFormats(formats)

  // No picture at all: this is an audio source, or an image delivered as a
  // single format.
  if (split.length === 0 && muxed.length === 0) {
    const still = formats.find(f => f.vcodec && f.vcodec !== 'none')
    if (still) {
      const geometry =
        still.width && still.height
          ? `${still.width}x${still.height}`.slice(0, 11)
          : still.height
            ? `${still.height}p`
            : (still.ext ?? 'img').slice(0, 11)
      const bytes = still.filesize ?? still.filesize_approx ?? undefined
      return [
        {
          kind: 'image',
          label: `${(still.ext ?? 'image').toUpperCase()} · original`,
          detail: [geometry, (still.ext ?? 'img').slice(0, 8), formatBytes(bytes)],
          args: ['-f', 'best'],
          estimate: bytes,
        },
      ]
    }
    return audioChoices(audio?.ext ?? 'm4a', audioSize)
  }

  const heights = [...new Set([...split, ...muxed].map(f => f.height as number))].sort((a, b) => b - a)
  const allowed = typeof limit === 'number' ? heights.filter(h => h <= limit) : heights
  const wanted = (allowed.length > 0 ? allowed : heights).slice(0, MAX_VIDEO_ROWS)

  const choices: Choice[] = []
  for (const height of wanted) {
    const candidates = split.filter(f => f.height === height)
    const merged = muxed.filter(f => f.height === height)

    if (candidates.length > 0) {
      const best = [...candidates].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] as RawFormat
      const videoBytes = best.filesize ?? best.filesize_approx ?? 0
      const estimate = videoBytes + (audioSize ?? 0)
      choices.push({
        kind: 'video',
        label: `${height}p · ${best.ext ?? 'mp4'}`,
        detail: [
          `${best.width ?? '?'}x${height}`.slice(0, 11),
          codecLabel(best.vcodec).slice(0, 8),
          formatBytes(estimate),
        ],
        format: `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
        args: [
          '-f',
          `bv*[height=${height}]+ba/b[height=${height}]/bv*[height<=${height}]+ba/b`,
          '--merge-output-format',
          'mp4',
        ],
        estimate: estimate > 0 ? estimate : undefined,
      })
      // A merged file at the same height adds nothing the split row does not
      // already offer, and would double the entry in the list.
      continue
    }

    const best = [...merged].sort((a, b) => scoreVideo(b) - scoreVideo(a))[0] as RawFormat
    const bytes = best.filesize ?? best.filesize_approx ?? undefined
    choices.push({
      kind: 'video',
      label: `${height}p · ${best.ext ?? 'mp4'}`,
      detail: [
        `${best.width ?? '?'}x${height}`.slice(0, 11),
        'no merge',
        formatBytes(bytes),
      ],
      format: String(best.format_id ?? 'best'),
      args: ['-f', String(best.format_id ?? 'best')],
      estimate: bytes,
    })
  }

  if (choices.length === 0) {
    choices.push({
      kind: 'video',
      label: 'best available · mp4',
      detail: ['auto', 'merge', '--'],
      args: ['-f', 'bv*+ba/b', '--merge-output-format', 'mp4'],
    })
  }

  choices.push(...audioChoices(audio?.ext ?? 'm4a', audioSize))
  return choices
}

/** mp3 first because it is the one people actually want; source second. */
function audioChoices(ext: string, size: number | undefined): Choice[] {
  return [
    {
      kind: 'audio',
      label: 'audio only · mp3',
      detail: ['mp3', 'convert', formatBytes(size)],
      args: ['-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0'],
      estimate: size,
    },
    {
      kind: 'audio',
      label: `${ext} · source audio`,
      detail: [ext.slice(0, 8), 'source', formatBytes(size)],
      args: ['-f', 'ba/b'],
      estimate: size,
    },
  ]
}

export function codecLabel(vcodec: string | null | undefined): string {
  if (!vcodec || vcodec === 'none') return ''
  if (vcodec.startsWith('avc1') || vcodec.startsWith('h264')) return 'h264'
  if (vcodec.startsWith('hev1') || vcodec.startsWith('hvc1')) return 'h265'
  // yt-dlp writes VP9 as `vp9` in some places and `vp09` in others
  if (vcodec.startsWith('vp9') || vcodec.startsWith('vp09')) return 'vp9'
  if (vcodec.startsWith('vp8')) return 'vp8'
  if (vcodec.startsWith('av01')) return 'av1'
  const head = vcodec.split('.')[0]
  return head ? head.slice(0, 8) : ''
}

/* ------------------------------------------------------------------ *
 * Downloading
 * ------------------------------------------------------------------ */

const PROGRESS_PREFIX = 'MHDL|'
const PROGRESS_TEMPLATE = [
  '%(progress.downloaded_bytes)s',
  '%(progress.total_bytes)s',
  '%(progress.total_bytes_estimate)s',
  '%(progress.speed)s',
  '%(progress.eta)s',
].join('|')

export type Progress = {
  downloaded: number
  total?: number
  speed?: number
  eta?: number
  /** which file of a multi-file fetch (video+audio = 2) */
  part: number
  totalParts: number
  /** the merge / remux / transcode phase has started */
  processing: boolean
}

/** Mutable bookkeeping threaded through the line parser. */
export type ParseState = {
  part: number
  totalParts: number
  lastDownloaded?: number
  written: Set<string>
}

export function newParseState(): ParseState {
  return {part: 0, totalParts: 1, written: new Set()}
}

export type ParsedLine =
  | {type: 'progress'; progress: Progress}
  | {type: 'phase'; target: string}
  | {type: 'destination'; file: string}
  | {type: 'warning'; text: string}
  | {type: 'file'; file: string}

const PHASE_TAG = /^\[(Merger|ExtractAudio|Metadata|VideoRemuxer|VideoConvertor|FixupM3u8)\]/
const FORMATS_TAG = /Downloading (\d+) format/
// yt-dlp's message wording has changed across releases, so accept either quote
// style rather than silently losing the path we need in order to clean up.
const MERGE_TARGET = /Merging formats into ["'](.+)["']$/
const DESTINATION = /Destination: (.+)$/

/**
 * Interpret one line of yt-dlp's stdout.
 *
 * Pulled out of the download loop as a pure function because this is where the
 * meter gets its numbers. A mistake here shows up as a progress bar that sits
 * still rather than as a crash, which is exactly the kind of bug that survives
 * review.
 */
export function parseLine(rawLine: string, state: ParseState): ParsedLine | null {
  const line = rawLine.trim()
  if (line.length === 0) return null

  if (line.startsWith(PROGRESS_PREFIX)) {
    const fields = line.slice(PROGRESS_PREFIX.length).split('|')
    const downloaded = num(fields[0]) ?? 0
    // yt-dlp restarts the byte counter for each file, so a drop means a new part
    if (downloaded < (state.lastDownloaded ?? 0)) state.part += 1
    state.lastDownloaded = downloaded
    return {
      type: 'progress',
      progress: {
        downloaded,
        total: num(fields[1]) ?? num(fields[2]),
        speed: num(fields[3]),
        eta: num(fields[4]),
        part: state.part,
        totalParts: state.totalParts,
        processing: false,
      },
    }
  }

  const formats = FORMATS_TAG.exec(line)
  if (formats) {
    // "[youtube] id: Downloading 2 format(s): 137+140" — one id per file
    const ids = line.slice(line.indexOf(':') + 1).trim()
    state.totalParts = ids.split('+').filter(Boolean).length || Number(formats[1]) || 1
    return null
  }

  if (PHASE_TAG.test(line)) {
    const target = DESTINATION.exec(line)?.[1] ?? MERGE_TARGET.exec(line)?.[1] ?? ''
    if (target) state.written.add(target)
    return {type: 'phase', target}
  }

  if (line.startsWith('[download] Destination: ')) {
    const file = line.slice('[download] Destination: '.length)
    state.written.add(file)
    return {type: 'destination', file}
  }

  if (line.startsWith('WARNING: ')) return {type: 'warning', text: line.slice('WARNING: '.length)}

  // after_move:filepath prints bare absolute paths
  if (path.isAbsolute(line)) return {type: 'file', file: line}

  return null
}

export type DownloadOutcome = {
  files: string[]
  warnings: string[]
}

let activeChild: ChildProcess | undefined
function killActive(): void {
  activeChild?.kill('SIGTERM')
}
process.on('exit', killActive)

export type DownloadRequest = {
  env: Environment
  url: string
  /**
   * The rung the probe settled on. It is forced again here rather than rediscovered:
   * a url resolved by `tv` and fetched by `web` is how you get a 403 on something
   * that just worked.
   */
  rung?: Rung
  choice: Choice
  outDir: string
  /** also fetch every entry of a playlist */
  wholePlaylist?: boolean
}

export function download(
  req: DownloadRequest,
  onProgress: (p: Progress) => void,
  signal?: AbortSignal,
): Promise<DownloadOutcome> {
  const {env} = req
  const rung = req.rung ?? ladderFor(env)[0]
  if (!rung) throw new Error('No usable player client.')

  const args = [
    req.url,
    ...rungArgs(rung, env, true),
    ...req.choice.args,
    '--no-warnings',
    ...(req.wholePlaylist ? ['--yes-playlist'] : ['--no-playlist']),
    '--newline',
    // --print implies --quiet, which would kill the progress lines we read
    '--no-quiet',
    '--progress',
    '--progress-template',
    `download:${PROGRESS_PREFIX}${PROGRESS_TEMPLATE}`,
    '--print',
    'after_move:filepath',
    '--no-simulate',
    '-o',
    path.join(req.outDir, '%(title).60s.%(ext)s'),
    ...(env.frontArgs ?? []),
  ]
  if (env.ffmpeg && env.ffmpeg !== 'ffmpeg') args.push('--ffmpeg-location', env.ffmpeg)

  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(env.ytdlp, args, {signal})
    } catch (error) {
      reject(error)
      return
    }
    activeChild = child

    const state = newParseState()
    const files: string[] = []
    const warnings: string[] = []
    let stderr = ''
    let buffer = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const parsed = parseLine(line, state)
        if (!parsed) continue
        switch (parsed.type) {
          case 'progress':
            onProgress(parsed.progress)
            break
          case 'phase':
            // The network is done; ffmpeg has the file now. Say so, or the
            // meter looks frozen for the length of a 4K remux.
            onProgress({
              downloaded: state.lastDownloaded ?? 0,
              total: state.lastDownloaded,
              speed: 0,
              eta: 0,
              part: state.part,
              totalParts: state.totalParts,
              processing: true,
            })
            break
          case 'file':
            files.push(parsed.file)
            break
          case 'warning':
            warnings.push(parsed.text)
            break
          case 'destination':
          default:
            break
        }
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    child.on('error', reject)

    child.on('close', code => {
      activeChild = undefined
      if (signal?.aborted) {
        void cleanup([...state.written])
        reject(new Error('Cancelled.'))
        return
      }
      if (code === 0 && files.length > 0) {
        resolve({files, warnings})
        return
      }
      // yt-dlp sometimes exits 0 for a partial playlist; treat as success only
      // if something actually landed on disk
      if (code === 0 && files.length === 0) {
        void cleanup([...state.written])
        reject(new Error(lastErrorLine(stderr) || 'yt-dlp finished without writing a file.'))
        return
      }
      void cleanup([...state.written])
      reject(new Error(lastErrorLine(stderr) || `yt-dlp exited with code ${code}.`))
    })
  })
}

/** Partial files left behind by a cancel. */
function cleanup(paths: string[]): Promise<unknown> {
  return Promise.allSettled(
    paths.flatMap(p => [p, `${p}.part`, `${p}.ytdl`, `${p}.temp`]).map(file => fs.rm(file, {force: true})),
  )
}

export function cancelActive(): void {
  killActive()
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value === 'NA' || value === 'None' || value === '') return undefined
  const n = Number.parseFloat(value)
  return Number.isFinite(n) ? n : undefined
}

function run(cmd: string, args: string[], signal?: AbortSignal): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {signal})
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => (stdout += String(chunk)))
    child.stderr?.on('data', chunk => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', code => resolve({code, stdout, stderr}))
  })
}

export type {Diagnosis}