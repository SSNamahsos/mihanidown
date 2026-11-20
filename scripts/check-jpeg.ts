/**
 * Decode a real JPEG off disk and print what came out, so the decoder is checked
 * against genuine encoder output rather than only a synthetic fixture.
 *
 *   npx tsx scripts/check-jpeg.ts <path.jpg>
 */
import fs from 'node:fs'
import {decodeJpeg, isJpeg, jpegFailureReason} from '../src/lib/media/jpeg.js'
import {fit, pixels} from '../src/lib/media/decode.js'
import {renderPixels, pickRenderer} from '../src/lib/media/ansi.js'

const file = process.argv[2]
if (!file) {
  process.stderr.write('usage: tsx scripts/check-jpeg.ts <file.jpg>\n')
  process.exit(1)
}

const bytes = fs.readFileSync(file)
console.log(`${file}  ${bytes.length} bytes  isJpeg=${isJpeg(bytes)}`)

const started = Date.now()
const out = decodeJpeg(bytes)
const ms = Date.now() - started

if (!out) {
  console.log(`DECODE FAILED  reason: ${jpegFailureReason() || '(none recorded)'}`)
  process.exit(1)
}

let min = 255
let max = 0
let sum = 0
for (let i = 0; i < out.data.length; i += 3) {
  const v = out.data[i] as number
  if (v < min) min = v
  if (v > max) max = v
  sum += v
}
const n = out.data.length / 3
console.log(`decoded ${out.width}x${out.height} in ${ms}ms`)
console.log(`luma min/max/mean  ${min} ${max} ${(sum / n).toFixed(1)}`)

// A real photo must have spread, not be a flat block. A decoder that reads the
// wrong bytes produces low-contrast mush while still "succeeding".
const spread = max - min
console.log(`contrast           ${spread}  ${spread > 40 ? '(looks like an image)' : '(SUSPECT: too flat)'}`)

// and it must survive into the plate renderer
const source = pixels(out.width, out.height, out.data)
const t0 = Date.now()
const fitted = fit(source, 44, 26)
const rendered = renderPixels(source, 44, 13, pickRenderer(24, true))
console.log(`plate ${fitted.width}x${fitted.height} in ${Date.now() - t0}ms, ${rendered.split('\n').length} rows`)
process.stdout.write('\n')
for (const line of rendered.split('\n')) {
  // eslint-disable-next-line no-control-regex
  process.stdout.write(line.replace(/\u001b\[[0-9;]*m/g, '') + '\n')
}

/*
 * Write the decoded pixels back out as a PNG so the result can be *looked at*.
 * A decoder can satisfy every numeric check and still get the channels, the
 * orientation or the chroma subsampling wrong, and none of that shows up in a
 * contrast statistic.
 */
const zlib = await import('node:zlib')
function crc32(b: Buffer): number {
  let table = (crc32 as unknown as {table?: Int32Array}).table
  if (!table) {
    table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      table[n] = c
    }
    ;(crc32 as unknown as {table?: Int32Array}).table = table
  }
  let crc = -1
  for (const byte of b) crc = ((crc >>> 8) as number) ^ (table[(crc ^ byte) & 0xff] as number)
  return (crc ^ -1) >>> 0
}
function chunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typed))
  return Buffer.concat([length, typed, crc])
}
function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0
    Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(
      raw,
      y * (width * 3 + 1) + 1,
    )
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const dest = process.env['TEMP'] ? `${process.env['TEMP']}\\jpeg-decoded.png` : 'jpeg-decoded.png'
fs.writeFileSync(dest, encodePng(out.width, out.height, out.data))
console.log(`\nwrote ${dest} — look at it`)