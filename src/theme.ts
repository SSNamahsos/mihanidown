/**
 * Design tokens for mihanidown.
 *
 * The sheet is a technical drawing: drafting paper in light mode, a cyanotype
 * in dark mode. Structure is carried by hairlines, a dot grid and registration
 * marks; hierarchy comes from tracked-out uppercase display type and measured
 * numerals rather than from colour. Colour is spent in exactly one place: the
 * live plate.
 */

export type ThemeName = 'auto' | 'light' | 'dark'

export type Palette = {
  /** sheet */
  bg: string
  /** the faint dot grid printed behind everything */
  grid: string
  /** hairlines: panel borders, rules */
  rule: string
  /** registration marks, ticks */
  mark: string
  /** primary type */
  ink: string
  /** secondary type: units, hints, labels */
  muted: string
  /** the single accent: focus, selection, progress fill */
  accent: string
  /** measurement: active row, size estimates */
  measure: string
  /** completion */
  good: string
  /** failure */
  bad: string
}

const CYANOTYPE: Palette = {
  bg: '#0A0F14',
  grid: '#101A23',
  rule: '#1C2E3B',
  mark: '#265064',
  ink: '#D6E4EE',
  muted: '#5C7A8C',
  accent: '#4CC9E0',
  measure: '#F0A93B',
  good: '#6FD08C',
  bad: '#F0655F',
}

const DRAFTING: Palette = {
  bg: '#EDF2F5',
  grid: '#E1E9EE',
  rule: '#B7CAD5',
  mark: '#7E9BAB',
  ink: '#0B1A24',
  muted: '#5F7B8B',
  accent: '#0A7B92',
  measure: '#A96A05',
  good: '#1D7A44',
  bad: '#B4342C',
}

export const PALETTES: Record<'dark' | 'light', Palette> = {
  dark: CYANOTYPE,
  light: DRAFTING,
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Type helpers
 * ------------------------------------------------------------------ */

/**
 * Display labels go through here unchanged. Hair-space tracking used to live
 * here and rendered as `S P A C E D  O U T` text wherever a terminal collapses
 * U+2009, so it is gone; hierarchy now comes from weight and intent.
 */
export function track(input: string): string {
  return input
}

/** Fixed-width numeric slot so columns don't shimmer while progress ticks. */
export function slot(value: string, width: number): string {
  if (value.length >= width) return value.slice(-width)
  return ' '.repeat(width - value.length) + value
}

export function pad(value: string, width: number): string {
  if (value.length >= width) return value.slice(0, width)
  return value + ' '.repeat(width - value.length)
}

export function center(input: string, width: number): string {
  const clipped = input.length > width ? input.slice(0, Math.max(0, width - 1)) + '\u2026' : input
  const left = Math.floor((width - clipped.length) / 2)
  return ' '.repeat(Math.max(0, left)) + clipped
}

/* ------------------------------------------------------------------ *
 * Glyphs
 * ------------------------------------------------------------------ *
 *
 * Every character here is drawn correctly by the old Windows console fonts
 * (cp437) as well as by Windows Terminal, so the sheet never degrades into
 * tofu boxes or stray escape sequences. Anything a terminal might miss —
 * U+23CE return, U+2713 check, U+25B8 small pointer — is not in the set.
 */

export const GLYPH = {
  /** top-left / top-right / bottom-left / bottom-right panel corners */
  tl: '\u250c',
  tr: '\u2510',
  bl: '\u2514',
  br: '\u2518',
  h: '\u2500',
  v: '\u2502',
  /** half block: one cell, two pixels. the plate is built from these. */
  half: '\u2580',
  arrow: '\u2192',
  left: '\u2190',
  up: '\u2191',
  down: '\u2193',
  bullet: '\u00b7',
  pointer: '\u25ba',
  leftTri: '\u25c4',
  bar: '\u2502',
  block: '\u2588',
  shade: '\u2591',
  tick: '\u221a',
  cross2: '\u00d7',
} as const

/* ------------------------------------------------------------------ *
 * Theme resolution
 * ------------------------------------------------------------------ */

function envPrefersDark(): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false
  const term = process.env['COLORTERM'] ?? ''
  return term !== '' && term !== 'truecolor'
}

/**
 * `auto` means "use whatever the terminal is already doing". For that we emit no
 * background colour at all and lean on the terminal's own foreground, so the app
 * follows light/dark terminal themes without us guessing.
 */
export function resolvePalette(theme: ThemeName, colorDepth: number): Palette | 'terminal' {
  if (theme === 'auto') return 'terminal'
  if (theme === 'dark') return PALETTES.dark
  return PALETTES.light
}

/* ------------------------------------------------------------------ *
 * Intent
 * ------------------------------------------------------------------ *
 *
 * The sheet records *what a mark means*, never a hex value. `auto` mode has no
 * palette of its own — it borrows the terminal's foreground and background — so
 * an intent has to survive without colour. Each intent maps to either a palette
 * colour (explicit themes) or an ANSI attribute pair (auto), which is why
 * `muted` is dim in one and a grey in the other but occupies the same slot in
 * the drawing either way.
 */

export type Intent =
  | 'title'
  | 'ink'
  | 'muted'
  | 'accent'
  | 'measure'
  | 'good'
  | 'bad'
  | 'rule'
  | 'mark'
  | 'grid'
  | 'select'
  | 'none'

export type Decorations = {
  bold?: boolean
  underline?: boolean
  inverse?: boolean
}

/** Returns the SGR prefix for an intent; '' means "terminal default". */
export type StyleResolver = (intent: Intent | undefined, decor?: Decorations) => string

const AUTO_STYLES: Record<Intent, string> = {
  title: '\u001b[1m',
  ink: '',
  muted: '\u001b[2m',
  accent: '\u001b[1m',
  measure: '\u001b[1m',
  good: '\u001b[1m',
  bad: '\u001b[1m',
  rule: '\u001b[2m',
  mark: '\u001b[2m',
  grid: '\u001b[2m',
  select: '\u001b[1m',
  none: '',
}

export function createStyleResolver(theme: ThemeName, colorDepth: number): StyleResolver {
  const palette = resolvePalette(theme, colorDepth)

  return (intent, decor) => {
    if (!intent || intent === 'none') return ''
    if (palette === 'terminal') {
      let sgr = AUTO_STYLES[intent]
      if (decor?.bold && intent !== 'title') sgr = '\u001b[1m'
      if (decor?.underline) sgr += '\u001b[4m'
      if (decor?.inverse) sgr += '\u001b[7m'
      return sgr
    }
    const map: Record<Intent, string> = {
      title: palette.ink,
      ink: palette.ink,
      muted: palette.muted,
      accent: palette.accent,
      measure: palette.measure,
      good: palette.good,
      bad: palette.bad,
      rule: palette.rule,
      mark: palette.mark,
      grid: palette.grid,
      select: palette.accent,
      none: palette.ink,
    }
    let sgr = `\u001b[38;2;${rgb(map[intent]).join(';')}m`
    if (decor?.bold || intent === 'title') sgr += '\u001b[1m'
    if (decor?.underline) sgr += '\u001b[4m'
    if (decor?.inverse) sgr += '\u001b[7m'
    return sgr
  }
}

export const RESET = '\u001b[0m'

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** 24-bit foreground from an rgb triple, used by the plate renderer. */
export function fg(r: number, g: number, b: number): string {
  return `\u001b[38;2;${r};${g};${b}m`
}

export const RESET_FG = '\u001b[39m'
export const RESET_BG = '\u001b[49m'