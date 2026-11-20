import {GLYPH, RESET, type Decorations, type Intent, type StyleResolver} from '../theme.js'

/**
 * A cell grid you draw a drafting sheet on.
 *
 * Component-per-element would fight this design: hairlines have to line up
 * across panels, the grid has to show through the margins, and the plate is a
 * pre-rendered block of truecolour that must land at an exact column. So the
 * sheet is composed as a character canvas first and handed to Ink as text at the
 * very end.
 *
 * Cells carry an *intent*, never a colour, so the same drawing renders correctly
 * in an explicit palette and in `auto` mode where colour comes from the terminal.
 */

type Cell = {
  char: string
  intent?: Intent
  decor?: Decorations
  /** an opaque cell knocks out whatever the grid printed underneath */
  opaque?: boolean
}

/**
 * A rectangle the mouse can act on. Views register these as they draw, so the
 * drawing and its hit targets can never drift apart: the button you see is the
 * button you click.
 */
export type Region = {
  /** action key, dispatched by the app — `btn:download`, `choice:2`, `save:0`… */
  id: string
  x: number
  y: number
  w: number
  h: number
}

export class Sheet {
  private readonly cells: Cell[][]
  /** pre-rendered lines (the plate) spliced in verbatim at a known column */
  private readonly raw = new Map<number, {text: string; x: number}>()
  /** clickable rectangles, in draw order — later registration wins a click */
  private readonly areas: Region[] = []

  constructor(
    readonly width: number,
    readonly height: number,
    private readonly styles: StyleResolver,
  ) {
    this.cells = Array.from({length: height}, () =>
      Array.from({length: width}, (): Cell => ({char: ' '})),
    )
  }

  /** Direct cell access, for overlays that need to knock out what's beneath. */
  cellAt(x: number, y: number): Cell | undefined {
    return this.cells[y]?.[x]
  }

  clear(char = ' ', opaque = false): this {
    for (const row of this.cells) {
      for (const cell of row) {
        cell.char = char
        cell.intent = undefined
        cell.decor = undefined
        cell.opaque = opaque
      }
    }
    this.areas.length = 0
    return this
  }

  /** Register a clickable rectangle. The most recent registration wins. */
  region(id: string, x: number, y: number, w: number, h: number): this {
    if (w <= 0 || h <= 0) return this
    this.areas.push({id, x, y, w, h})
    return this
  }

  /** The clickable rectangles for this frame, in draw order. */
  get regions(): readonly Region[] {
    return this.areas
  }

  /** Topmost region containing this cell, or undefined. */
  hit(col: number, row: number): Region | undefined {
    for (let i = this.areas.length - 1; i >= 0; i--) {
      const area = this.areas[i] as Region
      if (col >= area.x && col < area.x + area.w && row >= area.y && row < area.y + area.h) return area
    }
    return undefined
  }

  put(x: number, y: number, char: string, intent?: Intent, decor?: Decorations): this {
    const cell = this.cells[y]?.[x]
    if (!cell) return this
    cell.char = char
    cell.intent = intent
    cell.decor = decor
    return this
  }

  /** Write a run of text. `\n` resets to the starting column. */
  text(x: number, y: number, value: string, intent?: Intent, decor?: Decorations): number {
    let col = x
    let row = y
    for (const char of value) {
      if (char === '\n') {
        row += 1
        col = x
        continue
      }
      this.put(col, row, char, intent, decor)
      col += 1
    }
    return col
  }

  /** Text clipped to `max` cells, with a trailing ellipsis when it won't fit. */
  clip(x: number, y: number, value: string, max: number, intent?: Intent, decor?: Decorations): void {
    if (max <= 0) return
    if (value.length <= max) {
      this.text(x, y, value, intent, decor)
      return
    }
    this.text(x, y, `${value.slice(0, Math.max(0, max - 1))}\u2026`, intent, decor)
  }

  repeat(x: number, y: number, count: number, char: string, intent?: Intent): number {
    return this.text(x, y, char.repeat(Math.max(0, count)), intent)
  }

  hline(x: number, y: number, length: number, intent: Intent = 'rule', char: string = GLYPH.h): void {
    this.repeat(x, y, length, char, intent)
  }

  vline(x: number, y: number, length: number, intent: Intent = 'rule', char: string = GLYPH.v): void {
    for (let i = 0; i < length; i++) this.put(x, y + i, char, intent)
  }

  /**
   * A panel with hairline walls and open corners. Engineering drawings use open
   * corners so the frame never competes with the contents.
   */
  box(x: number, y: number, w: number, h: number, intent: Intent = 'rule'): this {
    if (w < 2 || h < 2) return this
    this.put(x, y, GLYPH.tl, intent)
    this.put(x + w - 1, y, GLYPH.tr, intent)
    this.put(x, y + h - 1, GLYPH.bl, intent)
    this.put(x + w - 1, y + h - 1, GLYPH.br, intent)
    this.hline(x + 1, y, w - 2, intent)
    this.hline(x + 1, y + h - 1, w - 2, intent)
    this.vline(x, y + 1, h - 2, intent)
    this.vline(x + w - 1, y + 1, h - 2, intent)
    return this
  }

  /** Section head: rule, tracked-out label in a break, rule. Symmetric. */
  labelledRule(x: number, y: number, w: number, label: string, intent: Intent = 'mark'): void {
    const tracked = track(label)
    const gap = 1
    const rule = Math.max(0, w - tracked.length - gap * 2)
    const left = Math.floor(rule / 2)
    const right = rule - left
    this.hline(x, y, left, 'rule')
    this.text(x + left + gap, y, tracked, intent)
    if (right > 0) this.hline(x + left + gap + tracked.length + gap, y, right, 'rule')
  }

  /**
   * Paste a pre-rendered block — the plate, which already carries its own
   * truecolour sequences. Those must survive untouched, so the row composes as
   * head + raw + tail instead of being re-derived from cells.
   */
  block(x: number, y: number, rendered: string, rows: number): void {
    const lines = rendered.split('\n')
    for (let row = 0; row < rows; row++) {
      const line = lines[row]
      if (line === undefined) continue
      const target = y + row
      if (target < 0 || target >= this.height) continue
      // mark the span opaque so grid dots never print through the artwork
      const visible = visibleWidth(line)
      for (let i = x; i < Math.min(this.width, x + visible); i++) {
        this.put(i, target, ' ')
        const cell = this.cells[target]?.[i]
        if (cell) cell.opaque = true
      }
      this.raw.set(target, {text: line, x})
    }
  }

  /** The dot grid, printed only where nothing else has claimed a cell. */
  grid(intent: Intent = 'grid', spacing = 2, char = '\u00b7'): this {
    return this.gridRegion(0, 0, this.width, this.height, intent, spacing, char)
  }

  /**
   * The dot grid restricted to a region. The sheet prints its texture only in
   * the margins and the header/footer bands: grid paper shows around the
   * drawing, not underneath the measurements, where it would compete with them.
   */
  gridRegion(
    rx: number,
    ry: number,
    rw: number,
    rh: number,
    intent: Intent = 'grid',
    spacing = 2,
    char = '\u00b7',
  ): this {
    const x0 = Math.max(0, rx)
    const y0 = Math.max(0, ry)
    const x1 = Math.min(this.width, rx + rw)
    const y1 = Math.min(this.height, ry + rh)
    for (let y = y0; y < y1; y++) {
      const row = this.cells[y]
      if (!row) continue
      // Spacing is measured from the region's own corner, not the sheet's, so a
      // band that starts on an odd row still gets a regular lattice instead of
      // nothing at all.
      if ((y - y0) % spacing !== 0) continue
      for (let x = x0; x < x1; x++) {
        const cell = row[x]
        if (!cell || cell.char !== ' ' || cell.opaque) continue
        if ((x - x0) % spacing !== 0) continue
        this.put(x, y, char, intent)
      }
    }
    return this
  }

  toLines(): string[] {
    const out: string[] = []
    for (let y = 0; y < this.height; y++) {
      const row = this.cells[y] as Cell[]
      const rawLine = this.raw.get(y)
      if (!rawLine) {
        out.push(this.compress(row))
        continue
      }
      const head = this.compress(row.slice(0, rawLine.x))
      const tail = this.compress(row.slice(rawLine.x + visibleWidth(rawLine.text)))
      out.push(`${head}${rawLine.text}${tail}`)
    }
    return out
  }

  toString(): string {
    return this.toLines().join('\n')
  }

  private compress(cells: Cell[]): string {
    let out = ''
    let runStyle: string | undefined
    let run = ''
    const flush = () => {
      if (run.length === 0) return
      out += runStyle ? `${runStyle}${run}${RESET}` : run
      run = ''
    }
    for (const cell of cells) {
      const style = cell.intent ? this.styles(cell.intent, cell.decor) : ''
      if (style !== runStyle) {
        flush()
        runStyle = style
      }
      run += cell.char
    }
    flush()
    return out
  }
}

/**
 * Display labels go through here. The hair-space tracking that used to live in
 * this function rendered as `S P A C E D  O U T` text on every terminal whose
 * font ignores U+2009 — which is most of them — so labels are passed through
 * untouched and hierarchy is carried by weight and intent instead.
 */
export function track(value: string): string {
  return value
}

/** Character count, ignoring escape sequences. */
export function visibleWidth(value: string): number {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\u001b\[[0-9;]*m/g, '').length
}