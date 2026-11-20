import type {Choice, MediaInfo, Rung} from './lib/ytdlp.js'
import type {Resolved} from './lib/router.js'
import type {Diagnosis} from './lib/errors.js'
import type {Pixels} from './lib/media/decode.js'
import type {Filmstrip} from './lib/media/filmstrip.js'
import type {ThemeName} from './theme.js'
import type {FrontMode} from './lib/front.js'
import type {Root} from './lib/destinations.js'

export type Phase = 'boot' | 'home' | 'resolving' | 'inspect' | 'transfer' | 'filed' | 'failed'

export type PlateState = {
  kind: 'none' | 'loading' | 'still' | 'strip'
  /** decoded still (thumbnail, poster, direct image) */
  pixels?: Pixels
  /** decoded video frames */
  strip?: Filmstrip
  /** index into the strip */
  frame: number
  /** caption under the plate: the timestamp, or the source of the still */
  caption?: string
  /** total frames known so far, for the progress-style load bar */
  loaded: number
  expected: number
  /** why there is no artwork */
  empty?: string
  error?: string
}

export type Transfer = {
  received: number
  total?: number
  speed: number
  eta?: number
  /** 1-based file index when the fetch resolves to several */
  part: number
  totalParts: number
  processing: boolean
  startedAt: number
}

export type Filed = {
  files: string[]
  /** one-line summary: `1 file · 94.2 MB · 11s` */
  summary: string
  warnings: string[]
}

export type Failure = {
  diagnosis: Diagnosis
  /** the ladder rungs that were tried, so the user can see the attempt */
  attempts?: {client: string; error: string}[]
}

export type AppState = {
  phase: Phase
  theme: ThemeName
  cols: number
  rows: number
  colorDepth: number

  /** startup progress for binaries */
  boot: string
  bootDetail: string

  url: string
  history: string[]
  /** cursor into history while browsing, -1 means "not browsing" */
  historyCursor: number

  status: string
  resolved?: Resolved
  choices: Choice[]
  selected: number
  /** scroll offset when the choice list is longer than the sheet */
  listOffset: number

  plate: PlateState
  transfer?: Transfer
  filed?: Filed
  failure?: Failure

  rung?: Rung
  warning?: string
  outDir: string
  cookies?: string
  /** true when a PO-Token provider is wired up */
  poToken: boolean
  ffmpeg?: string
  ytdlpVersion: string
  /** the front setting for this session */
  frontMode: FrontMode
  /** the front is running, so filtered names are being carried */
  frontOn: boolean
  /** what the measurement said, in the app's own words */
  frontDetail: string
  /** which routing engine produced the current answer */
  engine?: 'direct' | 'ytdlp' | 'scrape'
  notice?: {text: string; intent: 'good' | 'bad' | 'muted'}
  /** id of the clickable region under the pointer, for hover styling */
  hover: string
  /** save the video's thumbnail alongside every download (config-backed) */
  saveThumbnail: boolean
  /** cookie-picker overlay */
  cookiesMenu: boolean
  cookiesCursor: number
  /** save-location overlay, and the folders it offered */
  saveMenu: boolean
  saveCursor: number
  roots: Root[]
  /** shortcut sheet, reachable from `?` on every screen */
  helpMenu: boolean
}

export function mediaInfoOf(state: AppState): MediaInfo | undefined {
  return state.resolved?.kind === 'ytdlp' ? state.resolved.probe.info : undefined
}