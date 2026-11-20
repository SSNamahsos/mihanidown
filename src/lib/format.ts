const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/** 1.4 GB — short enough for a two-column spec sheet. */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '--'
  if (bytes < 1000) return `${Math.round(bytes)} B`
  let value = bytes
  let unit = 0
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${UNITS[unit]}`
}

/** 4:12 or 1:02:03. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--:--'
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad2 = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`
}

/** ETA as a short countdown: 1:04, 0:07, -- */
export function formatEta(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '--'
  if (seconds > 5999) return '99:59+'
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Strip characters that would corrupt a single-line terminal render. */
export function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * Characters no filesystem accepts in a name.
 *
 * Written as a string scan rather than a regex on purpose: an unescaped `/`
 * inside a character class silently terminates the regex literal in sloppy mode,
 * so the class ends at the slash and the rest of the pattern is never applied.
 * That bug let backslashes, colons and asterisks through into real filenames.
 */
const BANNED = new Set(['\u0000', ...'<>:"/\\|?*'])

/** Turn an arbitrary title into something safe to write to disk. */
export function safeFilename(value: string, fallback = 'download', maxLength = 80): string {
  const cleaned = [...oneLine(value)]
    .filter(char => !BANNED.has(char))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
  const base = cleaned.length > 0 ? cleaned : fallback
  return base.length > maxLength ? base.slice(0, maxLength).trim() : base
}

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'video/mpeg': 'mpeg',
  'video/x-msvideo': 'avi',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/json': 'json',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'text/csv': 'csv',
  'text/markdown': 'md',
}

export function extensionFor(mime: string | undefined, url?: string): string | undefined {
  if (mime) {
    const clean = mime.split(';')[0]?.trim().toLowerCase()
    const known = clean ? EXT_BY_MIME[clean] : undefined
    if (known) return known
    const subtype = clean?.split('/')[1]
    if (subtype && /^[a-z0-9]{1,5}$/.test(subtype)) return subtype
  }
  if (url) {
    try {
      const path = new URL(url).pathname
      const match = /\.([a-z0-9]{1,5})$/i.exec(path)
      if (match?.[1]) return match[1].toLowerCase()
    } catch {
      /* not a parseable url */
    }
  }
  return undefined
}

export function isImageMime(mime: string | undefined): boolean {
  return Boolean(mime?.toLowerCase().startsWith('image/'))
}

export function isVideoMime(mime: string | undefined): boolean {
  return Boolean(mime?.toLowerCase().startsWith('video/'))
}

export function isAudioMime(mime: string | undefined): boolean {
  return Boolean(mime?.toLowerCase().startsWith('audio/'))
}

export function isMediaMime(mime: string | undefined): boolean {
  return isImageMime(mime) || isVideoMime(mime) || isAudioMime(mime)
}

/** 9.4 MB/s — throughput reads better with a thin space before the unit. */
export function formatSpeed(bytesPerSecond: number | undefined): string {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '--'
  return `${formatBytes(bytesPerSecond)}/s`
}