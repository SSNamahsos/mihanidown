import assert from 'node:assert/strict'
import test from 'node:test'
import zlib from 'node:zlib'
import {decodePng, isPng} from './png.js'

/** Build a minimal PNG in memory so the decoder is tested against real bytes. */
function makePng(
  width: number,
  height: number,
  pixel: (x: number, y: number) => [number, number, number],
  colourType = 2,
  bitDepth = 8,
): Buffer {
  const channels = colourType === 2 ? 3 : colourType === 6 ? 4 : 1
  const rowBytes = Math.ceil((channels * bitDepth * width) / 8)
  const raw = Buffer.alloc(height * (rowBytes + 1))

  for (let y = 0; y < height; y++) {
    const offset = y * (rowBytes + 1)
    raw[offset] = 0 // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y)
      const o = offset + 1 + x * channels
      if (colourType === 0) raw[o] = r
      else {
        raw[o] = r
        raw[o + 1] = g
        raw[o + 2] = b
      }
    }
  }

  const chunk = (type: string, body: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(body.length)
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(typed) >>> 0)
    return Buffer.concat([length, typed, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = bitDepth
  ihdr[9] = colourType
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let crcTable: Uint32Array | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (const byte of buf) crc = (crcTable[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

test('detects a png by its signature', () => {
  assert.equal(isPng(makePng(2, 2, () => [0, 0, 0])), true)
  assert.equal(isPng(Buffer.from('not a png at all')), false)
})

test('decodes truecolour 8-bit into packed rgb', () => {
  const png = makePng(3, 2, (x, y) => [x * 40, y * 60, 7])
  const decoded = decodePng(png)
  assert.ok(decoded)
  assert.equal(decoded.width, 3)
  assert.equal(decoded.height, 2)
  assert.equal(decoded.data.length, 3 * 2 * 3)
  const at = (x: number, y: number) => {
    const o = (y * 3 + x) * 3
    return [decoded.data[o], decoded.data[o + 1], decoded.data[o + 2]]
  }
  assert.deepEqual(at(0, 0), [0, 0, 7])
  assert.deepEqual(at(2, 1), [80, 60, 7])
})

test('decodes greyscale', () => {
  const png = makePng(2, 2, x => [x * 100, x * 100, x * 100], 0)
  const decoded = decodePng(png)
  assert.ok(decoded)
  assert.deepEqual([decoded.data[0], decoded.data[1], decoded.data[2]], [0, 0, 0])
  assert.deepEqual([decoded.data[3], decoded.data[4], decoded.data[5]], [100, 100, 100])
})

test('refuses non-png input rather than throwing', () => {
  assert.equal(decodePng(Buffer.from('<html>nope</html>')), null)
})