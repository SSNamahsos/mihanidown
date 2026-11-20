import {Sheet} from '../lib/sheet.js'
import {GLYPH, track} from '../theme.js'
import {BROWSERS} from '../lib/browsers.js'
import type {AppState} from '../state.js'

/**
 * The two overlays: where files go, and which browser session to borrow.
 *
 * Both are questions about the thing you are already looking at, so both are
 * drawn as sheets laid over the current screen rather than as new screens.
 * Rows are one clickable region each, as wide as the panel.
 */

/** Blank a margin around a panel so the sheet underneath does not bleed through. */
function clearBehind(sheet: Sheet, x: number, y: number, w: number, h: number): void {
  for (let row = y - 1; row <= y + h; row++) {
    for (let col = x - 2; col <= x + w + 1; col++) {
      const cell = sheet.cellAt(col, row)
      if (cell) {
        cell.char = ' '
        cell.intent = undefined
        cell.decor = undefined
        cell.opaque = true
      }
    }
  }
}

export function drawSaveMenu(sheet: Sheet, state: AppState): void {
  const list = state.roots
  const width = Math.min(64, state.cols - 8)
  const height = Math.max(7, list.length + 6)
  const x = Math.floor((state.cols - width) / 2)
  const y = Math.floor((state.rows - height) / 2)

  clearBehind(sheet, x, y, width, height)

  sheet.box(x, y, width, height, 'rule')
  sheet.text(x + 2, y + 1, track('SAVE TO'), 'mark', {bold: true})
  sheet.hline(x + 2, y + 2, width - 4, 'rule')

  if (list.length === 0) {
    sheet.text(x + 2, y + 3, 'looking for drives...', 'muted')
    sheet.text(x + 2, y + height - 2, 'esc dismiss', 'muted')
    return
  }

  for (let i = 0; i < list.length; i++) {
    const root = list[i] as {label: string; dir: string; detail: string}
    const row = y + 3 + i
    const selected = i === state.saveCursor
    if (selected) {
      for (let col = x + 1; col < x + width - 1; col++) sheet.put(col, row, ' ', 'none', {inverse: true})
    }
    sheet.put(x + 3, row, selected ? GLYPH.pointer : ' ', 'accent', {bold: selected})
    // Labels sit in a fixed-width slot so the paths line up down the list.
    sheet.text(x + 5, row, root.label.slice(0, 12).padEnd(12), selected ? 'accent' : 'ink', selected ? {bold: true} : undefined)
    // The path, not a reassurance: it is what tells you the label means what
    // you think it means.
    sheet.clip(x + 18, row, root.detail || root.dir, width - 32, selected ? 'ink' : 'muted')
    if (root.dir === state.outDir) sheet.text(x + width - 11, row, GLYPH.tick + ' current', 'good')
    sheet.region(`save:${i}`, x + 1, row, width - 2, 1)
  }

  sheet.text(x + 2, y + height - 2, 'enter choose    esc dismiss', 'muted')
}

export function drawCookiesMenu(sheet: Sheet, state: AppState): void {
  const width = Math.min(56, state.cols - 8)
  const height = BROWSERS.length + 6
  const x = Math.floor((state.cols - width) / 2)
  const y = Math.floor((state.rows - height) / 2)

  clearBehind(sheet, x, y, width, height)

  sheet.box(x, y, width, height, 'rule')
  sheet.text(x + 2, y + 1, track('COOKIES FROM'), 'mark', {bold: true})
  sheet.text(x + width - 12, y + 1, state.cookies ?? 'none', 'muted')
  sheet.hline(x + 2, y + 2, width - 4, 'rule')
  sheet.text(x + 2, y + 3, 'borrow the sign-in session of a browser on this machine', 'muted')

  for (let i = 0; i < BROWSERS.length; i++) {
    const browser = BROWSERS[i] as string
    const row = y + 4 + i
    const selected = i === state.cookiesCursor
    if (selected) {
      for (let col = x + 1; col < x + width - 1; col++) sheet.put(col, row, ' ', 'none', {inverse: true})
    }
    sheet.put(x + 3, row, selected ? GLYPH.pointer : ' ', 'accent', {bold: selected})
    sheet.text(x + 5, row, browser, selected ? 'accent' : 'ink', selected ? {bold: true} : undefined)
    if (state.cookies === browser) sheet.text(x + width - 12, row, GLYPH.tick + ' current', 'good')
    sheet.region(`cookie:${i}`, x + 1, row, width - 2, 1)
  }
  sheet.text(x + 2, y + height - 2, 'enter pick    esc dismiss', 'muted')
}
