import {execFile} from 'node:child_process'

/** Reveal the output folder in the platform's file manager. */
export function openFolder(dir: string): Promise<void> {
  const command = opener(dir)
  if (!command) return Promise.resolve()
  const [cmd, args] = command
  return new Promise(resolve => {
    try {
      execFile(cmd, args, {windowsHide: true}, () => resolve())
    } catch {
      resolve()
    }
  })
}

function opener(dir: string): [string, string[]] | null {
  switch (process.platform) {
    case 'win32':
      return ['explorer', [dir]]
    case 'darwin':
      return ['open', [dir]]
    default:
      return ['xdg-open', [dir]]
  }
}