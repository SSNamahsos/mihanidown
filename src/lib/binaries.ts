import {spawn, type ChildProcess} from 'node:child_process'
import fs from 'node:fs/promises'
import {createWriteStream} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'

export const APP_DIR = path.join(os.homedir(), '.mihanidown')
export const BIN_DIR = path.join(APP_DIR, 'bin')

/**
 * Build channels, newest first. Nightly is what actually works against
 * YouTube: the extractors break weekly and stable releases trail by weeks, so a
 * stale build is the single most common cause of "Sign in to confirm you're
 * not a bot" on an otherwise fine setup.
 */
const CHANNELS = [
  {
    id: 'nightly',
    repo: 'yt-dlp/yt-dlp-nightly-builds',
    asset: (platform: NodeJS.Platform, arch: string) =>
      platform === 'win32'
        ? 'yt-dlp.exe'
        : platform === 'darwin'
          ? 'yt-dlp_macos'
          : arch === 'arm64'
            ? 'yt-dlp_linux_aarch64'
            : 'yt-dlp_linux',
  },
  {
    id: 'master',
    repo: 'yt-dlp/yt-dlp-master-builds',
    asset: (platform: NodeJS.Platform, arch: string) =>
      platform === 'win32'
        ? 'yt-dlp-master.exe'
        : platform === 'darwin'
          ? 'yt-dlp-master_macos'
          : arch === 'arm64'
            ? 'yt-dlp-master_linux_aarch64'
            : 'yt-dlp-master_linux',
  },
  {
    id: 'stable',
    repo: 'yt-dlp/yt-dlp',
    asset: (platform: NodeJS.Platform, arch: string) =>
      platform === 'win32'
        ? 'yt-dlp.exe'
        : platform === 'darwin'
          ? 'yt-dlp_macos'
          : arch === 'arm64'
            ? 'yt-dlp_linux_aarch64'
            : 'yt-dlp_linux',
  },
] as const

const MAX_AGE_MS = 2 * 24 * 60 * 60 * 1000

function binaryName(): string {
  const channel = CHANNELS[0]
  return channel.asset(process.platform, process.arch)
}

export type BinaryStatus = {
  ytdlp: string
  ytdlpVersion: string
  /** Which build channel the managed binary came from, if it is managed. */
  channel?: string
  ffmpeg?: string
  /** A local proof-of-origin token provider (bgutil), if the user set one up. */
  poTokenProvider?: string
  deno?: string
}

/** Never `spawnSync`: a blocking call here freezes ink mid-frame. */
function commandWorks(cmd: string, args: string[] = ['--version']): Promise<boolean> {
  return new Promise(resolve => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {stdio: 'ignore'})
    } catch {
      resolve(false)
      return
    }
    child.on('error', () => resolve(false))
    child.on('close', code => resolve(code === 0))
  })
}

export function run(
  cmd: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{code: number | null; stdout: string; stderr: string}> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess
    try {
      child = spawn(cmd, args, {signal})
    } catch (error) {
      reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', chunk => (stdout += String(chunk)))
    child.stderr?.on('data', chunk => (stderr += String(chunk)))
    child.on('error', reject)
    child.on('close', code => resolve({code, stdout, stderr}))
  })
}

async function ageMs(file: string): Promise<number> {
  try {
    const stat = await fs.stat(file)
    return Date.now() - stat.mtimeMs
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

async function download(url: string, destination: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch(url, {signal, redirect: 'follow'})
  if (!response.ok || !response.body) {
    throw new Error(`${response.status} ${response.statusText}`)
  }
  const tmp = `${destination}.part`
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(tmp), {signal})
  if (process.platform !== 'win32') await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, destination)
}

/**
 * Resolve a yt-dlp binary. Managed nightly first (freshest extractors), then a
 * system install, then progressively older build channels.
 */
export async function ensureYtDlp(
  onStatus: (message: string) => void,
  options: {force?: boolean; preferSystem?: boolean} = {},
  signal?: AbortSignal,
): Promise<{bin: string; channel?: string}> {
  const target = path.join(BIN_DIR, binaryName())

  if (!options.force) {
    if (await commandWorks(target)) {
      if ((await ageMs(target)) < MAX_AGE_MS) return {bin: target, channel: 'managed'}
    }
  } else {
    onStatus('refreshing yt-dlp\u2026')
  }

  if (options.preferSystem && (await commandWorks('yt-dlp'))) return {bin: 'yt-dlp'}

  await fs.mkdir(BIN_DIR, {recursive: true})

  for (const channel of CHANNELS) {
    const asset = channel.asset(process.platform, process.arch)
    // skip re-downloading an identical file we already validated
    const destination = channel.id === CHANNELS[0].id ? target : path.join(BIN_DIR, asset)
    if (!(await commandWorks(destination))) {
      try {
        onStatus(`fetching yt-dlp ${channel.id}\u2026`)
        await download(`https://github.com/${channel.repo}/releases/latest/download/${asset}`, destination, signal)
      } catch {
        continue
      }
    }
    if (await commandWorks(destination)) return {bin: destination, channel: channel.id}
  }

  if (await commandWorks('yt-dlp')) return {bin: 'yt-dlp'}

  throw new Error(
    'Could not fetch yt-dlp and none is installed. Install it with `pip install -U yt-dlp` or `winget install yt-dlp.yt-dlp`, then run mihanidown again.',
  )
}

export async function ytDlpVersion(bin: string): Promise<string> {
  try {
    const {stdout} = await run(bin, ['--version'])
    return stdout.trim().split('\n')[0] ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * ffmpeg is needed to merge high-res streams, extract mp3, and decode
 * thumbnails into terminal pixels.
 *
 * The candidate list is probed concurrently rather than one at a time. Sequentially
 * it was ten `spawn` round-trips before the sheet could show anything, and on
 * Windows each one costs 50-150ms — a second and a half of blank terminal that
 * looks exactly like a hang. In parallel it is one.
 */
export async function findFfmpeg(): Promise<string | undefined> {
  if (await commandWorks('ffmpeg', ['-version'])) return 'ffmpeg'

  const candidates: string[] = []

  // ffmpeg-static is optional. The specifier is held in a variable so neither
  // tsc nor the bundler tries to resolve a package that may not be installed.
  const specifier = 'ffmpeg-static'
  try {
    const mod = (await import(specifier)) as {default?: string | null}
    const p = mod.default
    if (typeof p === 'string') candidates.push(p)
  } catch {
    /* not installed, or no build for this platform */
  }

  for (const root of [process.env['LOCALAPPDATA'], process.env['ProgramFiles'], '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin']) {
    if (!root) continue
    candidates.push(path.join(root, 'ffmpeg', 'bin', 'ffmpeg.exe'))
    candidates.push(path.join(root, 'ffmpeg', 'ffmpeg.exe'))
    candidates.push(path.join(root, 'ffmpeg'))
  }

  const found = await Promise.all(candidates.map(async candidate => ((await commandWorks(candidate, ['-version'])) ? candidate : undefined)))
  return found.find(Boolean)
}

/**
 * A PO-Token provider is the only way to get 1080p+ out of the `web` client.
 * bgutil is a local, open-source provider that runs YouTube's own JS in Deno —
 * no third-party server, nothing leaves the machine.
 *
 * Probed concurrently with Deno, because both are "is it there?" checks and
 * neither depends on the other.
 */
export async function findPoTokenProvider(): Promise<string | undefined> {
  const candidates = [
    process.env['BGUTIL_POT_PATH'],
    path.join(os.homedir(), '.config', 'bgutil-ytdlp-pot-provider', 'server.py'),
    path.join(APP_DIR, 'bgutil', 'server.py'),
  ].filter((p): p is string => Boolean(p))

  // the `script` variant runs the provider in-process instead of over http
  const commands = ['bgutil-pot', 'bgutil-ytdlp-pot-provider']

  const [files, exes, deno] = await Promise.all([
    Promise.all(
      candidates.map(async p => {
        try {
          await fs.access(p)
          return p
        } catch {
          return undefined
        }
      }),
    ),
    Promise.all(commands.map(async name => ((await commandWorks(name, ['--version'])) ? name : undefined))),
    commandWorks('deno', ['--version']),
  ])

  void deno
  return files.find(Boolean) ?? exes.find(Boolean)
}

export async function findDeno(): Promise<string | undefined> {
  return (await commandWorks('deno', ['--version'])) ? 'deno' : undefined
}

export async function resolveBinaries(
  onStatus: (message: string) => void,
  options: {force?: boolean; preferSystem?: boolean} = {},
  signal?: AbortSignal,
): Promise<BinaryStatus> {
  const {bin, channel} = await ensureYtDlp(onStatus, options, signal)

  // Everything below is independent, so it all happens at once. The sheet shows
  // a three-step checklist; running these in parallel is what makes those three
  // steps feel like one wait rather than three.
  const [ytdlpVersion, ffmpeg, poTokenProvider, deno] = await Promise.all([
    ytDlpVersion(bin),
    findFfmpeg(),
    findPoTokenProvider(),
    commandWorks('deno', ['--version']).then(yes => (yes ? 'deno' : undefined)),
  ])

  return {ytdlp: bin, ytdlpVersion, channel, ffmpeg, poTokenProvider, deno}
}

/**
 * Downloads land where the user is. The shell's working directory *is* the
 * answer to "where should this go": open `mihanidown` on the Desktop and the
 * file belongs on the Desktop. Anything else — Downloads, another drive — is a
 * deliberate choice made in the picker, not a default imposed here.
 */
export function defaultOutDir(): string {
  return process.cwd()
}