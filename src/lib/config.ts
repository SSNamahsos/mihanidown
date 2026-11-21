import fs from 'node:fs/promises'
import path from 'node:path'
import {APP_DIR} from './binaries.js'
import type {ThemeName} from '../theme.js'
import type {FrontMode} from './front.js'

export type Config = {
  theme: ThemeName
  /**
   * Deliberately absent: the output folder. Where files land is where the
   * terminal was opened, every session; only -o or the in-app picker moves
   * it, and neither is remembered.
   */
  /** Browser name for `--cookies-from-browser`. */
  cookies?: string
  /** Preferred yt-dlp player client, or "auto" to rotate. */
  client: string
  /** Render media previews in the plate. */
  preview: boolean
  /** Ask before overwriting an existing file. */
  confirmOverwrite: boolean
  /** Save the video's thumbnail image alongside every download. */
  saveThumbnail: boolean
  /**
   * `auto` asks the network whether the connection is filtered and only then
   * routes through the front. `on` insists, `off` never.
   */
  front: FrontMode
}

const DEFAULTS: Config = {
  theme: 'auto',
  client: 'auto',
  preview: true,
  confirmOverwrite: true,
  saveThumbnail: true,
  front: 'auto',
}

const CONFIG_PATH = path.join(APP_DIR, 'config.json')

let cache: Config | null = null

export async function loadConfig(): Promise<Config> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Partial<Config>
    cache = {...DEFAULTS, ...parsed}
  } catch {
    cache = {...DEFAULTS}
  }
  return cache
}

export async function saveConfig(patch: Partial<Config>): Promise<Config> {
  const current = await loadConfig()
  const next = {...current, ...patch}
  cache = next
  try {
    await fs.mkdir(APP_DIR, {recursive: true})
    await fs.writeFile(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    /* a read-only home directory shouldn't take the app down */
  }
  return next
}

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

const HISTORY_PATH = path.join(APP_DIR, 'history.json')

export async function loadHistory(limit = 50): Promise<string[]> {
  try {
    const raw = await fs.readFile(HISTORY_PATH, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((v): v is string => typeof v === 'string').slice(0, limit)
  } catch {
    return []
  }
}

export async function rememberUrl(url: string, limit = 50): Promise<void> {
  try {
    const history = await loadHistory(limit * 2)
    const next = [url, ...history.filter(h => h !== url)].slice(0, limit)
    await fs.mkdir(APP_DIR, {recursive: true})
    await fs.writeFile(HISTORY_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  } catch {
    /* history is a nicety, never a failure */
  }
}