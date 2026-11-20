import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {decodeJpeg, isJpeg} from './jpeg.js'
import {decodePng, isPng} from './png.js'
import {isImageMime} from '../format.js'
import {httpFetch} from '../front.js'

/** Packed RGB, 3 bytes per pixel, row-major. */
export type Pixels = {
  width: number
  height: number
  data: Uint8Array
}

export function pixels(width: number, height: number, data?: Uint8Array): Pixels {
  return {width, height, data: data ?? new Uint8Array(width * height * 3)}
}

/**
 * Letterbox `src` into exactly `cols`x`pxRows` cells. Terminal cells are about
 * twice as tall as they are wide, so each cell is sampled as two stacked pixels
 * and the source is fitted to the cell grid rather than the pixel grid —
 * otherwise every preview comes out looking stretched vertically.
 */
export function fit(src: Pixels, cols: number, pxRows: number): Pixels {
  const targetAspect = cols / pxRows
  const srcAspect = src.width / src.height

  let cropW = src.width
  let cropH = src.height
  if (srcAspect > targetAspect) {
    cropW = Math.round(src.height * targetAspect)
  } else {
    cropH = Math.round(src.width / targetAspect)
  }
  cropW = Math.max(1, Math.min(cropW, src.width))
  cropH = Math.max(1, Math.min(cropH, src.height))
  const offsetX = Math.floor((src.width - cropW) / 2)
  const offsetY = Math.floor((src.height - cropH) / 2)

  const out = pixels(cols, pxRows)
  for (let y = 0; y < pxRows; y++) {
    const sy0 = offsetY + Math.floor((y * cropH) / pxRows)
    const sy1 = Math.max(sy0 + 1, offsetY + Math.ceil(((y + 1) * cropH) / pxRows))
    for (let x = 0; x < cols; x++) {
      const sx0 = offsetX + Math.floor((x * cropW) / cols)
      const sx1 = Math.max(sx0 + 1, offsetX + Math.ceil(((x + 1) * cropW) / cols))
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = sy0; sy < sy1 && sy < src.height; sy++) {
        for (let sx = sx0; sx < sx1 && sx < src.width; sx++) {
          const o = (sy * src.width + sx) * 3
          r += src.data[o] ?? 0
          g += src.data[o + 1] ?? 0
          b += src.data[o + 2] ?? 0
          n++
        }
      }
      const o = (y * cols + x) * 3
      if (n === 0) continue
      out.data[o] = Math.round(r / n)
      out.data[o + 1] = Math.round(g / n)
      out.data[o + 2] = Math.round(b / n)
    }
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Decoding
 * ------------------------------------------------------------------ */

async function pipe(
  bin: string,
  args: string[],
  maxBytes: number,
  signal?: AbortSignal,
  stdin?: Buffer,
): Promise<{stdout: Buffer; stderr: string}> {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, args, {signal})
    } catch (error) {
      reject(error)
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let stderr = ''
    if (stdin && child.stdin) {
      child.stdin.on('error', () => undefined)
      child.stdin.end(stdin)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      size += chunk.length
      // stop a hostile or broken source from filling memory
      if (size > maxBytes) {
        child.kill('SIGKILL')
        reject(new Error('image is larger than the preview budget'))
        return
      }
      chunks.push(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')))
    child.on('error', reject)
    child.on('close', () => resolve({stdout: Buffer.concat(chunks), stderr}))
  })
}

const MAX_BYTES = 48 * 1024 * 1024

export type DecodeInput = {
  /** local file, or a remote url to fetch first */
  source: string
  isUrl: boolean
  ffmpeg?: string
  signal?: AbortSignal
}

/**
 * Decode any still image into pixels.
 *
 * Order matters here, and it has been both ways. When ffmpeg is present it
 * decodes first: it is a full reference decoder, so progressive JPEGs from
 * real encoders — which the in-process JPEG reader still renders with block
 * artefacts — come out pixel-correct, and every long-tail format (webp, avif,
 * heic, svg, tiff, bmp, gif) is covered by the same path. What the plate shows
 * is then guaranteed to be the actual thumbnail, which is the whole point.
 *
 * Without ffmpeg, the in-process readers take over: sniff the magic bytes and
 * decode where we can — JPEG and PNG cover almost every thumbnail on the web,
 * for free and in about a millisecond.
 */
export async function decodeImage(input: DecodeInput): Promise<Pixels | null> {
  let bytes: Buffer
  let mimeHint: string | undefined

  if (input.isUrl) {
    const response = await httpFetch(input.source, {signal: input.signal})
    if (!response.ok) throw new Error(`image fetch failed (${response.status})`)
    mimeHint = response.headers.get('content-type') ?? undefined
    const array = new Uint8Array(await response.arrayBuffer())
    if (array.byteLength > MAX_BYTES) throw new Error('image is larger than the preview budget')
    bytes = Buffer.from(array)
  } else {
    const {readFile} = await import('node:fs/promises')
    bytes = await readFile(input.source)
  }

  // ffmpeg first when it exists — fed the bytes we already downloaded, never
  // the url. Handing it the url means fetching it a second time outside this
  // process, which loses any routing this app did to get them.
  if (input.ffmpeg) {
    const viaFfmpeg = await tryFfmpeg(input.ffmpeg, bytes, mimeHint, input.signal)
    if (viaFfmpeg) return viaFfmpeg
  }

  // in-process fallback: magic bytes, not the server's content-type header,
  // which is frequently wrong or absent on CDNs
  if (isJpeg(bytes)) {
    const jpeg = decodeJpeg(bytes)
    if (jpeg) return pixels(jpeg.width, jpeg.height, jpeg.data)
  } else if (isPng(bytes)) {
    const png = decodePng(bytes)
    if (png) return pixels(png.width, png.height, png.data)
  }

  const kind = describeFormat(bytes, mimeHint)
  if (mimeHint?.startsWith('image/') || isImageMime(mimeHint)) {
    throw new Error(`no decoder for ${mimeHint ?? kind}`)
  }
  return null
}

/** Name the format from its magic bytes, for error messages worth reading. */
function describeFormat(bytes: Buffer, mimeHint: string | undefined): string {
  if (bytes.length < 12) return mimeHint ?? 'unknown'
  const hex = bytes.subarray(0, 12).toString('hex')
  if (hex.startsWith('47494638')) return 'gif'
  if (hex.startsWith('52494646')) return 'webp/riff'
  if (hex.startsWith('424d')) return 'bmp'
  if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a')) return 'tiff'
  if (hex.startsWith('0000001c66747970') || hex.startsWith('667479706973')) return 'heif/heic'
  if (isJpeg(bytes)) return 'jpeg'
  return mimeHint ?? 'unknown'
}

/**
 * ffmpeg cannot always sniff a container from a pipe, and a few need to seek, so
 * the bytes go to a short-lived file instead. The name comes from the magic bytes
 * rather than the server's content-type, which is wrong often enough on CDNs.
 */
const EXTENSION_BY_FORMAT: Record<string, string> = {
  gif: 'gif',
  'webp/riff': 'webp',
  bmp: 'bmp',
  tiff: 'tiff',
  'heif/heic': 'heic',
  jpeg: 'jpg',
}

async function tryFfmpeg(
  ffmpeg: string,
  bytes: Buffer,
  mimeHint: string | undefined,
  signal?: AbortSignal,
): Promise<Pixels | null> {
  /*
   * Cap the height at 64px and let the width follow the source's own aspect
   * (`-2` keeps the even alignment rawvideo needs). Padding to a square here —
   * as the filmstrip does — would bake black bars into every non-square image
   * and then the plate would draw them too. The width is recovered from the
   * byte count: one frame at 3 bytes per pixel and a known height is enough.
   */
  const height = 64
  const dir = path.join(os.tmpdir(), 'mihanidown')
  const file = path.join(dir, `poster-${process.pid}-${Date.now()}.${EXTENSION_BY_FORMAT[describeFormat(bytes, mimeHint)] ?? 'img'}`)
  try {
    await fs.mkdir(dir, {recursive: true})
    await fs.writeFile(file, bytes)
    const {stdout} = await pipe(
      ffmpeg,
      [
        '-nostdin',
        '-loglevel',
        'error',
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale=-2:${height}`,
        '-pix_fmt',
        'rgb24',
        '-f',
        'rawvideo',
        'pipe:1',
      ],
      MAX_BYTES,
      signal,
    )
    const rowBytes = height * 3
    if (stdout.length < rowBytes) return null
    const width = Math.floor(stdout.length / rowBytes)
    if (width < 1) return null
    return pixels(width, height, new Uint8Array(stdout.subarray(0, width * rowBytes)))
  } catch {
    return null
  } finally {
    await fs.rm(file, {force: true}).catch(() => undefined)
  }
}