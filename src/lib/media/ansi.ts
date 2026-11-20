import {fit, type Pixels} from './decode.js'
import {RESET_BG, RESET_FG} from '../../theme.js'

export type Renderer = 'blocks' | 'ascii' | 'none'

/**
 * Pick the best way to draw pixels here.
 *
 * `blocks` uses U+2580 UPPER HALF BLOCK: one cell carries two vertically
 * stacked pixels as a truecolor foreground/background pair. That doubles the
 * vertical resolution over a naive one-cell-one-pixel grid and works in every
 * terminal with 24-bit colour — Windows Terminal, iTerm2, Ghostty, WezTerm,
 * Alacritty, Konsole.
 */
export function pickRenderer(colorDepth: number, supportsUnicode: boolean): Renderer {
  if (colorDepth >= 24 && supportsUnicode) return 'blocks'
  if (colorDepth >= 8 && supportsUnicode) return 'blocks'
  if (colorDepth >= 8) return 'ascii'
  return 'none'
}

/**
 * Pixel grid -> half-block cell grid. `src` must already be fitted to
 * cols x (cellRows * 2); this function does no scaling of its own so the plate
 * and the filmstrip agree on what a cell is worth.
 */
export function toBlocks(src: Pixels, cols: number, cellRows: number): string {
  const width = src.width
  const top = Buffer.alloc(cols * 3)
  const bottom = Buffer.alloc(cols * 3)
  const glyph = '\u2580'
  let out = ''

  for (let row = 0; row < cellRows; row++) {
    const topRow = Math.min(src.height - 1, row * 2)
    const bottomRow = Math.min(src.height - 1, row * 2 + 1)

    for (let col = 0; col < cols; col++) {
      const to = (topRow * width + col) * 3
      const bo = (bottomRow * width + col) * 3
      top[col * 3] = src.data[to] ?? 0
      top[col * 3 + 1] = src.data[to + 1] ?? 0
      top[col * 3 + 2] = src.data[to + 2] ?? 0
      bottom[col * 3] = src.data[bo] ?? 0
      bottom[col * 3 + 1] = src.data[bo + 1] ?? 0
      bottom[col * 3 + 2] = src.data[bo + 2] ?? 0
    }

    // Runs of identical colours are extremely common in flat areas (letterbox
    // bars, solid backgrounds). Collapsing them cuts the escape-sequence count
    // by roughly an order of magnitude on real thumbnails.
    let col = 0
    while (col < cols) {
      const t: [number, number, number] = [top[col * 3] ?? 0, top[col * 3 + 1] ?? 0, top[col * 3 + 2] ?? 0]
      let run = 1
      while (col + run < cols && sameColor(top, col + run, t)) run++
      out += `\u001b[38;2;${t[0]};${t[1]};${t[2]}m`

      let runStart = 0
      while (runStart < run) {
        const b: [number, number, number] = [
          bottom[(col + runStart) * 3] ?? 0,
          bottom[(col + runStart) * 3 + 1] ?? 0,
          bottom[(col + runStart) * 3 + 2] ?? 0,
        ]
        let bRun = 1
        while (runStart + bRun < run && sameColor(bottom, col + runStart + bRun, b)) bRun++
        out += `\u001b[48;2;${b[0]};${b[1]};${b[2]}m${glyph.repeat(bRun)}`
        runStart += bRun
      }
      out += `${RESET_BG}${RESET_FG}`
      col += run
    }
    if (row < cellRows - 1) out += '\n'
  }
  return out
}

function sameColor(buffer: Buffer, index: number, value: [number, number, number]): boolean {
  return (
    buffer[index * 3] === value[0] && buffer[index * 3 + 1] === value[1] && buffer[index * 3 + 2] === value[2]
  )
}

/** Luminance ramp for terminals without colour, or as a stylised fallback. */
const RAMP = ' .:-=+*#%@'

export function toAscii(src: Pixels, cols: number, cellRows: number, colored: boolean): string {
  let out = ''
  for (let row = 0; row < cellRows; row++) {
    const y = Math.min(src.height - 1, Math.round((row * src.height) / cellRows))
    for (let col = 0; col < cols; col++) {
      const x = Math.min(src.width - 1, Math.round((col * src.width) / cols))
      const o = (y * src.width + x) * 3
      const r = src.data[o] ?? 0
      const g = src.data[o + 1] ?? 0
      const b = src.data[o + 2] ?? 0
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
      const glyph = RAMP[Math.min(RAMP.length - 1, Math.round(luma * (RAMP.length - 1)))]
      out += colored ? `\u001b[38;2;${r};${g};${b}m${glyph}${RESET_FG}` : glyph
    }
    if (row < cellRows - 1) out += '\n'
  }
  return out
}

/**
 * The one call the UI makes: pixels in, terminal cells out.
 *
 * `fit` does the sampling — it treats a cell as two stacked pixels, so the
 * artwork is fitted to the cell grid rather than the pixel grid. Getting this
 * backwards is why most terminal previews look stretched.
 */
export function renderPixels(src: Pixels, cols: number, cellRows: number, mode: Renderer): string {
  if (mode === 'none') return ''
  const fitted = fit(src, cols, cellRows * 2)
  return mode === 'blocks' ? toBlocks(fitted, cols, cellRows) : toAscii(fitted, cols, cellRows, true)
}