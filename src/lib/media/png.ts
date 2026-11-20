import zlib from 'node:zlib'

/**
 * A dependency-free baseline PNG reader.
 *
 * ffmpeg is already a hard requirement for merging streams and for decoding
 * thumbnails, so it does the heavy lifting. This exists for the case where
 * ffmpeg is missing: Node ships zlib, so a PNG is ~150 lines away from being
 * drawn in the terminal, and PNG is the format people actually paste.
 */

export type Decoded = {
  width: number
  height: number
  /** packed RGB, 3 bytes per pixel */
  data: Uint8Array
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

type Ihdr = {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

class Reader {
  offset = 0
  constructor(private readonly buf: Buffer) {}

  u32(): number {
    const v = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return v
  }

  bytes(n: number): Buffer {
    const v = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return v
  }
}

export function isPng(buf: Buffer): boolean {
  return buf.length > 8 && SIGNATURE.every((byte, i) => buf[i] === byte)
}

export function decodePng(buf: Buffer): Decoded | null {
  if (!isPng(buf)) return null
  const reader = new Reader(buf)
  reader.offset = 8

  let ihdr: Ihdr | null = null
  let palette: Buffer | null = null
  let transparency: Buffer | null = null
  const idat: Buffer[] = []

  while (reader.offset + 8 <= buf.length) {
    const length = reader.u32()
    const type = reader.bytes(4).toString('latin1')
    const body = reader.bytes(length)
    // The CRC is read to keep the offset honest; it is not verified, because a
    // preview does not need to reject a file over a checksum.
    reader.bytes(4)

    if (type === 'IHDR') {
      ihdr = {
        width: body.readUInt32BE(0),
        height: body.readUInt32BE(4),
        bitDepth: body[8] as number,
        colorType: body[9] as number,
        interlace: body[12] as number,
      }
    } else if (type === 'PLTE') {
      palette = body
    } else if (type === 'tRNS') {
      transparency = body
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
  }

  if (!ihdr) return null
  if (ihdr.interlace !== 0) return null // Adam7: rare enough to hand to ffmpeg
  if (idat.length === 0) return null

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const channels = channelsFor(ihdr.colorType)
  if (channels === null) return null

  const {width, height, bitDepth} = ihdr
  if (width <= 0 || height <= 0 || width > 20_000 || height > 20_000) return null

  const bitsPerPixel = channels * bitDepth
  const bytesPerPixel = Math.max(1, bitsPerPixel >> 3)
  const rowBytes = Math.ceil((bitsPerPixel * width) / 8)

  const scanlines = unfilter(raw, height, rowBytes, bytesPerPixel)
  if (!scanlines) return null

  return expand(scanlines, width, height, ihdr, channels, bitDepth, palette, transparency)
}

function channelsFor(colorType: number): number | null {
  switch (colorType) {
    case 0:
      return 1 // grayscale
    case 2:
      return 3 // truecolour
    case 3:
      return 1 // palette index
    case 4:
      return 2 // grayscale + alpha
    case 6:
      return 4 // truecolour + alpha
    default:
      return null
  }
}

function unfilter(raw: Buffer, height: number, rowBytes: number, bpp: number): Buffer | null {
  const out = Buffer.alloc(height * rowBytes)
  let pos = 0
  let previous = Buffer.alloc(rowBytes)

  for (let y = 0; y < height; y++) {
    const filter = raw[pos]
    pos++
    if (pos + rowBytes > raw.length) return null
    const line = raw.subarray(pos, pos + rowBytes)
    pos += rowBytes

    const current = out.subarray(y * rowBytes, (y + 1) * rowBytes)
    line.copy(current)

    switch (filter) {
      case 0:
        break
      case 1:
        for (let x = bpp; x < rowBytes; x++) current[x] = (current[x]! + current[x - bpp]!) & 255
        break
      case 2:
        for (let x = 0; x < rowBytes; x++) current[x] = (current[x]! + previous[x]!) & 255
        break
      case 3:
        for (let x = 0; x < rowBytes; x++) {
          const left = x >= bpp ? current[x - bpp]! : 0
          current[x] = (current[x]! + ((left + previous[x]!) >> 1)) & 255
        }
        break
      case 4:
        for (let x = 0; x < rowBytes; x++) {
          const a = x >= bpp ? current[x - bpp]! : 0
          const b = previous[x]!
          const c = x >= bpp ? previous[x - bpp]! : 0
          current[x] = (current[x]! + paeth(a, b, c)) & 255
        }
        break
      default:
        return null
    }
    previous = current
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

function expand(
  scanlines: Buffer,
  width: number,
  height: number,
  ihdr: Ihdr,
  channels: number,
  bitDepth: number,
  palette: Buffer | null,
  transparency: Buffer | null,
): Decoded | null {
  const data = new Uint8Array(width * height * 3)
  const rowBytes = Math.ceil((channels * bitDepth * width) / 8)
  const max = 1 << bitDepth

  // Sample reader for sub-byte depths (1/2/4-bit gray and palette).
  const sample = (row: Buffer, index: number): number => {
    if (bitDepth === 8) return row[index]!
    if (bitDepth === 16) return row[index * 2]!
    const perByte = 8 / bitDepth
    const byte = row[Math.floor(index / perByte)]!
    const shift = 8 - bitDepth * ((index % perByte) + 1)
    return (byte >> shift) & (max - 1)
  }

  for (let y = 0; y < height; y++) {
    const row = scanlines.subarray(y * rowBytes, (y + 1) * rowBytes)
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 3
      const base = x * channels

      if (ihdr.colorType === 3) {
        if (!palette) return null
        const index = sample(row, base)
        const p = index * 3
        data[o] = palette[p] ?? 0
        data[o + 1] = palette[p + 1] ?? 0
        data[o + 2] = palette[p + 2] ?? 0
        continue
      }

      let r: number
      let g: number
      let b: number
      if (ihdr.colorType === 0 || ihdr.colorType === 4) {
        const v = sample(row, base)
        // tRNS on grayscale: the sample value that means "transparent"
        const transparent = transparency && transparency.readUInt16BE(0) === v
        const scaled = bitDepth >= 8 ? v : Math.round((v / (max - 1)) * 255)
        r = g = b = scaled
        if (transparent) {
          data[o] = 0
          data[o + 1] = 0
          data[o + 2] = 0
          continue
        }
      } else {
        r = sample(row, base)
        g = sample(row, base + 1)
        b = sample(row, base + 2)
      }
      data[o] = r
      data[o + 1] = g
      data[o + 2] = b
    }
  }

  return {width, height, data}
}