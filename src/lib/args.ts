import type {ThemeName} from '../theme.js'
import type {FrontMode} from './front.js'
import {expandDestination} from './destinations.js'

export type CliOptions = {
  /** Positional url. */
  url?: string
  /** Undefined when the flag was not passed, so the saved config can win. */
  theme?: ThemeName
  /** Output directory. Defaults to ~/Downloads. */
  outDir?: string
  /** Skip the picker: best quality available. */
  best: boolean
  /** Skip the picker: audio only, extracted to mp3. */
  mp3: boolean
  /** Explicit height cap, e.g. -q 1080. */
  quality?: number
  /** Print the resolved direct file / media list and exit. */
  probe: boolean
  /** Print the site catalogue and yt-dlp's live extractor list. */
  sites: boolean
  /** Explain the PO-Token setup and current status. */
  poToken: boolean
  /** yt-dlp player client override, e.g. --client tv. */
  client?: string
  /** Browser to take cookies from, e.g. --cookies chrome. */
  cookies?: string
  /** Route Google's filtered names through the front. */
  front?: FrontMode
  /** Measure the connection and report whether the front is needed. */
  frontCheck: boolean
  /** Print the version and exit. */
  version: boolean
  help: boolean
}

const THEMES = new Set(['auto', 'light', 'dark'])
const FRONTS = new Set(['auto', 'on', 'off'])
const BROWSERS = new Set([
  'brave',
  'chrome',
  'chromium',
  'edge',
  'firefox',
  'opera',
  'safari',
  'vivaldi',
  'whale',
])

/** Flags that take a value, so `-oDIR` can be split into flag and value. */
const VALUE_FLAGS = new Set(['-t', '-o', '-q'])

export function parseArgs(argv: string[]): {options: CliOptions; unknown: string[]} {
  const options: CliOptions = {
    best: false,
    mp3: false,
    probe: false,
    sites: false,
    poToken: false,
    frontCheck: false,
    version: false,
    help: false,
  }
  const unknown: string[] = []
  let onlyPositional = false

  /**
   * Read a flag's value, whether it arrived attached (`-oC:\out`, `-q720`) or
   * as the next argument (`-o C:\out`). Attached short-flag values are how
   * people actually type these, so getting them wrong silently drops the flag.
   */
  const takeValue = (index: number, flag: string, attached: string | undefined): string | undefined => {
    if (attached !== undefined) {
      if (attached.length > 0) return attached
      const next = argv[index + 1]
      if (next !== undefined && !next.startsWith('-')) return next
      unknown.push(`${flag} needs a value`)
      return undefined
    }
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('-')) {
      unknown.push(`${flag} needs a value`)
      return undefined
    }
    return next
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string

    if (onlyPositional) {
      options.url ??= arg
      continue
    }
    if (arg === '--') {
      onlyPositional = true
      continue
    }
    if (!arg.startsWith('-')) {
      options.url ??= arg
      continue
    }

    // `--flag=value` splits on `=`, and `-oC:\out` splits on the flag itself.
    // Both forms are how people actually type these.
    const eq = arg.indexOf('=')
    let flag = eq === -1 ? arg : arg.slice(0, eq)
    let inline = eq === -1 ? undefined : arg.slice(eq + 1)

    if (inline === undefined && arg.startsWith('-') && !arg.startsWith('--') && arg.length > 2) {
      const candidate = arg.slice(0, 2)
      if (VALUE_FLAGS.has(candidate)) {
        flag = candidate
        inline = arg.slice(2)
      }
    }

    switch (flag) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '-v':
      case '--version':
        options.version = true
        break
      case '-t':
      case '--theme': {
        const value = takeValue(i, flag, inline)
        if (value === undefined) break
        if (THEMES.has(value)) options.theme = value as ThemeName
        else unknown.push('--theme must be auto, light or dark')
        break
      }
      case '-o':
      case '--out':
      case '--output': {
        const value = takeValue(i, flag, inline)
        // A bare drive letter means "that drive's MihaniDownloader folder", which
        // is what people mean when they type `-o d`.
        if (value !== undefined) options.outDir = expandDestination(value)
        break
      }
      case '--client': {
        const value = takeValue(i, flag, inline)
        if (value !== undefined) options.client = value
        break
      }
      case '--cookies': {
        const value = takeValue(i, flag, inline)
        if (value === undefined) break
        const name = value.toLowerCase()
        if (!BROWSERS.has(name)) {
          unknown.push(`--cookies must be one of: ${[...BROWSERS].join(', ')}`)
          break
        }
        options.cookies = name
        break
      }
      case '-q':
      case '--quality': {
        const value = takeValue(i, flag, inline)
        if (value === undefined) break
        const n = Number.parseInt(value, 10)
        if (Number.isFinite(n) && n > 0) options.quality = n
        else unknown.push('--quality must be a positive number of pixels')
        break
      }
      case '--front': {
        const value = takeValue(i, flag, inline)
        if (value === undefined) break
        if (FRONTS.has(value)) options.front = value as FrontMode
        else unknown.push('--front must be auto, on or off')
        break
      }
      case '--front-check':
        options.frontCheck = true
        break
      case '--best':
        options.best = true
        break
      case '--mp3':
        options.mp3 = true
        break
      case '-p':
      case '--probe':
        options.probe = true
        break
      case '--sites':
        options.sites = true
        break
      case '--po-token':
        options.poToken = true
        break
      case '-y':
      case '--yes':
        // accepted and ignored: the app never prompts in headless mode anyway
        break
      default:
        unknown.push(flag)
    }
  }

  return {options, unknown}
}

export const HELP = `
  mihanidown — paste a link, see the video, keep the file.

  USAGE
    mihanidown [url] [options]
    mihanidown                          open the sheet and prompt for a url

  OPTIONS
    -t, --theme <auto|light|dark>   starting palette (default auto)
    -o, --out <dir>                 output directory. Default: the folder the
                                    terminal was opened in. A bare drive letter
                                    means that drive's root, so -o d -> D:\
    -q, --quality <height>          cap video height, e.g. -q 1080
        --best                      take the best available, skip the picker
        --mp3                       audio only, extracted to mp3
        --client <name>             force a yt-dlp player client, e.g. tv
        --cookies <browser>         use cookies from brave|chrome|chromium|edge|
                                    firefox|opera|safari|vivaldi|whale
    -p, --probe                     print what was resolved, then exit
        --sites                     what this app can reach
        --po-token                  proof-of-origin token setup and status
        --front <auto|on|off>       route filtered Google names through the front
        --front-check               measure the connection: is the front needed?
    -v, --version                   print version
    -h, --help                      this text

  THE MOUSE
    The sheet is fully clickable, like a windowed app inside the terminal:
    buttons, format rows, history, menus and the video timeline all respond to
    the pointer. A second click on a format row downloads it. The keyboard does
    everything the mouse does.

  IN THE SHEET
    ?               every shortcut, on any screen
    enter           download the highlighted row / fetch the url
    up down  j k    move between formats
    1 - 9           jump straight to a row
    left right      scrub the video frame by frame (click the timeline too)
    esc backspace   step back one screen, or cancel a transfer
    ^t              theme: auto / light / dark
    ^k              use cookies from a browser
    ^f              choose where files are saved
    ^r              fetch this url again
    ^o              open the output folder
    q  ^x           quit

  TYPING WORDS INSTEAD OF A LINK
    The field takes a title too: text that is not a link is searched on YouTube
    and the best match is opened in the sheet, so "lamar.jackson top.100" finds
    the video. A link you meant instead of a search is one esc away.

  Quit is plain \`q\`, not \`^q\`: most terminals have flow control on, where
  Ctrl+Q is XON and never reaches the app.

  SITE COVERAGE
    yt-dlp extracts ~1,800 sites and this app adds no blocklist of its own, so
    anything yt-dlp reaches is reachable here. Beyond that there is a direct
    file engine (any url) and a page scraper (og:video, <video>, <img>).
    \`mihanidown --sites\` prints the catalogue and yt-dlp's live extractor list.

  THE FRONT
    Where a government filters YouTube by name rather than by address, the front
    carries the download anyway: your own machine opens the connection, Google's
    own servers answer it, and only the name in the hello has to be one the filter
    lets through. Nothing is relayed through a third party and your address never
    changes, which is why YouTube still treats you like a viewer rather than like
    a datacentre.

    \`--front auto\` (the default) measures the connection at startup and does
    nothing when it is not filtered. \`--front-check\` prints the measurement.
    \`--front off\` never routes, even when it would help.

    The cost, stated plainly: yt-dlp is shown the front's own certificate, so it
    cannot check the name on it and runs with certificate checking off while the
    front is up. The front itself still verifies Google's certificate chain, so a
    filter impersonating Google would need a CA-signed certificate for it to work.
    It changes the name you ask under, not the country you are in: a video the
    uploader locked to one country stays locked.

  FAIR USE
    Personal archiving. Only keep what you have the right to keep. Nothing here
    touches DRM, and nothing spoofs your region.
`