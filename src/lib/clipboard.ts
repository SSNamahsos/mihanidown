import {execFile} from 'node:child_process'

/**
 * Best-effort clipboard read, so launching bare with a link already copied
 * gives you a filled field. Never fatal and never slow: if the platform has no
 * cheap way to read the clipboard we simply return an empty string.
 */
export function readClipboard(timeoutMs = 400): Promise<string> {
  const command = clipboardCommand()
  if (!command) return Promise.resolve('')
  const [cmd, args] = command

  return new Promise(resolve => {
    let settled = false
    const done = (value: string) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => done(''), timeoutMs)
    timer.unref?.()

    try {
      execFile(cmd, args, {timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024}, (error, stdout) => {
        clearTimeout(timer)
        done(error ? '' : stdout.trim())
      })
    } catch {
      clearTimeout(timer)
      done('')
    }
  })
}

function clipboardCommand(): [string, string[]] | null {
  switch (process.platform) {
    case 'win32':
      return ['powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Clipboard -Raw']]
    case 'darwin':
      return ['pbpaste', []]
    default:
      // wl-paste on Wayland, xclip on X11
      return ['sh', ['-c', 'wl-paste -n 2>/dev/null || xclip -selection clipboard -o 2>/dev/null']]
  }
}