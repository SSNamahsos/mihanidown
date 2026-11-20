/**
 * Mouse support, terminal edition.
 *
 * The terminal sends mouse activity as escape sequences when the app asks for
 * it. Two encodings matter:
 *
 *  - SGR (mode 1006): `ESC[<b;x;yM` — digits, semicolons, and a final `M`
 *    (press/motion) or `m` (release). Windows Terminal and every modern Unix
 *    terminal speak this one.
 *  - X10 (mode 1000, the legacy default): `ESC[M` followed by three raw bytes.
 *    The classic Windows console host falls back to this when it cannot do SGR.
 *
 * What the sheet does with an event is decided by where it lands: views
 * register clickable rectangles while drawing, and the app maps a click to the
 * region it hit. This module only turns bytes into coordinates.
 *
 * One wrinkle forces the parser to be stateful: Ink's input tokenizer hands
 * useInput whole CSI sequences but strips the leading ESC, and for the X10
 * encoding it treats the payload bytes after `ESC[M` as separate events. The
 * parser here therefore accepts both `ESC[<…M` and `[<…M`, and collects the
 * three X10 payload bytes across successive calls when it has to.
 *
 * Coordinates are 0-based cells in the events this produces.
 */

export type MouseKind = 'down' | 'up' | 'move' | 'wheel'

export type MouseEvent = {
  kind: MouseKind
  /** 0 = left, 1 = middle, 2 = right; wheel events always report 0 */
  button: number
  /** 0-based column */
  col: number
  /** 0-based row */
  row: number
  /** -1 wheel up, +1 wheel down, undefined otherwise */
  wheel?: 1 | -1
}

export const MOUSE_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1003h\u001b[?1006h'
export const MOUSE_OFF = '\u001b[?1006l\u001b[?1003l\u001b[?1002l\u001b[?1000l'

const SGR = /^<?(\d+);(\d+);(\d+)([Mm])$/

export type MouseParser = {parse: (chunk: string) => MouseEvent | null}

/** A fresh parser with empty X10 buffers. One per app instance. */
export function createMouseParser(): MouseParser {
  // X10 payload bytes (button, column, row) collected so far, and whether the
  // `[M` header has been seen and the payload is still owed to it.
  let owed: number[] = []
  let collecting = false

  const decode = (cb: number, col: number, row: number): MouseEvent | null => {
    if (col < 0 || row < 0) return null
    // 64/65 in the low byte are wheel up/down.
    if (cb >= 64 && cb <= 65) {
      return {kind: 'wheel', button: 0, col, row, wheel: cb === 64 ? -1 : 1}
    }
    const button = cb & 3
    // 3 in the low bits means release or motion with no button held; either
    // way the pointer went somewhere.
    if (button === 3) return {kind: 'move', button: 0, col, row}
    if (cb >= 32) return {kind: 'move', button, col, row}
    return {kind: 'down', button, col, row}
  }

  return {
    parse(chunk: string): MouseEvent | null {
      // Finishing an X10 event whose payload arrived as its own events.
      if (collecting) {
        for (const char of chunk) {
          owed.push(char.charCodeAt(0))
          if (owed.length === 3) {
            const [cb, col, row] = owed as [number, number, number]
            owed = []
            collecting = false
            return decode(cb - 32, col - 32, row - 32)
          }
        }
        return null
      }

      if (!chunk.includes('[') && !chunk.startsWith('\u001b')) return null
      // Ink strips the leading ESC from escape sequences it passes through.
      const body = chunk.startsWith('\u001b') ? chunk.slice(1) : chunk
      if (!body.startsWith('[')) return null

      const sgr = SGR.exec(body.slice(1))
      if (sgr) {
        const raw = Number(sgr[1])
        // SGR coordinates are 1-based; the sheet is 0-based.
        const event = decode(raw, Number(sgr[2]) - 1, Number(sgr[3]) - 1)
        if (!event) return null
        if (sgr[4] === 'm') return event.kind === 'move' ? event : {...event, kind: 'up'}
        if (raw >= 32 && raw <= 63) return {...event, kind: 'move'}
        return event
      }

      if (body.startsWith('[M')) {
        const rest = body.slice(2)
        if (rest.length === 0) {
          // The payload comes as its own events; collect them as they arrive.
          collecting = true
          owed = []
          return null
        }
        if (rest.length >= 3) {
          return decode(
            rest.charCodeAt(0) - 32,
            rest.charCodeAt(1) - 32,
            rest.charCodeAt(2) - 32,
          )
        }
        collecting = true
        owed = [...rest].map(c => c.charCodeAt(0))
        return null
      }

      return null
    },
  }
}

/**
 * The one-shot form, for tests and for terminals whose input arrives whole.
 * Not used by the app loop, which needs the stateful parser above.
 */
export function parseMouse(chunk: string): MouseEvent | null {
  return createMouseParser().parse(chunk)
}
