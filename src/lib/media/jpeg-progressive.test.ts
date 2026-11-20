import assert from 'node:assert/strict'
import test from 'node:test'
import {decodeJpeg, jpegFailureReason} from './jpeg.js'

/**
 * A progressive JPEG writer, just enough of one to pin down the decoder.
 *
 * Built from literal, hand-checked values: no forward DCT, one 8x8 block, one
 * component, a quantizer of all ones. So the coefficients that go in are the
 * coefficients that must come out, and a decoder fault shows up as one wrong
 * number rather than a vague resemblance.
 *
 * Progressive needs this because it cannot be checked against a synthetic
 * baseline file — and progressive is what every current encoder emits.
 */

/* ---- Annex K Huffman tables ------------------------------------------ */

const DC_BITS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]

const AC_BITS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
const AC_VALUES = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14,
  0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82,
  0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38,
  0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a,
  0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
  0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4,
  0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4,
  0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3,
  0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
]

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

const DC_CODES = codesFor(DC_BITS, DC_VALUES)
const AC_CODES = codesFor(AC_BITS, AC_VALUES)

/** Bit writer with the 0xFF byte stuffing entropy-coded data requires. */
class BitWriter {
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

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47,
  55, 62, 63,
]

function zigzag(k: number): number {
  return ZIGZAG[k] as number
}

function marker(code: number, body: Buffer): Buffer {
  const head = Buffer.from([0xff, code])
  const length = Buffer.alloc(2)
  length.writeUInt16BE(body.length + 2)
  return Buffer.concat([head, length, body])
}

type Scan = {ss: number; se: number; ah: number; al: number}

/**
 * Write a one-block progressive JPEG carrying `coeffs` through `scans`.
 *
 * The caller chooses the scan script, so each kind of scan can be exercised on
 * its own: a single all-inclusive scan, DC alone, successive approximation, or
 * refinement.
 */
function writeProgressive(coeffs: Int32Array, scans: Scan[]): Buffer {
  const parts: Buffer[] = [
    Buffer.from([0xff, 0xd8]),
    marker(0xdb, Buffer.from([0x00, ...new Array(64).fill(1)])),
    marker(
      0xc2,
      Buffer.from([0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00]),
    ),
    marker(0xc4, Buffer.from([0x00, ...DC_BITS, ...DC_VALUES])),
    marker(0xc4, Buffer.from([0x10, ...AC_BITS, ...AC_VALUES])),
  ]

  /**
   * What every pass has transmitted so far, per coefficient. Successive
   * approximation means a later pass only carries the bits the earlier ones
   * could not, so the encoder needs to know the running value.
   */
  const sent = new Int32Array(64)

  for (const {ss, se, ah, al} of scans) {
    const w = new BitWriter()
    const header: number[] = [1, 0x01, 0x00, ss, se, (ah << 4) | al]

    if (ss === 0) {
      if (ah === 0) {
        // DC first pass: Huffman coded difference of the value, shifted by Al
        const diff = (coeffs[0] as number) >> al
        const size = diff === 0 ? 0 : 32 - Math.clz32(Math.abs(diff))
        const code = DC_CODES.get(size)
        assert.ok(code, `dc size ${size} must exist`)
        w.put(code.code, code.length)
        if (size > 0) w.put(diff < 0 ? diff + (1 << size) - 1 : diff, size)
        sent[0] = diff << al
      } else {
        // DC refinement: one raw bit per block, no table involved
        w.bit(((coeffs[0] as number) >> al) & 1)
        sent[0] = coeffs[0] as number
      }
    }

    if (se > 0) {
      // the DC is never carried in an AC scan, even when the scan starts at 0
      const band = Math.max(ss, 1)
      if (ah === 0) {
        /*
         * AC first pass. A symbol's run counts the zeros *before* the
         * coefficient it introduces, so the encoder tracks the previous
         * coefficient rather than scanning forward for the next one.
         */
        let previous = band - 1
        for (let k = band; k <= se; k++) {
          const index = zigzag(k)
          const shifted = (coeffs[index] as number) >> al
          /*
           * Nothing to send for a coefficient this bit plane cannot carry.
           * Emitting a symbol for it would be actively harmful: EXTEND of a
           * single zero bit is -1, not 0, so the decoder would plant a
           * coefficient the encoder never meant to transmit.
           */
          if (shifted === 0) continue

          const magnitude = Math.abs(shifted)
          const size = 32 - Math.clz32(magnitude)
          let run = k - previous - 1

          const zrl = AC_CODES.get(0xf0)
          assert.ok(zrl, 'zrl must exist')
          for (; run >= 16; run -= 16) w.put(zrl.code, zrl.length)

          const code = AC_CODES.get((run << 4) | size)
          assert.ok(code, `ac symbol 0x${((run << 4) | size).toString(16)} must exist`)
          w.put(code.code, code.length)
          w.put(shifted < 0 ? shifted + (1 << size) - 1 : shifted, size)
          sent[index] = shifted << al
          previous = k
        }
        const eob = AC_CODES.get(0x00)
        assert.ok(eob)
        w.put(eob.code, eob.length)
      } else {
        /*
         * AC refinement.
         *
         * The decoder reads a symbol, then walks the band from where it left
         * off: every coefficient that already holds a value takes a correction
         * bit, the symbol's run counts the zeros among them, and the new
         * coefficient goes where the run ends. So the symbol comes *first*, and
         * the correction bits follow inside that same span — emitting them
         * before the symbol desynchronises on the first block.
         */
        const p1 = 1 << al
        const held = (index: number): number => sent[index] as number
        /** this plane introduces a coefficient that earlier passes left at zero */
        const introduces = (k: number): boolean =>
          held(zigzag(k)) === 0 && (((coeffs[zigzag(k)] as number) >> al) & 1) !== 0

        let cursor = band
        while (cursor <= se) {
          let target = cursor
          while (target <= se && !introduces(target)) target++
          if (target > se) break

          let zeros = 0
          for (let k = cursor; k < target; k++) if (held(zigzag(k)) === 0) zeros++
          assert.ok(zeros < 16, 'the fixture keeps every refinement run inside one symbol')

          const code = AC_CODES.get((zeros << 4) | 0x01)
          assert.ok(code, `refine symbol 0x${((zeros << 4) | 0x01).toString(16)} must exist`)
          w.put(code.code, code.length)
          const sign = (coeffs[zigzag(target)] as number) >= 0 ? 1 : 0
          w.bit(sign)

          for (let k = cursor; k < target; k++) {
            const index = zigzag(k)
            if (held(index) === 0) continue
            const want = ((coeffs[index] as number) >> al) & 1
            const can = (held(index) & p1) === 0
            w.bit(want && can ? 1 : 0)
            sent[index] = held(index) + (want && can ? p1 : 0)
          }
          sent[zigzag(target)] = sign ? p1 : -p1
          cursor = target + 1
        }
        const eob = AC_CODES.get(0x00)
        assert.ok(eob)
        w.put(eob.code, eob.length)
      }
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
function referenceIdct(coeffs: Int32Array): Uint8Array {
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

function decodeFailure(): string {
  return `decode failed: ${jpegFailureReason() || 'unknown'}`
}

/**
 * A coefficient set for the first-pass tests: values of both parities, spread
 * across the zigzag order so the run-length logic is exercised.
 */
function sampleCoefficients(): Int32Array {
  const c = new Int32Array(64)
  c[0] = 20
  c[1] = 14
  c[8] = 6
  c[16] = 100
  c[2 + 3 * 8] = 3
  c[3 + 7 * 8] = 9
  return c
}

/**
 * The refinement test needs the |C| == 1 coefficient — the only kind a
 * successive-approximation pass actually *introduces* — to come last among the
 * non-zero coefficients, so every correction bit falls inside the walk that
 * follows its symbol.
 */
function refinementCoefficients(): Int32Array {
  const c = new Int32Array(64)
  c[0] = 20
  c[1] = 14
  c[8] = 6
  c[16] = 100
  c[9] = 1 // zigzag index 4: introduced by the refinement pass
  return c
}

function assertRoundTrip(coeffs: Int32Array, scans: Scan[]): void {
  const file = writeProgressive(coeffs, scans)
  const decoded = decodeJpeg(file)
  assert.ok(decoded, decodeFailure())
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 8)

  const expected = referenceIdct(coeffs)
  for (let i = 0; i < 64; i++) {
    assert.equal(
      decoded.data[i * 3],
      expected[i],
      `pixel ${i % 8},${Math.floor(i / 8)} expected ${expected[i]}, got ${decoded.data[i * 3]}`,
    )
  }
}

test('progressive: one all-inclusive scan round-trips exactly', () => {
  assertRoundTrip(sampleCoefficients(), [{ss: 0, se: 63, ah: 0, al: 0}])
})

test('progressive: a lone dc scan round-trips exactly', () => {
  const c = new Int32Array(64)
  c[0] = 37
  assertRoundTrip(c, [{ss: 0, se: 0, ah: 0, al: 0}])
})

test('progressive: dc then ac, no successive approximation', () => {
  assertRoundTrip(
    sampleCoefficients(),
    [
      {ss: 0, se: 0, ah: 0, al: 0},
      {ss: 1, se: 63, ah: 0, al: 0},
    ]
  )
})

test('progressive: dc first at Al=1 then dc refined to Al=0', () => {
  const c = new Int32Array(64)
  c[0] = 21 // odd, so the refinement bit matters
  assertRoundTrip(
    c,
    [
      {ss: 0, se: 0, ah: 0, al: 1},
      {ss: 0, se: 0, ah: 1, al: 0},
    ]
  )
})

test('progressive: ac first at Al=1 then ac refined to Al=0', () => {
  assertRoundTrip(
    refinementCoefficients(),
    [
      {ss: 0, se: 0, ah: 0, al: 0},
      {ss: 1, se: 63, ah: 0, al: 1},
      {ss: 1, se: 63, ah: 1, al: 0},
    ]
  )
})

test('progressive: the full four-scan script', () => {
  assertRoundTrip(
    refinementCoefficients(),
    [
      {ss: 0, se: 0, ah: 0, al: 1},
      {ss: 0, se: 0, ah: 1, al: 0},
      {ss: 1, se: 63, ah: 0, al: 1},
      {ss: 1, se: 63, ah: 1, al: 0},
    ]
  )
})

test('progressive: a flat grey block decodes flat', () => {
  const c = new Int32Array(64)
  c[0] = 8 // 8/8 + 128 = 129
  const decoded = decodeJpeg(writeProgressive(c, [{ss: 0, se: 0, ah: 0, al: 0}]))
  assert.ok(decoded, decodeFailure())
  for (let i = 0; i < 64; i++) assert.equal(decoded.data[i * 3], 129, `pixel ${i}`)
})
