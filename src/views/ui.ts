import {Sheet} from '../lib/sheet.js'
import {GLYPH, type Intent} from '../theme.js'

/**
 * The small shared vocabulary of the sheet: buttons and status dots.
 *
 * A button is drawn as a bracketed label and registers the rectangle it was
 * drawn in, so the thing you see is exactly the thing that catches the mouse.
 * Hovering uses inverse video where available and bold otherwise, which reads
 * as "this is live" in both tinted and monochrome terminals.
 */

export type ButtonStyle = {
  /** the pointer is over this button */
  hovered?: boolean
  /** it is the primary action on this screen */
  primary?: boolean
  /** it reflects a state that is currently off or unavailable */
  muted?: boolean
}

/**
 * Draw `[ label ]` at x,y and register it as region `id`. Returns the width it
 * occupied, so callers can lay buttons out in a row and wrap when they run out
 * of room.
 */
export function button(sheet: Sheet, id: string, x: number, y: number, label: string, style: ButtonStyle = {}): number {
  const text = ` ${label} `
  const width = text.length + 2
  const intent: Intent = style.muted ? 'muted' : style.primary || style.hovered ? 'accent' : 'ink'
  const decor = style.hovered ? {bold: true, inverse: true} : style.primary ? {bold: true} : undefined

  sheet.put(x, y, '[', style.hovered ? 'accent' : 'rule', style.hovered ? {bold: true} : undefined)
  sheet.put(x + width - 1, y, ']', style.hovered ? 'accent' : 'rule', style.hovered ? {bold: true} : undefined)
  sheet.text(x + 1, y, text, intent, decor)
  sheet.region(id, x, y, width, 1)
  return width
}

/**
 * A row of buttons, wrapped onto further lines when the panel is too narrow.
 * Returns the row count it used.
 */
export function buttonRow(
  sheet: Sheet,
  buttons: {id: string; label: string; style?: ButtonStyle}[],
  x: number,
  y: number,
  maxWidth: number,
): number {
  let col = x
  let row = y
  for (const item of buttons) {
    const label = item.label
    const width = label.length + 4
    if (col > x && col + width > x + maxWidth) {
      col = x
      row += 1
    }
    button(sheet, item.id, col, row, label, item.style ?? {})
    col += width + 2
  }
  return row - y + 1
}

/**
 * A selectable list row: pointer, optional number key, label, right-aligned
 * detail. Registers the whole line width as region `id`.
 */
export function listRow(
  sheet: Sheet,
  id: string,
  x: number,
  y: number,
  w: number,
  label: string,
  detail: string,
  active: boolean,
  options: {number?: string; note?: string} = {},
): void {
  if (active) {
    for (let col = x + 1; col < x + w - 1; col++) sheet.put(col, y, ' ', 'none', {inverse: active})
  }
  sheet.put(x + 2, y, active ? GLYPH.pointer : ' ', active ? 'accent' : 'muted', active ? {bold: true} : undefined)
  let cursor = x + 4
  if (options.number) {
    sheet.text(cursor, y, options.number, active ? 'accent' : 'muted', active ? {bold: true} : undefined)
    cursor += options.number.length + 2
  }
  sheet.clip(cursor, y, label, Math.max(4, (options.note ? x + w - (options.note.length + 3) : x + w - 2) - cursor), active ? 'accent' : 'ink', active ? {bold: true} : undefined)
  if (options.note) sheet.text(x + w - options.note.length - 3, y, options.note, active ? 'accent' : 'good')
  if (detail) sheet.clip(x + w - detail.length - 2, y, detail, Math.max(0, detail.length), active ? 'measure' : 'muted')
  sheet.region(id, x, y, w, 1)
}

/** A left label / right value status line. */
export function statusLine(sheet: Sheet, x: number, y: number, w: number, label: string, value: string, intent: Intent = 'ink'): void {
  sheet.text(x, y, label, 'muted')
  sheet.clip(x + label.length + 2, y, value, Math.max(0, w - label.length - 2), intent)
}
