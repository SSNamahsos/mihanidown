import {spawn} from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {pixels, type Pixels} from './decode.js'
import {activeFront} from '../front.js'

/**
 * A video preview is a filmstrip: N frames pulled at even intervals in a single
 * ffmpeg pass, held in memory as raw RGB. Holding them means scrubbing is a
 * repaint instead of a decode, so holding left/right feels instant instead of
 * spawning a process per keypress.
 *
 * Frames are square and centred so any source aspect letterboxes identically and
 * the plate can re-fit at render time when the terminal is resized.
 */
const FRAME = 100
const DEFAULT_FRAMES = 32
const MAX_BYTES = FRAME * FRAME * 3 * DEFAULT_FRAMES

export type Filmstrip = {
  frames: Pixels[]
  /** wall-clock time of each frame, in seconds from the start */
  times: number[]
  width: number
  height: number
}

export type FilmstripRequest = {
  source: string
  isUrl: boolean
  ffmpeg: string
  duration?: number
  frames?: number
  signal?: AbortSignal
  /** called as each frame decodes, so the plate can fill in progressively */
  onFrame?: (frames: Pixels[], duration: number) => void
  /** set when the source needs the front: ffmpeg's own names for the same route */
  proxyArgs?: string[]
}

export async function buildFilmstrip(req: FilmstripRequest): Promise<Filmstrip | null> {
  const frames = Math.min(req.frames ?? DEFAULT_FRAMES, 48)
  const duration = req.duration ?? 0
  // A finite duration gives evenly spaced frames; otherwise sample 12 seconds in
  // and accept whatever the single-frame path returns.
  const rate = duration > 0 ? Math.max(0.02, Math.min(4, frames / duration)) : 0

  const args = [
    '-nostdin',
    '-loglevel',
    'error',
    ...(req.isUrl ? ['-user_agent', 'Mozilla/5.0'] : []),
    ...(req.isUrl ? (req.proxyArgs ?? activeFront()?.ffmpegArgs ?? []) : []),
  ]

  if (rate === 0) {
    args.push('-ss', '5')
    args.push('-i', req.source, '-frames:v', '1')
  } else {
    args.push('-i', req.source, '-t', String(duration + 1))
  }

  args.push(
    '-vf',
    `fps=${rate},scale=${FRAME}:${FRAME}:force_original_aspect_ratio=decrease,pad=${FRAME}:${FRAME}:(ow-iw)/2:(oh-ih)/2`,
    '-pix_fmt',
    'rgb24',
    '-f',
    'rawvideo',
    'pipe:1',
  )

  return new Promise(resolve => {
    let child
    try {
      child = spawn(req.ffmpeg, args, {signal: req.signal})
    } catch {
      resolve(null)
      return
    }

    const frameBytes = FRAME * FRAME * 3
    const collected: Pixels[] = []
    let pending: Uint8Array = new Uint8Array(0)
    let settled = false
    const finish = (value: Filmstrip | null) => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      resolve(value)
    }

    child.stdout?.on('data', (chunk: Uint8Array) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([Buffer.from(pending), Buffer.from(chunk)])
      while (pending.length >= frameBytes) {
        collected.push(pixels(FRAME, FRAME, pending.slice(0, frameBytes)))
        pending = pending.slice(frameBytes)
        req.onFrame?.([...collected], duration)
        if (collected.length >= frames) break
      }
      if (pending.length > MAX_BYTES) finish(null)
    })

    child.on('error', () => finish(null))
    child.on('close', () => {
      if (collected.length > 0) {
        resolve({
          frames: collected,
          times: collected.map((_, i) => (duration > 0 ? (i / collected.length) * duration : 0)),
          width: FRAME,
          height: FRAME,
        })
      } else {
        resolve(null)
      }
    })

    req.signal?.addEventListener('abort', () => finish(null), {once: true})
  })
}

/**
 * Grab one representative frame as a PNG on disk. Used when there is no ffmpeg
 * for a full filmstrip, or as the poster image behind a loading plate.
 */
export async function extractPoster(
  ffmpeg: string,
  source: string,
  isUrl: boolean,
  atSeconds: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const dir = path.join(os.tmpdir(), 'mihanidown')
  await fs.mkdir(dir, {recursive: true})
  const out = path.join(dir, `poster-${process.pid}-${Date.now()}.png`)
  try {
    const code = await new Promise<number | null>(resolve => {
      const child = spawn(
        ffmpeg,
        [
          '-nostdin',
          '-loglevel',
          'error',
          '-y',
          ...(isUrl ? ['-user_agent', 'Mozilla/5.0'] : []),
          ...(isUrl ? (activeFront()?.ffmpegArgs ?? []) : []),
          '-ss',
          String(Math.max(0, atSeconds)),
          '-i',
          source,
          '-frames:v',
          '1',
          out,
        ],
        {signal, stdio: 'ignore'},
      )
      child.on('error', () => resolve(-1))
      child.on('close', c => resolve(c))
    })
    return code === 0 ? out : null
  } catch {
    return null
  }
}