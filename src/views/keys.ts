import {Sheet} from '../lib/sheet.js'
import {GLYPH, track} from '../theme.js'
import {BROWSERS} from '../lib/browsers.js'

export type Binding = {keys: string; what: string}

/**
 * One place that knows what the keys are.
 *
 * The footer strip only has room for five hints and it changes per screen, so
 * it cannot be the only place a key is documented. This table is what `?`
 * draws, and the footer is generated from it rather than restating it.
 */
export const BINDINGS: {phase: string; rows: Binding[]}[] = [
  {
    phase: 'anywhere',
    rows: [
      {keys: 'mouse', what: 'click any button, row or menu - everything works by pointer too'},
      {keys: '?', what: 'this sheet'},
      {keys: '^t', what: 'theme: auto / light / dark'},
      {keys: '^k', what: 'use cookies from a browser'},
      {keys: '^f', what: 'choose where files are saved'},
      {keys: '^o', what: 'open the output folder'},
      {keys: 'q', what: 'quit (or ^x)'},
    ],
  },
  {
    phase: 'intake',
    rows: [
      {keys: 'enter', what: 'fetch the url'},
      {keys: 'up down', what: 'previous and next url from history'},
      {keys: '^u', what: 'clear the field'},
      {keys: 'backspace', what: 'delete one character'},
      {keys: 'esc', what: 'clear the field'},
    ],
  },
  {
    phase: 'formats',
    rows: [
      {keys: 'up down j k', what: 'move between formats'},
      {keys: '1 - 9', what: 'jump straight to a row'},
      {keys: 'enter', what: 'download the highlighted format'},
      {keys: 'left right', what: 'scrub the video, frame by frame (click the timeline too)'},
      {keys: '^r', what: 'fetch again'},
      {keys: 'esc backspace', what: 'back to the field'},
    ],
  },
  {
    phase: 'transfer',
    rows: [
      {keys: 'esc backspace', what: 'cancel, and clean up the partial file'},
      {keys: 'q', what: 'quit'},
    ],
  },
  {
    phase: 'filed',
    rows: [
      {keys: 'enter', what: 'next url'},
      {keys: 'esc backspace', what: 'back to the formats for this page (also up/down)'},
      {keys: 'left right', what: 'scrub what you just downloaded'},
      {keys: '^o', what: 'open the output folder'},
      {keys: '^r', what: 'fetch this url again'},
    ],
  },
  {
    phase: 'halted',
    rows: [
      {keys: 'enter ^r', what: 'try again'},
      {keys: 'esc backspace', what: 'back to the field'},
      {keys: '^k', what: 'cookies, for the account checks'},
      {keys: 'q', what: 'quit'},
    ],
  },
]

/**
 * The shortcut sheet, drawn as a two-column table so the eye can scan keys
 * down a straight left edge.
 */
export function drawHelpMenu(sheet: Sheet, state: {cols: number; rows: number}): void {
  const all = BINDINGS.flatMap(group => group.rows)
  const keyWidth = Math.max(...all.map(b => b.keys.length)) + 3
  const longest = Math.max(...all.map(b => b.what.length))
  const panelWidth = Math.min(state.cols - 4, keyWidth + longest + 6)
  /*
   * Height derived from the content, never guessed. Every line the panel draws
   * is counted: 1 top border + 1 header + 1 rule, then per group a phase label
   * and its bindings, with 1 rule between groups, then 1 footer + 1 bottom
   * border.
   */
  const wanted =
    3 +
    BINDINGS.length +
    all.length +
    (BINDINGS.length - 1) +
    2
  const panelHeight = Math.min(state.rows - 2, wanted)
  const x = Math.floor((state.cols - panelWidth) / 2)
  const y = Math.max(0, Math.floor((state.rows - panelHeight) / 2))

  // Blank a margin so the menu reads as paper laid on top of the drawing.
  for (let row = y - 1; row <= y + panelHeight; row++) {
    for (let col = x - 2; col <= x + panelWidth + 1; col++) {
      const cell = sheet.cellAt(col, row)
      if (cell) {
        cell.char = ' '
        cell.intent = undefined
        cell.decor = undefined
        cell.opaque = true
      }
    }
  }

  sheet.box(x, y, panelWidth, panelHeight, 'rule')
  sheet.text(x + 2, y + 1, track('KEYS AND MOUSE'), 'mark', {bold: true})
  sheet.text(x + panelWidth - 13, y + 1, 'esc dismiss', 'muted')
  sheet.hline(x + 2, y + 2, panelWidth - 4, 'rule')

  const bottom = y + panelHeight - 2
  let row = y + 3
  let first = true
  for (const group of BINDINGS) {
    // A group is all-or-nothing: half a group reads as a broken sheet, so on a
    // short terminal we drop whole groups instead of truncating one.
    const need = group.rows.length + 1 + (first ? 0 : 1)
    if (row + need > bottom) break
    if (!first) {
      sheet.hline(x + 2, row, panelWidth - 4, 'muted', GLYPH.bullet)
      row++
    }
    sheet.text(x + 2, row, group.phase.toUpperCase(), 'mark')
    row++
    for (const binding of group.rows) {
      sheet.text(x + 4, row, binding.keys, 'accent', {bold: true})
      sheet.clip(x + 4 + keyWidth, row, binding.what, panelWidth - keyWidth - 8, 'ink')
      row++
    }
    first = false
  }

  sheet.clip(
    x + 2,
    bottom,
    'browsers for cookies: ' + BROWSERS.slice(1).join(' '),
    panelWidth - 4,
    'muted',
  )
}
