/**
 * Dev harness: render any sheet phase as plain text so the layout can be checked
 * in a diff or a PR comment without a terminal. Not part of the bundle.
 *
 *   npx tsx scripts/preview.ts                 # every phase, 100x40
 *   npx tsx scripts/preview.ts home 80x24      # one phase, one size
 *   npx tsx scripts/preview.ts inspect --plain # strip colour, show the plate
 */
import path from 'node:path'
import {Sheet} from '../src/lib/sheet.js'
import {createStyleResolver} from '../src/theme.js'
import {drawHome} from '../src/views/home.js'
import {drawInspect, drawTransfer, drawFiled, drawFailed} from '../src/views/inspect.js'
import {drawChrome} from '../src/views/frame.js'
import {drawCookiesMenu, drawSaveMenu} from '../src/views/overlay.js'
import {roots} from '../src/lib/destinations.js'
import {drawHelpMenu} from '../src/views/keys.js'
import type {AppState} from '../src/state.js'
import type {Pixels} from '../src/lib/media/decode.js'
import {pickRenderer} from '../src/lib/media/ansi.js'

const argv = process.argv.slice(2)
const plain = argv.includes('--plain')
const positional = argv.filter(a => !a.startsWith('--'))
const [whichArg, sizeArg] = positional
const [cols, rows] = (sizeArg ?? '100x40').split('x').map(Number) as [number, number]
const which = whichArg ?? 'all'

// eslint-disable-next-line no-control-regex
const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '')

function gradient(w: number, h: number): Pixels {
  const data = new Uint8Array(w * h * 3)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3
      const u = x / w
      const v = y / h
      data[o] = Math.round(40 + 180 * v * (1 - u * 0.5))
      data[o + 1] = Math.round(30 + 90 * u + 60 * (1 - v))
      data[o + 2] = Math.round(70 + 150 * (1 - v) * u)
      if ((x + y) % 17 === 0) {
        data[o] = 245
        data[o + 1] = 240
        data[o + 2] = 225
      }
    }
  }
  return {width: w, height: h, data}
}

function strip(count: number, duration: number): Pixels[] {
  const frames: Pixels[] = []
  for (let i = 0; i < count; i++) {
    // 16:9, like real video, so the plate's aspect maths is exercised honestly
    const frame = gradient(96, 54)
    const shift = Math.round((i / count) * 50)
    for (let y = 0; y < 54; y++) {
      for (let x = 0; x < 96; x++) {
        const o = (y * 96 + x) * 3
        if (x > shift) {
          frame.data[o] = Math.max(0, frame.data[o]! - 40)
          frame.data[o + 1] = Math.max(0, frame.data[o + 1]! - 30)
          frame.data[o + 2] = Math.max(0, frame.data[o + 2]! - 20)
        }
      }
    }
    frames.push(frame)
  }
  return frames
}

const base: AppState = {
  phase: 'home',
  theme: 'dark',
  cols,
  rows,
  colorDepth: 24,
  boot: 'ready',
  bootDetail: 'ready',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  history: [
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://x.com/someone/status/1234567890',
    'https://upload.wikimedia.org/wikipedia/commons/3/3f/Fronalpstock_big.jpg',
    'https://cdn.example.com/talks/2026-keynote.mp4',
  ],
  historyCursor: -1,
  status: '',
  choices: [],
  selected: 0,
  listOffset: 0,
  plate: {kind: 'none', frame: 0, loaded: 0, expected: 0},
  outDir: path.join(process.env['USERPROFILE'] ?? '/home/me', 'Desktop'),
  poToken: false,
  ffmpeg: 'ffmpeg',
  ytdlpVersion: '2026.10.24-240531',
  frontMode: 'auto',
  frontOn: true,
  frontDetail: 'youtube hello: ECONNRESET',
  hover: '',
  saveThumbnail: true,
  cookiesMenu: false,
  cookiesCursor: 1,
  saveMenu: false,
  saveCursor: 0,
  roots: [],
  helpMenu: false,
}

const info = {
  title: 'How Terminal Graphics Actually Work: Half Blocks, Sixels and the Road to Kitty',
  uploader: 'Signal & Noise',
  width: 1920,
  height: 1080,
  duration: 3725,
  extractor: 'Youtube',
  thumbnail: 'https://i.ytimg.com/vi/x/maxres.jpg',
}

const choices = [
  {kind: 'video', label: '2160p \u00b7 mp4', detail: ['3840x2160', 'av1', '312 MB'], args: []},
  {kind: 'video', label: '1440p \u00b7 mp4', detail: ['2560x1440', 'h264', '148 MB'], args: []},
  {kind: 'video', label: '1080p \u00b7 mp4', detail: ['1920x1080', 'h264', '62 MB'], args: []},
  {kind: 'video', label: '1080p \u00b7 single file', detail: ['1 file', 'no merge', '58 MB'], args: []},
  {kind: 'video', label: '720p \u00b7 mp4', detail: ['1280x720', 'h264', '31 MB'], args: []},
  {kind: 'video', label: '480p \u00b7 mp4', detail: ['854x480', 'h264', '14 MB'], args: []},
  {kind: 'audio', label: 'audio only \u00b7 mp3', detail: ['mp3', 'convert', '9.4 MB'], args: []},
  {kind: 'audio', label: 'm4a \u00b7 source audio', detail: ['m4a', 'source', '9.1 MB'], args: []},
] as never

const ytdlpResolved = {
  kind: 'ytdlp',
  probe: {ok: true, info, rung: {client: 'tv', note: 'tv \u00b7 no token needed', cookieSafe: false}, warnings: []},
  choices,
  warning: undefined,
} as never

const screens: Record<string, (sheet: Sheet, s: AppState, styles: ReturnType<typeof createStyleResolver>) => void> = {
  boot: (sheet, s) => drawHome(sheet, chrome(s), {...s, phase: 'boot', boot: 'first run', bootDetail: 'fetching ffmpeg'}),
  home: (sheet, s) => drawHome(sheet, chrome(s), s),
  save: (sheet, s) => {
    drawHome(sheet, chrome(s), s)
    drawSaveMenu(sheet, {...s, saveMenu: true, roots: [{label: 'this folder', dir: process.cwd(), detail: 'where you opened mihanidown'}, {label: 'desktop', dir: 'C:\\Users\\pc\\Desktop', detail: ''}, {label: 'downloads', dir: 'C:\\Users\\pc\\Downloads', detail: ''}, {label: 'D:', dir: 'D:\\', detail: 'whole drive'}], saveCursor: 2})
  },
  cookies: (sheet, s) => {
    drawHome(sheet, chrome(s), s)
    drawCookiesMenu(sheet, {...s, cookiesMenu: true})
  },
  resolving: (sheet, s) =>
    drawChrome(sheet, chrome(s), {
      stamp: 'trying player clients',
      hints: [
        {key: 'esc', label: 'cancel'},
        {key: 'q', label: 'quit'},
      ],
      themeName: s.theme,
    }),
  inspect: (sheet, s, styles) =>
    drawInspect(
      sheet,
      chrome(s),
      {...s, resolved: ytdlpResolved, choices, selected: 2, plate: {kind: 'still', pixels: gradient(120, 68), frame: 0, loaded: 1, expected: 1, caption: 'thumbnail \u00b7 1h 02m 05s long'}},
      pickRenderer(24, true),
    ),
  strip: (sheet, s) =>
    drawInspect(
      sheet,
      chrome(s),
      {
        ...s,
        resolved: ytdlpResolved,
        choices,
        selected: 2,
        plate: {kind: 'strip', strip: {frames: strip(32, 3725), times: Array.from({length: 32}, (_, i) => (i / 32) * 3725), width: 64, height: 64}, frame: 7, loaded: 32, expected: 32},
      },
      pickRenderer(24, true),
    ),
  keys: (sheet, s) => {
    drawInspect(sheet, chrome(s), {...s, resolved: ytdlpResolved, choices, selected: 2}, pickRenderer(24, true))
    drawHelpMenu(sheet, s)
  },
  transfer: (sheet, s) =>
    drawTransfer(sheet, chrome(s), {
      ...s,
      transfer: {received: 41_400_000, total: 94_200_000, speed: 8_240_000, eta: 6.4, part: 1, totalParts: 2, processing: false, startedAt: 0},
    }),
  filed: (sheet, s) =>
    drawFiled(sheet, chrome(s), {
      ...s,
      filed: {
        files: [
          path.join(s.outDir, 'How Terminal Graphics Actually Work.mp4'),
          path.join(s.outDir, 'How Terminal Graphics Actually Work.f140.m4a'),
        ],
        summary: '2 files \u00b7 62.4 MB \u00b7 8.1s',
        warnings: [],
      },
    }),
  failed: (sheet, s) =>
    drawFailed(sheet, chrome(s), {
      ...s,
      failure: {
        diagnosis: {
          message: 'YouTube asked us to prove we are not a bot.',
          action:
            'Press ^k to hand over cookies from a signed-in browser, or set --cookies chrome. mihanidown is already rotating player clients; this account check is the part cookies solve.',
          recoverable: true,
          retryable: false,
        },
        attempts: [
          {client: 'tv', error: 'Sign in to confirm you\u2019re not a bot'},
          {client: 'web_safari', error: 'Sign in to confirm you\u2019re not a bot'},
          {client: 'mweb', error: 'HTTP Error 403: Forbidden'},
          {client: 'android_vr', error: 'Sign in to confirm your age'},
        ],
      },
    }),
}

function chrome(s: AppState) {
  return {cols: s.cols, rows: s.rows, theme: s.theme, colorDepth: s.colorDepth}
}

const names = which === 'all' ? Object.keys(screens) : [which]
const styles = createStyleResolver(base.theme, 24)

for (const name of names) {
  const draw = screens[name]
  if (!draw) {
    process.stderr.write(`unknown screen: ${name}\n`)
    continue
  }
  const sheet = new Sheet(cols, rows, styles)
  draw(sheet, base, styles)
  const lines = sheet.toLines().map(line => {
    const text = plain ? stripAnsi(line).replace(/\u2580/g, '#') : line
    return `\u2502${text}\u2502`
  })
  process.stdout.write(`\n\u250c\u2500\u2500 ${name} \u00b7 ${cols}x${rows} \u2500\u2500\u2500\u2510\n`)
  process.stdout.write(lines.join('\n') + '\n')
  process.stdout.write(`\u2514${'\u2500'.repeat(cols + 2)}\u2518\n\n`)
}