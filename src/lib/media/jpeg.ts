/**
 * A JPEG reader, in plain JavaScript.
 *
 * Why this exists: almost every thumbnail on the internet is JPEG. YouTube,
 * Vimeo, Twitter, every news site. A PNG reader alone meant the plate showed
 * nothing for exactly the images people most want to look at, unless ffmpeg
 * happened to be installed.
 *
 * Both scan styles are implemented, because both are ordinary:
 *
 *  - Baseline sequential (SOF0) — what old encoders emit.
 *  - Progressive (SOF2) — what every current encoder emits by default. A
 *    plain stock photo from any CDN is progressive, so refusing it would mean
 *    the plate shows nothing for typical input.
 *
 * Reference: ITU-T T.81.
 */

export type Decoded = {
  width: number
  height: number
  /** packed RGB, 3 bytes per pixel, row-major */
  data: Uint8Array
}

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
])

type Component = {
  id: number
  /** horizontal sampling factor */
  h: number
  /** vertical sampling factor */
  v: number
  quantTable: number
  /** de-zigzagged coefficients, blocksAcross * blocksDown blocks of 64 */
  coeffs: Int32Array
  blocksAcross: number
  blocksDown: number
  dcPredictor: number
  plane: Uint8Array
  planeWidth: number
  planeHeight: number
}

type Frame = {
  height: number
  width: number
  progressive: boolean
  components: Component[]
  maxH: number
  maxV: number
  mcusAcross: number
  mcusDown: number
}

type Huffman = {
  minCode: Int32Array
  maxCode: Int32Array
  valPtr: Int32Array
  values: Uint8Array
}

export function isJpeg(buf: Buffer): boolean {
  return buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
}

let lastFailure = ''

function fail(reason: string): null {
  lastFailure = reason
  return null
}

/** Why the last decode returned null. Useful when a preview comes out blank. */
export function jpegFailureReason(): string {
  return lastFailure
}

export function decodeJpeg(buf: Buffer): Decoded | null {
  if (!isJpeg(buf)) return null

  const quantTables: (Int32Array | undefined)[] = []
  const dcTables: (Huffman | undefined)[] = []
  const acTables: (Huffman | undefined)[] = []
  let frame: Frame | null = null
  let restartInterval = 0

  let pos = 2
  while (pos < buf.length - 1) {
    if (buf[pos] !== 0xff) {
      pos++
      continue
    }
    const marker = buf[pos + 1] as number
    if (marker === 0xff) {
      pos++
      continue
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      pos += 2
      continue
    }
    if (marker === 0xd9) break

    if (pos + 3 >= buf.length) return null
    const length = ((buf[pos + 2] as number) << 8) | (buf[pos + 3] as number)
    const bodyStart = pos + 4
    const bodyEnd = pos + 2 + length
    if (bodyEnd > buf.length) return null

    switch (marker) {
      case 0xdb: {
        let p = bodyStart
        while (p < bodyEnd) {
          const spec = buf[p] as number
          const precision = spec >> 4
          const id = spec & 15
          const table = new Int32Array(64)
          p += 1
          for (let i = 0; i < 64; i++) {
            // DQT values arrive zig-zagged; coefficients are de-zigzagged before
            // lookup, so the table has to be stored in raster order. Skipping
            // this scrambles every real image.
            const target = ZIGZAG[i] as number
            if (precision === 0) {
              table[target] = buf[p] as number
              p += 1
            } else {
              table[target] = ((buf[p] as number) << 8) | (buf[p + 1] as number)
              p += 2
            }
          }
          quantTables[id] = table
        }
        break
      }

      case 0xc0:
      case 0xc1:
      case 0xc2: {
        const precision = buf[bodyStart] as number
        if (precision !== 8) return null
        const height = ((buf[bodyStart + 1] as number) << 8) | (buf[bodyStart + 2] as number)
        const width = ((buf[bodyStart + 3] as number) << 8) | (buf[bodyStart + 4] as number)
        const count = buf[bodyStart + 5] as number
        if (width <= 0 || height <= 0 || count < 1 || count > 4) return null
        const components: Component[] = []
        for (let i = 0; i < count; i++) {
          const o = bodyStart + 6 + i * 3
          const h = (buf[o + 1] as number) >> 4
          const v = (buf[o + 1] as number) & 15
          if (h < 1 || h > 4 || v < 1 || v > 4) return null
          components.push({
            id: buf[o] as number,
            h,
            v,
            quantTable: buf[o + 2] as number,
            coeffs: new Int32Array(0),
            blocksAcross: 0,
            blocksDown: 0,
            dcPredictor: 0,
            plane: new Uint8Array(0),
            planeWidth: 0,
            planeHeight: 0,
          })
        }
        frame = {
          height,
          width,
          progressive: marker === 0xc2,
          components,
          maxH: Math.max(...components.map(c => c.h)),
          maxV: Math.max(...components.map(c => c.v)),
          mcusAcross: 0,
          mcusDown: 0,
        }
        frame.mcusAcross = Math.ceil(width / (8 * frame.maxH))
        frame.mcusDown = Math.ceil(height / (8 * frame.maxV))
        for (const c of components) {
          c.blocksAcross = frame.mcusAcross * c.h
          c.blocksDown = frame.mcusDown * c.v
          c.coeffs = new Int32Array(c.blocksAcross * c.blocksDown * 64)
          c.planeWidth = c.blocksAcross * 8
          c.planeHeight = c.blocksDown * 8
          c.plane = new Uint8Array(c.planeWidth * c.planeHeight)
        }
        break
      }

      case 0xc3:
      case 0xc5:
      case 0xc6:
      case 0xc7:
      case 0xc9:
      case 0xca:
      case 0xcb:
      case 0xcd:
      case 0xce:
      case 0xcf:
        // lossless, arithmetic, hierarchical, differential — none supported
        return null

      case 0xc4: {
        let p = bodyStart
        while (p < bodyEnd) {
          const spec = buf[p] as number
          const tableClass = spec >> 4
          const id = spec & 15
          const bits = new Uint8Array(16)
          let total = 0
          for (let i = 0; i < 16; i++) {
            bits[i] = buf[p + 1 + i] as number
            total += bits[i] as number
          }
          if (p + 17 + total > bodyEnd) return null
          const values = new Uint8Array(total)
          for (let i = 0; i < total; i++) values[i] = buf[p + 17 + i] as number
          const table = buildHuffman(bits, values)
          if (tableClass === 0) dcTables[id] = table
          else acTables[id] = table
          p += 17 + total
        }
        break
      }

      case 0xdd:
        restartInterval = ((buf[bodyStart] as number) << 8) | (buf[bodyStart + 1] as number)
        break

      case 0xda: {
        if (!frame) return fail('scan before frame header')
        if (!readScan(buf, bodyStart, frame, quantTables, dcTables, acTables, restartInterval)) {
          return fail(`scan at ${pos} Ss=${buf[bodyStart + 1 + (buf[bodyStart] as number) * 2]} rejected`)
        }
        pos = findNextMarker(buf, bodyEnd)
        continue
      }

      default:
        break
    }

    pos = bodyEnd
  }

  if (!frame) return fail('no frame header')
  return render(frame, quantTables)
}

/* ------------------------------------------------------------------ *
 * Huffman
 * ------------------------------------------------------------------ */

function buildHuffman(bits: Uint8Array, values: Uint8Array): Huffman {
  const minCode = new Int32Array(17).fill(-1)
  const maxCode = new Int32Array(17).fill(-1)
  const valPtr = new Int32Array(17)
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    const count = bits[length - 1] as number
    if (count > 0) {
      valPtr[length] = k
      minCode[length] = code
      code += count
      k += count
      maxCode[length] = code - 1
    } else {
      maxCode[length] = -1
    }
    code <<= 1
  }
  return {minCode, maxCode, valPtr, values}
}

/* ------------------------------------------------------------------ *
 * Bit reader
 * ------------------------------------------------------------------ */

class Bits {
  pos: number
  private buffer = 0
  private count = 0
  /** set when the entropy-coded data ran out */
  exhausted = false

  constructor(private readonly buf: Buffer, start: number) {
    this.pos = start
  }

  /** One bit, MSB first, unstuffing 0xFF00 and stopping at a real marker. */
  bit(): number {
    if (this.count === 0) {
      if (this.pos >= this.buf.length) {
        this.exhausted = true
        return 0
      }
      let byte = this.buf[this.pos] as number
      this.pos++
      if (byte === 0xff) {
        const next = this.buf[this.pos]
        if (next === 0x00) {
          this.pos++
        } else if (next !== undefined && next >= 0xd0 && next <= 0xd7) {
          // restart marker: consumed by the caller, which resets state there
          this.pos++
        } else {
          this.exhausted = true
          return 0
        }
        // the stuffed 0x00 was consumed; the real byte is the one before it
        byte = next === 0x00 ? (this.buf[this.pos - 2] as number) : (next as number)
      }
      this.buffer = byte
      this.count = 8
    }
    this.count--
    return (this.buffer >> this.count) & 1
  }

  /** Raw n bits. */
  receive(n: number): number {
    let value = 0
    for (let i = 0; i < n; i++) value = (value << 1) | this.bit()
    return value
  }

  /** n bits, sign-extended — the T.81 EXTEND operation. */
  extend(n: number): number {
    if (n === 0) return 0
    const value = this.receive(n)
    return value < 1 << (n - 1) ? value - (1 << n) + 1 : value
  }

  decode(table: Huffman): number {
    let code = this.bit()
    let length = 1
    while (length <= 16) {
      const max = table.maxCode[length] as number
      if (max >= 0 && code <= max) {
        return table.values[(table.valPtr[length] as number) + code - (table.minCode[length] as number)] ?? 0
      }
      code = (code << 1) | this.bit()
      length++
    }
    this.exhausted = true
    return 0
  }

  /** Restart markers must start on a byte boundary. */
  align(): void {
    this.count = 0
  }
}

function findNextMarker(buf: Buffer, from: number): number {
  for (let p = from; p < buf.length - 1; p++) {
    if (buf[p] === 0xff) {
      const marker = buf[p + 1] as number
      if (marker !== 0xff && marker !== 0x00) return p
    }
  }
  return buf.length
}

/* ------------------------------------------------------------------ *
 * One scan
 * ------------------------------------------------------------------ */

/**
 * Decode a single SOS segment into the components' coefficient arrays.
 *
 * Baseline is progressive with Ss=0, Se=63, Ah=Al=0, so both styles share this
 * path. The differences are which band of the spectrum the scan covers (Ss..Se)
 * and whether the coefficients are refined in place (Ah>0).
 */
function readScan(
  buf: Buffer,
  bodyStart: number,
  frame: Frame,
  quantTables: (Int32Array | undefined)[],
  dcTables: (Huffman | undefined)[],
  acTables: (Huffman | undefined)[],
  restartInterval: number,
): boolean {
  const selectorCount = buf[bodyStart] as number
  if (selectorCount < 1) return false

  /*
   * Scan header after the selector table: Ss, Se, Ah/Al. Three more bytes
   * before the entropy-coded data. Forgetting them reads the header as
   * coefficients and produces plausible-looking noise rather than an error.
   *
   * Parsed before the selector loop on purpose: which tables a scan actually
   * needs depends on the band it covers. A DC-only progressive scan (Se === 0)
   * names AC table 0 but never defines it, because no AC coefficient is ever
   * read. Requiring it anyway rejected most progressive files outright.
   */
  const headerEnd = bodyStart + 1 + selectorCount * 2 + 3
  if (headerEnd > buf.length) return false
  const ss = buf[bodyStart + 1 + selectorCount * 2] as number
  const se = buf[bodyStart + 2 + selectorCount * 2] as number
  const ahal = buf[bodyStart + 3 + selectorCount * 2] as number
  const ah = ahal >> 4
  const al = ahal & 15
  if (ss > 63 || se > 63 || ss > se) return false
  const needsAc = se > 0
  // A DC refinement scan carries one raw bit per block and uses no table at all.
  const needsDcTable = ss === 0 && ah === 0

  const scan: {component: Component; dc?: Huffman; ac?: Huffman; quant: Int32Array}[] = []
  for (let i = 0; i < selectorCount; i++) {
    const o = bodyStart + 1 + i * 2
    if (o + 1 >= buf.length) return false
    const id = buf[o] as number
    const tables = buf[o + 1] as number
    const component = frame.components.find(c => c.id === id)
    const quant = quantTables[component?.quantTable ?? -1]
    if (!component || !quant) return false
    const dc = needsDcTable ? dcTables[tables >> 4] : undefined
    const ac = needsAc ? acTables[tables & 15] : undefined
    if (needsDcTable && !dc) return false
    if (needsAc && !ac) return false
    scan.push({component, dc, ac, quant})
  }

  const bits = new Bits(buf, headerEnd)
  let eobrun = 0
  let mcu = 0

  for (let my = 0; my < frame.mcusDown; my++) {
    for (let mx = 0; mx < frame.mcusAcross; mx++) {
      if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
        bits.align()
        for (const entry of scan) entry.component.dcPredictor = 0
        eobrun = 0
        // step over the RSTn marker itself
        while (bits.pos + 1 < buf.length) {
          if (buf[bits.pos] === 0xff) {
            const m = buf[bits.pos + 1] as number
            if (m >= 0xd0 && m <= 0xd7) {
              bits.pos += 2
              break
            }
          }
          bits.pos++
        }
      }

      for (const entry of scan) {
        const {component} = entry
        for (let by = 0; by < component.v; by++) {
          for (let bx = 0; bx < component.h; bx++) {
            const blockIndex = (my * component.v + by) * component.blocksAcross + (mx * component.h + bx)
            const base = blockIndex * 64
            const coeffs = component.coeffs

            if (ss === 0) {
              decodeDcScan(bits, entry.dc, component, coeffs, base, al, ah > 0)
            }

            if (se > 0 && entry.ac) {
              const from = ss === 0 ? 1 : ss
              decodeAcScan(bits, entry.ac, coeffs, base, from, se, ah, al, () => eobrun, v => (eobrun = v))
              /*
               * Running into a marker means the bit reader lost sync. Stop here
               * rather than write noise into every remaining block; the image
               * is degraded but the parts already decoded stay correct.
               */
              if (bits.exhausted) return true
            }
          }
        }
      }

      mcu++
    }
  }

  return true
}

/**
 * DC coefficient for one block.
 *
 * The running predictor holds the *unshifted* value; each scan writes the
 * shifted, quantized coefficient into `coeffs`. Successive approximation then
 * sets one more bit plane at a time, which is why refinement reads back from
 * `coeffs` and not from the predictor.
 */
/**
 * DC coefficient for one block.
 *
 * The two passes are encoded completely differently, and getting that wrong is
 * invisible until you measure: the first pass is Huffman coded, the refinement
 * pass is **a single raw bit per block**. No table, no size symbol.
 *
 * That asymmetry is also the only way to read a real progressive file: its DC
 * refinement scan is exactly one bit per block, so for a 200x200 4:2:0 frame it
 * is ~127 bytes of data and needs no DHT of its own. Decoding it with the
 * first-pass table instead desynchronises on the first block and every
 * refinement scan thereafter is noise.
 */
function decodeDcScan(
  bits: Bits,
  table: Huffman | undefined,
  component: Component,
  coeffs: Int32Array,
  base: number,
  al: number,
  refine: boolean,
): void {
  if (refine) {
    if (bits.bit() === 1) coeffs[base] = (coeffs[base] as number) | (1 << al)
    return
  }

  const symbol = bits.decode(table as Huffman)
  component.dcPredictor += bits.extend(symbol)
  coeffs[base] = component.dcPredictor << al
}

/**
 * AC coefficients for one block, following T.81 figure G.7.
 *
 * Two things about this are easy to get wrong and both corrupt the image in ways
 * that still look like a picture:
 *
 *  - The end-of-band run is *consumed on entry*, one block at a time
 *    (`EOBRUN--` before the loop), and the run and the symbol stream are
 *    alternatives, not two passes over the same band. Treating them as
 *    sequential steps desynchronises the bit reader from the first refinement
 *    pass onward, which shows up as horizontal banding across the whole frame.
 *
 *  - Coefficients stay *quantized* throughout. The quantization table is applied
 *    once, in the IDCT stage, because later scans refine those same quantized
 *    values. Folding it in per scan double-scales every refined coefficient.
 *
 * `getEob`/`setEob` share one run counter across every block in the scan, which
 * is what makes a run span blocks in the first place.
 */
function decodeAcScan(
  bits: Bits,
  table: Huffman,
  coeffs: Int32Array,
  base: number,
  ss: number,
  se: number,
  ah: number,
  al: number,
  getEob: () => number,
  setEob: (v: number) => void,
): void {
  let eobrun = getEob()

  /* ---------------- first pass: absolute values, zig-zag order ---------- */
  if (ah === 0) {
    if (eobrun > 0) {
      // this block is entirely inside a run: nothing left zero, no bits to read
      setEob(eobrun - 1)
      return
    }
    let k = ss
    while (k <= se) {
      const rs = bits.decode(table)
      const r = rs >> 4
      const s = rs & 15
      if (s === 0) {
        if (r < 15) {
          // end of band: the next 2^r - 1 + receive(r) blocks are also zero
          setEob(bits.receive(r) + (1 << r) - 1)
          return
        }
        k += 16
        continue
      }
      k += r
      // a run that lands outside the band is an encoder error; stop rather than
      // writing a coefficient this pass is not allowed to touch
      if (k > se) return
      coeffs[base + (ZIGZAG[k] as number)] = bits.extend(s) << al
      k++
    }
    return
  }

  /* ---------------- refinement: one bit plane at a time ---------------- */
  const p1 = 1 << al
  const m1 = -1 << al

  if (eobrun > 0) {
    // this block is part of a run: only correction bits for existing non-zeros
    eobrun--
    setEob(eobrun)
    let k = ss
    while (k <= se) {
      const z = ZIGZAG[k] as number
      const current = coeffs[base + z] as number
      if (current !== 0) {
        if (bits.bit() === 1 && (current & p1) === 0) {
          coeffs[base + z] = current >= 0 ? current + p1 : current + m1
        }
      } else if (--eobrun === 0) {
        setEob(eobrun)
        break
      }
      k++
    }
    setEob(eobrun)
    return
  }

  let k = ss
  while (k <= se) {
    const rs = bits.decode(table)
    const s = rs & 15

    /* --- what this symbol says, before we walk to its position --- */
    let zeros: number
    let newValue = 0
    if (s === 0) {
      const r = rs >> 4
      if (r < 15) {
        // rest of this band is zero; the run carries into the next block
        setEob(bits.receive(r) + (1 << r) - 1)
        return
      }
      zeros = 16
    } else {
      /*
       * s > 0 in a refinement pass: the magnitude is one bit plane (p1), and
       * the sign is a single raw bit rather than a coded one. This pass *adds*
       * the coefficient if it is not already there, so the value has to be
       * carried to the position the run lands on — reading the sign and then
       * discarding it silently drops every coefficient introduced at this plane.
       */
      zeros = rs >> 4
      newValue = bits.bit() === 1 ? p1 : m1
    }

    /*
     * Walk the band. Non-zero coefficients take a correction bit; the zeros
     * this symbol skips are counted down; the position it lands on receives
     * `newValue` if there is one. One loop, because all three share a cursor.
     */
    for (; k <= se; k++) {
      const z = ZIGZAG[k] as number
      const current = coeffs[base + z] as number
      if (current !== 0) {
        if (bits.bit() === 1 && (current & p1) === 0) {
          coeffs[base + z] = current >= 0 ? current + p1 : current + m1
        }
        continue
      }
      if (zeros === 0) {
        if (newValue !== 0) coeffs[base + z] = newValue
        k++
        break
      }
      zeros--
    }
  }
}

/* ------------------------------------------------------------------ *
 * IDCT
 * ------------------------------------------------------------------ */

/*
 * COS[u][x] = C(u) * cos((2x+1)u*pi/16), with the DC normalisation folded in.
 *
 * The separability is the whole reason this is cheap: a 64-point 2-D transform
 * costs 4096 multiplies, two 1-D passes cost 2 * 8 * 8 * 8 = 1024.
 */
const COS = new Float64Array(64)
for (let u = 0; u < 8; u++) {
  const scale = u === 0 ? 1 / Math.SQRT2 : 1
  for (let x = 0; x < 8; x++) {
    COS[u * 8 + x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / 16)
  }
}

const rowScratch = new Float64Array(64)
const blockPixels = new Uint8Array(64)

/**
 * Dequantize and inverse-transform one block: level shift and clamp included.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 *  - The total normalisation is 1/4, split as 1/2 per pass because the sum in
 *    one dimension is zero for every frequency but DC. Dividing by 4 in *each*
 *    pass normalises by 16 and renders every image four times too dark — which
 *    looks like a plausible washed-out photo rather than an error.
 *
 *  - Dequantization happens here, once. T.81 hands over *quantized* coefficients
 *    and successive-approximation passes refine those, so folding the quantizer
 *    into the scan loop double-scales every refined block.
 *
 * The first pass reduces the horizontal frequencies, and it has to read the
 * coefficient row belonging to the vertical frequency it is working on. Reading
 * `coeffs[base + u]` for every row instead — which is an easy slip, since the
 * index looks complete — transforms all eight rows from the first one, and
 * shows up as horizontal banding across every image, strongest where vertical
 * detail should be. A block with only a DC term must come out perfectly flat;
 * that check catches it immediately.
 *
 * Sanity check: a dequantized DC of D must come out as a flat D/8 + 128.
 */
function idct(coeffs: Int32Array, base: number, quant: Int32Array, out: Uint8Array): void {
  // horizontal frequencies: A(x, v) = sum_u C(u) * F(u, v) * cos((2x+1)u*pi/16)
  for (let v = 0; v < 8; v++) {
    const row = base + v * 8
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) {
        const c = (coeffs[row + u] as number) * (quant[row + u - base] as number)
        if (c !== 0) sum += c * (COS[u * 8 + x] as number)
      }
      rowScratch[v * 8 + x] = sum / 2
    }
  }
  // vertical frequencies, and back to spatial order
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let v = 0; v < 8; v++) {
        const t = rowScratch[v * 8 + x] as number
        if (t !== 0) sum += t * (COS[v * 8 + y] as number)
      }
      const value = Math.round(sum / 2) + 128
      out[y * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
}

/* ------------------------------------------------------------------ *
 * Colour
 * ------------------------------------------------------------------ */

function render(frame: Frame, quantTables: (Int32Array | undefined)[]): Decoded | null {
  const {width, height, components, maxH, maxV} = frame

  for (const component of components) {
    const quant = quantTables[component.quantTable]
    if (!quant) return fail(`component ${component.id} references undefined quant table ${component.quantTable}`)
    const {blocksAcross, blocksDown, coeffs, plane, planeWidth} = component
    for (let by = 0; by < blocksDown; by++) {
      for (let bx = 0; bx < blocksAcross; bx++) {
        const base = (by * blocksAcross + bx) * 64
        idct(coeffs, base, quant, blockPixels)
        const originX = bx * 8
        const originY = by * 8
        for (let row = 0; row < 8; row++) {
          const from = row * 8
          const to = (originY + row) * planeWidth + originX
          for (let col = 0; col < 8; col++) {
            plane[to + col] = blockPixels[from + col] as number
          }
        }
      }
    }
  }

  const data = new Uint8Array(width * height * 3)
  const c0 = components[0]
  const c1 = components[1]
  const c2 = components[2]
  if (!c0) return {width, height, data}

  if (components.length === 1 || !c1 || !c2) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const value = sample(c0, x, y, maxH, maxV)
        const o = (y * width + x) * 3
        data[o] = value
        data[o + 1] = value
        data[o + 2] = value
      }
    }
    return {width, height, data}
  }

  /*
   * YCbCr with nearest-neighbour chroma upsampling. At thumbnail sizes the
   * difference is not visible, and a proper resampler would cost more code than
   * the plate can use.
   *
   * The constants belong to the *difference* channels, and pairing them up wrong
   * is silent: Cb drives blue at 1.772 while Cr drives red at 1.402. Swapping
   * them still yields a plausible-looking image in the right ballpark, so only a
   * colour photograph catches it — a greyscale fixture decodes perfectly.
   */
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const yValue = sample(c0, x, y, maxH, maxV)
      const cb = sample(c1, x, y, maxH, maxV) - 128
      const cr = sample(c2, x, y, maxH, maxV) - 128
      const o = (y * width + x) * 3
      const r = yValue + 1.402 * cr
      const g = yValue - 0.344136 * cb - 0.714136 * cr
      const b = yValue + 1.772 * cb
      data[o] = r < 0 ? 0 : r > 255 ? 255 : Math.round(r)
      data[o + 1] = g < 0 ? 0 : g > 255 ? 255 : Math.round(g)
      data[o + 2] = b < 0 ? 0 : b > 255 ? 255 : Math.round(b)
    }
  }

  return {width, height, data}
}

function sample(c: Component, x: number, y: number, maxH: number, maxV: number): number {
  const sx = Math.min(c.planeWidth - 1, Math.floor((x * c.h) / maxH))
  const sy = Math.min(c.planeHeight - 1, Math.floor((y * c.v) / maxV))
  return c.plane[sy * c.planeWidth + sx] ?? 0
}