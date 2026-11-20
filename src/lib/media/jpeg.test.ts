import assert from 'node:assert/strict'
import test from 'node:test'
import {decodeJpeg, isJpeg} from './jpeg.js'
import {pixels} from './decode.js'
import {fit, renderPixels, pickRenderer} from './index.js'

/**
 * A real baseline JPEG, built here so the decoder is tested against actual
 * entropy-coded bytes rather than a fixture someone trusted.
 *
 * Grayscale 8x8, one solid DC value plus one AC coefficient, 4:4:4, no restart
 * intervals — the simplest thing a real encoder can emit that still exercises
 * markers, huffman tables, quantisation, the IDCT and colour conversion.
 */
function makeJpeg(): Buffer {
  const quant = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22,
  29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103,
  121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]

  // Standard Annex K luminance tables
  const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]
  const dcVals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
  const acBits = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d]
  const acVals = [
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07,
    0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0,
    0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49,
    0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69,
    0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7,
    0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5,
    0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8,
    0xf9, 0xfa,
  ]

  const segments: Buffer[] = [
    Buffer.from([0xff, 0xd8]), // SOI
    segment(0xff, 0xdb, Buffer.from([0x00, ...quant])), // DQT id 0
    segment(0xff, 0xc0, Buffer.from([0x08, 0x00, 0x08, 0x00, 0x08, 0x01, 0x01, 0x11, 0x00])), // SOF0 8x8, 1 comp
    segment(0xff, 0xc4, Buffer.from([0x00, ...dcBits, ...dcVals])), // DHT dc table 0
    segment(0xff, 0xc4, Buffer.from([0x10, ...acBits, ...acVals])), // DHT ac table 0
    // SOS: 1 component, dc table 0 / ac table 0, Ss=0 Se=63 Ah/Al=0
    segment(0xff, 0xda, Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])),
    encodeScan(),
    Buffer.from([0xff, 0xd9]), // EOI
  ]

  return Buffer.concat(segments)

  function segment(marker: number, code: number, body: Buffer): Buffer {
    const head = Buffer.from([marker, code])
    const length = Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 0xff])
    return Buffer.concat([head, length, body])
  }

  /**
   * One 8x8 block, mid-grey, grayscale: DC only.
   *
   * The scan is two Huffman *codes*, not two values. In the Annex K luminance
   * DC table the counts are 00 01 05 01..., so value 0 is the first 2-bit code
   * `00`. In the AC table value 0x00 (end-of-block) is the 4-bit code `1010`.
   * Writing the value 0 as a 4-bit literal encodes a different symbol entirely,
   * which decodes to plausible-looking noise rather than an error.
   */
  function encodeScan(): Buffer {
    const bits: number[] = []
    const push = (code: number, length: number) => {
      for (let i = length - 1; i >= 0; i--) bits.push((code >> i) & 1)
    }

    push(0b00, 2) // DC value 0
    push(0b1010, 4) // AC end-of-block

    while (bits.length % 8 !== 0) bits.push(1) // pad with 1s
    const bytes: number[] = []
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (bits[i + j] as number)
      bytes.push(byte)
    }
    return Buffer.from(bytes)
  }
}

test('recognises a jpeg by its SOI marker', () => {
  assert.equal(isJpeg(makeJpeg()), true)
  assert.equal(isJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47])), false)
})

test('decodes a baseline jpeg to the right dimensions', () => {
  const decoded = decodeJpeg(makeJpeg())
  assert.ok(decoded, 'a valid baseline jpeg must decode')
  assert.equal(decoded.width, 8)
  assert.equal(decoded.height, 8)
  assert.equal(decoded.data.length, 8 * 8 * 3)
})

test('a mid-grey block decodes to mid grey, not to black or noise', () => {
  const decoded = decodeJpeg(makeJpeg())
  assert.ok(decoded)
  // every pixel of a uniform grey block should land near 128
  for (let i = 0; i < decoded.data.length; i += 3) {
    const value = decoded.data[i] as number
    assert.ok(Math.abs(value - 128) <= 2, `expected ~128, got ${value} at byte ${i}`)
  }
})

test('refuses a truncated file instead of returning half an image', () => {
  const jpeg = makeJpeg()
  assert.equal(decodeJpeg(jpeg.subarray(0, jpeg.length - 4)), null)
})

test('refuses a frame style it cannot read', () => {
  // SOF9 is arithmetic-coded; there is no half-right answer, so decline
  const jpeg = makeJpeg()
  const sof0 = jpeg.indexOf(Buffer.from([0xff, 0xc0]))
  jpeg[sof0 + 1] = 0xc9
  assert.equal(decodeJpeg(jpeg), null)
})

test('a decoded jpeg survives the whole plate pipeline', () => {
  const decoded = decodeJpeg(makeJpeg())
  assert.ok(decoded)
  const source = pixels(decoded.width, decoded.height, decoded.data)
  // `fit` takes a pixel-row count, and a cell row is two pixel rows
  const fitted = fit(source, 20, 20)
  assert.equal(fitted.width, 20)
  assert.equal(fitted.height, 20)
  const rendered = renderPixels(source, 20, 10, pickRenderer(24, true))
  assert.equal(rendered.split('\n').length, 10)
  // a grey image must still put ink on the sheet
  assert.ok(rendered.length > 0)
  assert.ok(rendered.includes('\u2580'), 'half-block glyphs present')
})