/**
 * A progressive JPEG writer, for testing the decoder.
 *
 * Built from literal, hand-checked values: no forward DCT, a quantizer of all
 * ones, coefficients supplied directly. So the coefficients that go in are the
 * coefficients that must come out, and a decoder fault shows up as one wrong
 * number rather than a vague resemblance.
 *
 * Progressive needs this because it cannot be checked against a synthetic
 * baseline file — and progressive is what every current encoder emits.
 *
 * Nothing in the app imports this; it exists for the tests.
 */

/* ---- Annex K Huffman tables ------------------------------------------ */

export const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
export const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

/*
 * A complete AC table: every symbol value from 0x00 to 0xff is representable,
 * with 128 codes of eight bits and 128 of nine. That is a valid prefix code, and
 * it means the fixture can spell anything the format allows.
 *
 * The Annex K table cannot do this job. It has no 0x10 and no 0x20, so it
 * cannot express an end-of-band run longer than one block at all — which is
 * exactly the case the multi-block tests exist to cover. Real encoders ship
 * optimised tables that do include them, which is why a photograph's AC scan
 * can be a couple of bits per block.
 */
export const AC_BITS = [0, 0, 0, 0, 0, 0, 0, 128, 128, 0, 0, 0, 0, 0, 0, 0]
export const AC_VALUES = Array.from({length: 256}, (_, i) => i)

/** Canonical Huffman codes from a BITS/VALUES pair. */
function codesFor(bits: number[], values: number[]): Map<number, {code: number; length: number}> {
  const map = new Map<number, {code: number; length: number}>()
  let code = 0
  let k = 0
  for (let length = 1; length <= 16; length++) {
    for (let i = 0; i < (bits[length - 1] as number); i++) {
      map.set(values[k] as number, {code, length})
      k++
      code++
    }
    code <<= 1
  }
  return map
}

export const DC_CODES = codesFor(DC_BITS, DC_VALUES)
export const AC_CODES = codesFor(AC_BITS, AC_VALUES)

/** Bit writer with the 0xFF byte stuffing entropy-coded data requires. */
export class BitWriter {
  private out: number[] = []
  private acc = 0
  private count = 0

  put(code: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bit((code >> i) & 1)
  }

  bit(value: number): void {
    this.acc = (this.acc << 1) | (value & 1)
    this.count++
    if (this.count === 8) {
      this.out.push(this.acc)
      if (this.acc === 0xff) this.out.push(0x00)
      this.acc = 0
      this.count = 0
    }
  }

  finish(): Buffer {
    while (this.count !== 0) this.bit(1)
    return Buffer.from(this.out)
  }
}

export const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]

export function zigzag(k: number): number {
  return ZIGZAG[k] as number
}

export function marker(code: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, code])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(body.length + 2)
  return Buffer.concat([head, length, body])
}

export type Scan = {ss: number; se: number; ah: number; al: number}
export type ComponentSpec = {id: number; h: number; v: number}

export class Needs {
  constructor(readonly message: string) {}
}

/** Throws with a readable reason when the fixture asks for something impossible. */
function require<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Needs(`${what} is not in the table`)
  return value
}

/**
 * Emit an end-of-band symbol that makes the decoder skip `skip` following
 * blocks. Zero is a perfectly good value: it terminates the current block's band
 * without skipping anything, which is what a block with trailing zeros needs.
 *
 * The decoder sets its run counter to `receive(r) + 2^r - 1` and then spends one
 * per skipped block, so the counter has to start at `skip`. Solving
 * `receive(r) = skip + 1 - 2^r` with the result in [0, 2^r) gives
 * `r = floor(log2(skip + 1))`.
 */
function emitRun(w: BitWriter, skip: number): void {
  if (skip < 0) throw new Needs(`cannot spell a run of ${skip}`)
  let r = 0
  while (1 << (r + 1) <= skip + 1) r++
  const extra = skip + 1 - (1 << r)
  if (extra < 0 || extra >= 1 << r) throw new Needs(`cannot spell a run of ${skip}`)
  // the symbol is (R, S) with S = 0, so the run length lives in the high nibble
  const symbol = r << 4
  const code = require(AC_CODES.get(symbol), `ac eob symbol 0x${symbol.toString(16)} for r=${r}`)
  w.put(code.code, code.length)
  if (r > 0) w.put(extra, r)
}

export type Frame = {
  width: number
  height: number
  components: ComponentSpec[]
  /** component id -> flat coefficients, blocksAcross * blocksDown * 64 */
  coeffs: Map<number, Int32Array>
  scans: Scan[]
}

/**
 * Write a progressive JPEG for an arbitrary frame.
 *
 * Handles multiple components, sampling factors, many blocks per MCU, and
 * end-of-band runs that span blocks — the dimensions a one-block fixture cannot
 * reach, and the ones a real encoder exercises constantly.
 */
export function writeProgressiveFrame(frame: Frame): Buffer {
  const {width, height, components, coeffs, scans} = frame
  const maxH = Math.max(...components.map(c => c.h))
  const maxV = Math.max(...components.map(c => c.v))
  const mcusAcross = Math.ceil(width / (8 * maxH))
  const mcusDown = Math.ceil(height / (8 * maxV))

  const geometry = new Map<number, {blocksAcross: number; blocksDown: number}>()
  for (const c of components) {
    geometry.set(c.id, {
      blocksAcross: mcusAcross * c.h,
      blocksDown: mcusDown * c.v,
    })
  }

  const sof: number[] = [0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, components.length]
  for (const c of components) sof.push(c.id, (c.h << 4) | c.v, 0x00)

  const parts: Buffer[] = [
    Buffer.from([0xff, 0xd8]),
    marker(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    marker(0xc2, Buffer.from(sof)),
    marker(0xc4, Buffer.from([0x00, ...DC_BITS, ...DC_VALUES])),
    marker(0xc4, Buffer.from([0x10, ...AC_BITS, ...AC_VALUES])),
  ]

  /** every block of a component, in MCU order — the order the spec mandates */
  const blockOrder = (id: number): number[] => {
    const spec = components.find(c => c.id === id) as ComponentSpec
    const {blocksAcross} = geometry.get(id) as {blocksAcross: number}
    const order: number[] = []
    for (let my = 0; my < mcusDown; my++) {
      for (let mx = 0; mx < mcusAcross; mx++) {
        for (let by = 0; by < spec.v; by++) {
          for (let bx = 0; bx < spec.h; bx++) {
            order.push((my * spec.v + by) * blocksAcross + (mx * spec.h + bx))
          }
        }
      }
    }
    return order
  }

  /** what earlier passes have transmitted, per component per block */
  const sent = new Map<number, Int32Array>()
  for (const c of components) {
    const g = geometry.get(c.id) as {blocksAcross: number; blocksDown: number}
    sent.set(c.id, new Int32Array(g.blocksAcross * g.blocksDown * 64))
  }

  /*
   * The finest plane transmitted so far, per component. Successive
   * approximation only ever adds resolution, so a scan claiming a coarser Al than
   * an earlier one is not a progressive file at all — it overwrites good detail
   * with worse. Real encoders never do it; a hand-written test script easily can,
   * and the result decodes to something plausible that is quietly wrong.
   */
  const finest = new Map<number, number>()
  for (const c of components) finest.set(c.id, -1)
  for (const {ss, se, ah, al} of scans) {
    if (ah !== 0 || se === 0) continue
    for (const c of components) {
      const before = finest.get(c.id) as number
      if (al < before) {
        throw new Needs(`component ${c.id}: Al=${al} is coarser than the Al=${before} already sent`)
      }
      finest.set(c.id, al)
    }
  }

  for (const {ss, se, ah, al} of scans) {
    const w = new BitWriter()
    const header: number[] = [components.length]
    for (const c of components) header.push(c.id, 0x00)
    header.push(ss, se, (ah << 4) | al)

    const band = Math.max(ss, 1)
    /** pending end-of-band runs, one per component */
    const pending = new Map<number, number>()
    for (const c of components) pending.set(c.id, 0)
    /** running DC predictor, one per component, reset by a restart interval */
    const dcLast = new Map<number, number>()
    for (const c of components) dcLast.set(c.id, 0)

    /*
     * MCU order, and within an MCU the DC of every block before any AC. A scan
     * is not two passes over the frame — it interleaves, and writing it as
     * phases produces a file no conforming decoder reads.
     */
    for (let my = 0; my < mcusDown; my++) {
      for (let mx = 0; mx < mcusAcross; mx++) {
        for (const comp of components) {
          const all = coeffs.get(comp.id) as Int32Array
          const have = sent.get(comp.id) as Int32Array
          const g = geometry.get(comp.id) as {blocksAcross: number}

          for (let by = 0; by < comp.v; by++) {
            for (let bx = 0; bx < comp.h; bx++) {
              const base = ((my * comp.v + by) * g.blocksAcross + (mx * comp.h + bx)) * 64

              if (ss === 0) {
                if (ah === 0) {
                  const value = (all[base] as number) >> al
                  const diff = value - (dcLast.get(comp.id) as number)
                  dcLast.set(comp.id, value)
                  const size = diff === 0 ? 0 : 32 - Math.clz32(Math.abs(diff))
                  const code = require(DC_CODES.get(size), `dc size ${size}`)
                  w.put(code.code, code.length)
                  if (size > 0) w.put(diff < 0 ? diff + (1 << size) - 1 : diff, size)
                  have[base] = value << al
                } else {
                  // DC refinement: one raw bit per block, no table involved
                  w.bit(((all[base] as number) >> al) & 1)
                  have[base] = all[base] as number
                }
              }

              if (se === 0) continue

              if (ah === 0) {
                /*
                 * AC first pass.
                 *
                 * A symbol's run counts the zeros before the coefficient it
                 * introduces. Blocks with nothing to say spend no bits at all,
                 * so they are covered by an end-of-band run — and that run has
                 * to be written *before* this block's own coefficients, because
                 * the decoder is still parked on the first empty block and
                 * pulls the run from there.
                 */
                const entries: {k: number; index: number; shifted: number}[] = []
                for (let k = band; k <= se; k++) {
                  const index = zigzag(k)
                  const shifted = (all[base + index] as number) >> al
                  // nothing to say for a coefficient this plane cannot carry
                  if (shifted !== 0) entries.push({k, index, shifted})
                }

                if (entries.length === 0) {
                  pending.set(comp.id, (pending.get(comp.id) as number) + 1)
                  continue
                }

                /*
                 * The run skips the empty blocks *after* the one whose band the
                 * decoder is reading when it pulls the symbol, so a run of m
                 * empty blocks is spelled as m - 1.
                 */
                const run = pending.get(comp.id) as number
                if (run >= 1) emitRun(w, run - 1)
                pending.set(comp.id, 0)

                let previous = band - 1
                for (const {k, index, shifted} of entries) {
                  const magnitude = Math.abs(shifted)
                  const size = 32 - Math.clz32(magnitude)
                  let zeros = k - previous - 1
                  const zrl = require(AC_CODES.get(0xf0), 'zrl')
                  for (; zeros >= 16; zeros -= 16) w.put(zrl.code, zrl.length)
                  const symbol = (zeros << 4) | size
                  const code = require(AC_CODES.get(symbol), `ac symbol 0x${symbol.toString(16)}`)
                  w.put(code.code, code.length)
                  w.put(shifted < 0 ? shifted + (1 << size) - 1 : shifted, size)
                  have[base + index] = shifted << al
                  previous = k
                }

                const last = entries[entries.length - 1] as {k: number}
                /*
                 * Then this block's band has to be terminated. Without a trailing
                 * end-of-band symbol the decoder, still inside `while (k <= se)`,
                 * reads the next block's bits as if they were this block's —
                 * which hands every following block's coefficients to the wrong
                 * place.
                 */
                if (last.k < se) emitRun(w, 0)
              } else {
                /*
                 * AC refinement. The decoder reads a symbol, then walks the band
                 * from where it left off: coefficients that already hold a value
                 * take a correction bit, the symbol's run counts the zeros among
                 * them, and the new coefficient goes where the run ends. The
                 * symbol comes first.
                 *
                 * Correction bits are only ever read inside a walk, so a block
                 * with nothing to introduce cannot be spelled — the fixture
                 * keeps every refinement block non-trivial.
                 */
                const p1 = 1 << al
                const introduces = (k: number): boolean =>
                  (have[base + zigzag(k)] as number) === 0 && (((all[base + zigzag(k)] as number) >> al) & 1) !== 0

                let cursor = band
                while (cursor <= se) {
                  let target = cursor
                  while (target <= se && !introduces(target)) target++
                  if (target > se) break

                  let zeros = 0
                  for (let k = cursor; k < target; k++) if (have[base + zigzag(k)] === 0) zeros++
                  if (zeros >= 16) throw new Needs('fixture keeps every refinement run inside one symbol')

                  const symbol = (zeros << 4) | 0x01
                  const code = require(AC_CODES.get(symbol), `refine symbol 0x${symbol.toString(16)}`)
                  w.put(code.code, code.length)
                  const sign = (all[base + zigzag(target)] as number) >= 0 ? 1 : 0
                  w.bit(sign)

                  for (let k = cursor; k < target; k++) {
                    const index = zigzag(k)
                    if (have[base + index] === 0) continue
                    const want = ((all[base + index] as number) >> al) & 1
                    const can = ((have[base + index] as number) & p1) === 0
                    w.bit(want && can ? 1 : 0)
                    have[base + index] = (have[base + index] as number) + (want && can ? p1 : 0)
                  }
                  have[base + zigzag(target)] = sign ? p1 : -p1
                  cursor = target + 1
                }
                emitRun(w, 0)
              }
            }
          }
        }
      }
    }

    for (const c of components) {
      const run = pending.get(c.id) as number
      if (run >= 1) emitRun(w, run - 1)
    }
    parts.push(marker(0xda, Buffer.from(header)), w.finish())
  }

  parts.push(Buffer.from([0xff, 0xd9]))
  return Buffer.concat(parts)
}

/**
 * An inverse DCT written straight from the definition rather than shared with
 * the decoder — sharing it would let one mistake pass twice.
 */
export function referenceIdct(coeffs: Int32Array): Uint8Array {
  const C = (u: number): number => (u === 0 ? 1 / Math.SQRT2 : 1)
  const out = new Uint8Array(64)
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
          const c = coeffs[v * 8 + u] as number
          if (c === 0) continue
          sum +=
            c *
            C(u) *
            Math.cos(((2 * x + 1) * u * Math.PI) / 16) *
            C(v) *
            Math.cos(((2 * y + 1) * v * Math.PI) / 16)
        }
      }
      const value = Math.round(sum / 4) + 128
      out[y * 8 + x] = value < 0 ? 0 : value > 255 ? 255 : value
    }
  }
  return out
}
