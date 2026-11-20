import {Sheet} from '../lib/sheet.js'
import {GLYPH, type Intent, type ThemeName} from '../theme.js'

export type Chrome = {
  cols: number
  rows: number
  theme: ThemeName
  colorDepth: number
}

/** Content box inside the sheet, leaving a margin all round. */
export function frame(terminalCols: number, terminalRows: number): {x: number; y: number; w: number; h: number} {
  // A drawing reads better with margins, so give it real ones when there is
  // room, and give them up gracefully when there isn't.
  const margin = terminalCols >= 92 ? 4 : terminalCols >= 70 ? 2 : 1
  const w = Math.max(38, Math.min(terminalCols - margin * 2, 110))
  const h = Math.max(10, terminalRows - 1)
  return {
    x: Math.max(1, Math.floor((terminalCols - w) / 2)),
    y: 0,
    w,
    h,
  }
}

/**
 * Layout tiers. A drawing that only works at 120x40 isn't a drawing, it's a
 * screenshot, so the sheet degrades in named steps and each tier keeps the two
 * things that matter: the plate and the choice you are about to make.
 */
export type Tier = 'full' | 'standard' | 'compact' | 'stack'

export function tierFor(rows: number, cols: number): Tier {
  if (rows >= 36 && cols >= 84) return 'full'
  if (rows >= 28 && cols >= 66) return 'standard'
  if (rows >= 20) return 'compact'
  return 'stack'
}

export type SheetBlock = {
  /** left-aligned status: which engine and which client answered */
  stamp: string
  hints: {key: string; label: string}[]
  themeName: string
}

/**
 * The fixed parts of every screen: the app name, the status, a rule, the
 * content area, and a hint strip along the bottom. No dot grid, no
 * registration marks — decoration that rendered as noise in the old console
 * fonts is gone, and the chrome is two hairlines and some words.
 */
export function drawChrome(sheet: Sheet, chrome: Chrome, block: SheetBlock): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  const last = chrome.rows - 1

  sheet.text(x, 1, 'mihanidown', 'title', {bold: true})

  const stamp = block.stamp
  if (stamp.length > 0 && w > 'mihanidown'.length + stamp.length + 4) {
    sheet.text(x + w - stamp.length, 1, stamp, 'measure')
  }

  sheet.hline(x, 2, w, 'rule')
  sheet.hline(x, last - 2, w, 'rule')
  drawHints(sheet, chrome, block.hints, last - 1, x, w)
}

/**
 * The hint strip. Keys first in bold, then what they do; dropped from the
 * right when the terminal is narrow, because the leftmost hints are the ones
 * you need when the terminal is small.
 */
export function drawHints(
  sheet: Sheet,
  chrome: Chrome,
  hints: {key: string; label: string}[],
  y: number,
  x: number,
  w: number,
): void {
  let col = x
  for (const hint of hints) {
    const width = hint.key.length + hint.label.length + 4
    if (col + width > x + w) break
    sheet.text(col, y, hint.key, 'accent', {bold: true})
    sheet.text(col + hint.key.length + 1, y, hint.label, 'muted')
    col += width
  }
  // The mouse is a first-class input here, and one quiet line on the first
  // screen teaches it without shouting about it.
  if (w - (col - x) >= 24) {
    sheet.text(x + w - 24, y, GLYPH.pointer + ' mouse: click anything', 'muted')
  }
}

/** Section head inside the content area: `── title ─────────`. */
export function rule(sheet: Sheet, x: number, y: number, w: number, label: string, intent: Intent = 'mark'): void {
  sheet.text(x, y, label, intent, {bold: true})
  if (w > label.length + 2) sheet.hline(x + label.length + 2, y, w - label.length - 2, 'rule')
}
