import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'

/**
 * Where downloads go.
 *
 * The rule is the one people expect: the file lands where you are. `mihanidown`
 * opened on the Desktop saves to the Desktop; opened in `D:\Media` it saves
 * there. No hidden subfolder, no surprise.
 *
 * The picker exists for the times that is not what you want, and offers the
 * places a person actually names: this folder, the Desktop, Downloads, and the
 * root of each mounted drive. A full path still works when someone has one.
 */

export type Root = {
  label: string
  dir: string
  /** one line under the label, so the choice is unambiguous */
  detail: string
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** The folder the user's shell was in when they typed `mihanidown`. */
export function startDir(): string {
  return process.cwd()
}

function windowsDrives(): Root[] {
  const found: Root[] = []
  for (const letter of DRIVE_LETTERS) {
    try {
      // existsSync on `X:\` is false for a letter that is not mounted, and does
      // not touch the disk for a letter that is not there at all.
      if (!fs.existsSync(`${letter}:\\`)) continue
      found.push({label: `${letter}:`, dir: `${letter.toUpperCase()}:\\`, detail: 'whole drive'})
    } catch {
      /* an unreadable drive is not a choice */
    }
  }
  return found
}

/**
 * The Desktop's real location. It is frequently redirected to OneDrive, and the
 * registry is the only place Windows keeps the truth, so ask there and fall
 * back to the classic path when the answer is missing or unreadable.
 */
let desktopCache: string | undefined

export function desktopDir(): Promise<string> {
  if (desktopCache) return Promise.resolve(desktopCache)
  if (process.platform !== 'win32') {
    desktopCache = path.join(os.homedir(), 'Desktop')
    return Promise.resolve(desktopCache)
  }
  // "Shell Folders" holds expanded values; "User Shell Folders" holds
  // %-templates that would need a second expansion pass.
  return new Promise(resolve => {
    execFile(
      'reg',
      [
        'query',
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Shell Folders',
        '/v',
        'Desktop',
      ],
      {timeout: 3000},
      (error, stdout) => {
        const line = stdout
          .split('\n')
          .find(l => l.trim().startsWith('Desktop'))
        const value = line?.split(/ {2,}/).at(-1)?.trim()
        desktopCache = value && value.length > 0 ? value : path.join(os.homedir(), 'Desktop')
        resolve(desktopCache)
      },
    )
  })
}

/**
 * The save picker's list, best first. The folder the app was opened from leads,
 * because that is where the file would land with no picker at all.
 */
export async function roots(): Promise<Root[]> {
  const list: Root[] = []
  const here = startDir()
  list.push({label: 'this folder', dir: here, detail: 'where you opened mihanidown'})

  const desktop = await desktopDir()
  if (path.resolve(desktop) !== path.resolve(here)) {
    list.push({label: 'desktop', dir: desktop, detail: ''})
  }

  const downloads = path.join(os.homedir(), 'Downloads')
  if (path.resolve(downloads) !== path.resolve(here)) {
    list.push({label: 'downloads', dir: downloads, detail: ''})
  }

  if (process.platform === 'win32') {
    list.push(...windowsDrives())
  } else {
    list.push({label: 'home', dir: os.homedir(), detail: ''})
  }
  return list
}

/**
 * Accept `d`, `D:`, `D:\`, `D:\Media` or a full path, and return a directory to
 * write into. Anything that is not a bare drive letter is taken literally, which
 * is what `-o /mnt/nas/films` needs to keep doing. A bare letter now means that
 * drive's root — `d` → `D:\`, not a folder buried inside it.
 */
export function expandDestination(value: string): string {
  const text = value.trim()
  if (process.platform !== 'win32') return text
  const bare = /^([A-Za-z]):?[\\/]?$/.exec(text)
  if (bare?.[1]) return `${bare[1].toUpperCase()}:\\`
  return text
}

/** Create it if the drive will have it, and report the path either way. */
export async function prepare(dir: string): Promise<string> {
  try {
    await fs.promises.mkdir(dir, {recursive: true})
  } catch {
    /* a read-only or full drive will say so when the file is written */
  }
  return dir
}
