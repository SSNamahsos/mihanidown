import assert from 'node:assert/strict'
import test from 'node:test'
import {decodeJpeg, jpegFailureReason} from './jpeg.js'
import {
  Needs,
  referenceIdct,
  writeProgressiveFrame,
  zigzag,
  type ComponentSpec,
  type Frame,
  type Scan,
} from './jpeg-fixture.js'

/**
 * The dimensions a one-block fixture cannot reach: several blocks per MCU,
 * sampling factors, interleaved multi-component scans, and end-of-band runs
 * that span blocks.
 *
 * These are the cases where a decoder looks fine on one block and drifts on a
 * real photograph, because a real photograph is 676 luma blocks and 169 of
 * everything else.
 */

const Y420: ComponentSpec[] = [
  {id: 1, h: 2, v: 2},
  {id: 2, h: 1, v: 1},
  {id: 3, h: 1, v: 1},
]
const GREY: ComponentSpec[] = [{id: 1, h: 1, v: 1}]

function fail(message: string): never {
  throw new Error(message)
}

function decodeOrFail(file: Buffer) {
  const decoded = decodeJpeg(file)
  if (!decoded) fail(`decode failed: ${jpegFailureReason() || 'unknown'}`)
  return decoded
}

/**
 * Compare our pixels against an independent IDCT of the expected luma.
 *
 * Three things this has to get right. The reference transform comes from the
 * fixture module rather than the decoder, so a mistake cannot cancel itself out.
 * For a three-component frame the decoder emits RGB, so luma has to be recovered
 * from it — the red channel is Y plus the chroma term, and comparing against that
 * measures the chroma planes instead. And that recovery only holds while no
 * channel has been clamped: at a clamp the chroma term is no longer recoverable,
 * so a saturated pixel is skipped rather than reported as a decoding error.
 */
function assertLumaMatches(
  decoded: {width: number; height: number; data: Uint8Array},
  luma: Int32Array,
): void {
  const lumaOf = (pixel: number): number | null => {
    const o = pixel * 3
    const r = decoded.data[o] as number
    const g = decoded.data[o + 1] as number
    const b = decoded.data[o + 2] as number
    if (r === 0 || r === 255 || g === 0 || g === 255 || b === 0 || b === 255) return null
    return Math.round(0.299 * r + 0.587 * g + 0.114 * b)
  }

  let compared = 0
  const blocksAcross = (decoded.width / 8) | 0
  for (let by = 0; by * 8 < decoded.height; by++) {
    for (let bx = 0; bx * 8 < decoded.width; bx++) {
      const block = by * blocksAcross + bx
      const values = new Int32Array(64)
      for (let i = 0; i < 64; i++) values[i] = luma[block * 64 + i] as number
      const expected = referenceIdct(values)
      for (let y = 0; y < 8; y++) {
        const py = by * 8 + y
        if (py >= decoded.height) continue
        for (let x = 0; x < 8; x++) {
          const px = bx * 8 + x
          if (px >= decoded.width) continue
          const got = lumaOf(py * decoded.width + px)
          if (got === null) continue
          compared++
          const want = expected[y * 8 + x] as number
          assert.ok(
            Math.abs(want - got) <= 1,
            `block ${block} pixel ${px},${py}: expected about ${want}, got ${got}`,
          )
        }
      }
    }
  }
  assert.ok(compared > 0, 'the fixture saturated every pixel, so nothing was actually checked')
}

/**
 * Four MCUs of 4:2:0: a 4x4 grid of luma blocks, 2x2 of each chroma plane.
 *
 * `fill` is called with the *zig-zag* position, not the coefficient index,
 * because that is the order every scan works in. Thinking in coefficient indices
 * here means reasoning about a band in the wrong order, which is exactly the
 * mistake this file exists to catch.
 */
function frame420(fill: (block: number, comp: number, k: number) => number, scans: Scan[]): Frame {
  const width = 32
  const height = 32
  const lumaBlocks = (width / 8) * (height / 8)
  const chromaBlocks = (width / 16) * (height / 16)
  const coeffs = new Map<number, Int32Array>()
  for (const c of Y420) {
    const count = c.h === 2 ? lumaBlocks : chromaBlocks
    const target = new Int32Array(count * 64)
    for (let b = 0; b < count; b++) {
      target[b * 64] = fill(b, c.id, 0)
      for (let k = 1; k < 64; k++) target[b * 64 + (zigzag(k) as number)] = fill(b, c.id, k)
    }
    coeffs.set(c.id, target)
  }
  return {width, height, components: Y420, coeffs, scans}
}

test('multi-block: a greyscale frame with several blocks round-trips', () => {
  const width = 32
  const height = 8
  const blocks = 4
  const coeffs = new Int32Array(blocks * 64)
  for (let b = 0; b < blocks; b++) {
    coeffs[b * 64] = 8 + b * 4
    coeffs[b * 64 + 1] = 20 - b * 3
    coeffs[b * 64 + 8] = -11 + b
  }
  const decoded = decodeOrFail(
    writeProgressiveFrame({
      width,
      height,
      components: GREY,
      coeffs: new Map([[1, coeffs]]),
      scans: [{ss: 0, se: 63, ah: 0, al: 0}],
    }),
  )
  assert.equal(decoded.width, width)
  assert.equal(decoded.height, height)
  assertLumaMatches(decoded, coeffs)
})

test('multi-block: an end-of-band run spanning several blocks round-trips', () => {
  /*
   * Blocks 1 and 2 carry nothing in the AC band, so the encoder has to spell an
   * end-of-band run across them. A decoder that gets the run length or the skip
   * wrong reads a block of the wrong place and the error cascades.
   */
  const width = 32
  const height = 8
  const blocks = 4
  const coeffs = new Int32Array(blocks * 64)
  for (const b of [0, 3]) {
    coeffs[b * 64] = 12
    coeffs[b * 64 + 2] = 30
  }
  const decoded = decodeOrFail(
    writeProgressiveFrame({
      width,
      height,
      components: GREY,
      coeffs: new Map([[1, coeffs]]),
      scans: [
        {ss: 0, se: 0, ah: 0, al: 0},
        {ss: 1, se: 63, ah: 0, al: 0},
      ],
    }),
  )
  assertLumaMatches(decoded, coeffs)
})

test('multi-block: a long run of empty blocks round-trips', () => {
  const width = 64
  const height = 8
  const blocks = 8
  const coeffs = new Int32Array(blocks * 64)
  // only the last block has AC content, so the run covers seven blocks
  coeffs[0] = 16
  coeffs[(blocks - 1) * 64] = 16
  coeffs[(blocks - 1) * 64 + 4] = 24
  const decoded = decodeOrFail(
    writeProgressiveFrame({
      width,
      height,
      components: GREY,
      coeffs: new Map([[1, coeffs]]),
      scans: [
        {ss: 0, se: 0, ah: 0, al: 0},
        {ss: 1, se: 63, ah: 0, al: 0},
      ],
    }),
  )
  assertLumaMatches(decoded, coeffs)
})

test('multi-block: 4:2:0 interleaved scans round-trip', () => {
  const frame = frame420(
    (block, comp, k) => (k === 0 ? 10 + block + comp : k % 5 === 0 ? 6 + block : 0),
    [{ss: 0, se: 63, ah: 0, al: 0}],
  )
  const decoded = decodeOrFail(writeProgressiveFrame(frame))
  assert.equal(decoded.width, 32)
  assert.equal(decoded.height, 32)
  assertLumaMatches(decoded, frame.coeffs.get(1) as Int32Array)
})

test('multi-block: a dc scan across a 4:2:0 frame round-trips', () => {
  const frame = frame420((block, comp, k) => (k === 0 ? 20 + block * 3 + comp : 0), [
    {ss: 0, se: 0, ah: 0, al: 0},
  ])
  const decoded = decodeOrFail(writeProgressiveFrame(frame))
  assertLumaMatches(decoded, frame.coeffs.get(1) as Int32Array)
})

test('multi-block: dc refinement is one raw bit per block, in mcu order', () => {
  const frame = frame420((block, comp, k) => (k === 0 ? (block % 2 === 0 ? 21 + comp : 20 + comp) : 0), [
    {ss: 0, se: 0, ah: 0, al: 1},
    {ss: 0, se: 0, ah: 1, al: 0},
  ])
  const decoded = decodeOrFail(writeProgressiveFrame(frame))
  assertLumaMatches(decoded, frame.coeffs.get(1) as Int32Array)
})

test("multi-block: the real file's scan script round-trips", () => {
  /*
   * The shape a current encoder emits for a 4:2:0 photograph: dc at Al=1, the
   * luma AC band split so no band is ever sent twice at a coarser precision,
   * then the dc refined to Al=0. Narrow bands at Al=2 are where the luma scans
   * drifted on a real file.
   *
   * The values are multiples of four because this script stops at Al=2 with no
   * AC refinement, and a coefficient that Al=2 cannot carry is genuinely lost —
   * the round-trip is only exact for values the stated precision can express.
   */
  const frame = frame420(
    (block, comp, k) => {
      if (k === 0) return 20 + 2 * (block + comp)
      if (k >= 1 && k <= 5) return (block + k + comp) % 3 === 0 ? 8 + 4 * k : 0
      if (k >= 6 && k <= 20) return (block * 3 + k) % 7 === 0 ? 12 + 4 * ((k - 6) >> 1) : 0
      return (block + k) % 11 === 0 ? 16 + 4 * ((k - 21) >> 2) : 0
    },
    [
      {ss: 0, se: 0, ah: 0, al: 1},
      {ss: 1, se: 5, ah: 0, al: 2},
      {ss: 6, se: 63, ah: 0, al: 2},
      {ss: 0, se: 0, ah: 1, al: 0},
    ],
  )
  const decoded = decodeOrFail(writeProgressiveFrame(frame))
  assertLumaMatches(decoded, frame.coeffs.get(1) as Int32Array)
})

test('multi-block: full ac successive approximation round-trips', () => {
  /*
   * Every AC coefficient first at Al=1 and then refined to Al=0, across many
   * blocks. The odd coefficient of value 1 is the point: at Al=1 it shifts to
   * nothing, so only the refinement pass can introduce it, and every earlier
   * coefficient in the band needs a correction bit on the way past.
   *
   * The band is laid out so the introduced coefficient is the last one with
   * anything in it. Correction bits are only ever read inside a walk, so a
   * coefficient trailing an end-of-band symbol cannot be spelled at all — that
   * is a property of the format, not of this fixture.
   */
  const frame = frame420(
    (block, comp, k) => {
      if (k === 0) return 18 + block + comp
      if (k === 21) return 1
      if (k >= 1 && k <= 19 && k % 2 === 1) return 20 + 2 * k
      return 0
    },
    [
      {ss: 0, se: 0, ah: 0, al: 1},
      {ss: 0, se: 0, ah: 1, al: 0},
      {ss: 1, se: 63, ah: 0, al: 1},
      {ss: 1, se: 63, ah: 1, al: 0},
    ],
  )
  const decoded = decodeOrFail(writeProgressiveFrame(frame))
  assertLumaMatches(decoded, frame.coeffs.get(1) as Int32Array)
})
