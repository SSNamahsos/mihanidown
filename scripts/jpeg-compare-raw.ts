/**
 * Compare our JPEG decode against a raw RGB24 dump from another decoder.
 *
 * The GDI+ comparison is confounded by chroma upsampling: it interpolates the
 * half-resolution chroma planes, we do not, and on a photograph that dominates
 * the numbers. Decoding the same file with ffmpeg forced to nearest-neighbour
 * isolates the entropy decoder from the resampling filter.
 *
 *   tsx scripts/jpeg-compare-raw.ts <file.jpg> <reference.raw> [WxH]
 */
import fs from 'node:fs'
import {decodeJpeg} from '../src/lib/media/jpeg.js'

const file = process.argv[2] as string
const rawPath = process.argv[3] as string
const size = process.argv[4] ?? ''

const ref = fs.readFileSync(rawPath)
let width = 0
let height = 0
if (size) {
  const [w, h] = size.split('x').map(Number)
  width = w as number
  height = h as number
} else {
  // 200x200 is the only fixture size; derive it rather than hard-code
  width = 200
  height = ref.length / 3 / width
}
if (ref.length !== width * height * 3) {
  throw new Error(`reference is ${ref.length} bytes, expected ${width * height * 3} for ${width}x${height}`)
}

const out = decodeJpeg(fs.readFileSync(file))
if (!out) {
  console.log('decode failed')
  process.exit(1)
}
const {data} = out

let sum = 0
let lumaSum = 0
let chromaSum = 0
let max = 0
let exact = 0
const n = width * height * 3
for (let i = 0; i < n; i++) {
  const d = Math.abs((data[i] as number) - (ref[i] as number))
  sum += d
  if (d > max) max = d
  if (d === 0) exact++
}
for (let p = 0; p < width * height; p++) {
  const i = p * 3
  for (let c = 0; c < 3; c++) {
    const d = Math.abs((data[i + c] as number) - (ref[i + c] as number))
    if (c === 0) lumaSum += d
    else chromaSum += d
  }
}

console.log(`vs ${rawPath.split(/[\\/]/).pop()}`)
console.log(
  `mean |diff| ${(sum / n).toFixed(2)}  max ${max}  exact ${((exact / n) * 100).toFixed(1)}%` +
    `   luma ${(lumaSum / (width * height)).toFixed(2)}  chroma ${(chromaSum / (width * height * 2)).toFixed(2)}`,
)
