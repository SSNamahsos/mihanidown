/**
 * Dev harness: check the engines that can be checked without a network —
 * the stdout parser, the ladder the probe would walk, and the routing decision
 * for a url that fails everywhere. Not part of the bundle.
 *
 *   npx tsx scripts/smoke.ts
 */
import path from 'node:path'
import {parseLine, newParseState, buildChoices, codecLabel, type MediaInfo} from '../src/lib/ytdlp.js'
import {diagnose} from '../src/lib/errors.js'
import {resolve} from '../src/lib/router.js'
import type {Environment} from '../src/lib/ytdlp.js'

/* ------------------------------------------------------------------ *
 * 1. the stdout parser
 * ------------------------------------------------------------------ */

console.log('--- parseLine ---')
const state = newParseState()
const feed = (line: string) => parseLine(line, state)

const lines = [
  '[youtube] abc: Downloading 2 format(s): 137+140',
  'MHDL|0|60000000|60000000|0|NA',
  'MHDL|15000000|60000000|60000000|7500000|6',
  'MHDL|60000000|60000000|60000000|8000000|0',
  'MHDL|0|4000000|4000000|2000000|2',
  'MHDL|4000000|4000000|4000000|2000000|0',
  '[Merger] Merging formats into "C:/out/Clip.mp4"',
  'WARNING: [youtube] Some formats are missing a URL',
  'C:/out/Clip.mp4',
  '',
  '[download] 100% of 60.00MiB at 8.00MiB/s ETA 00:00',
]

for (const line of lines) {
  const parsed = feed(line)
  if (!parsed) continue
  switch (parsed.type) {
    case 'progress':
      console.log(
        `  progress  ${(parsed.progress.downloaded / 1e6).toFixed(1)}MB / ${((parsed.progress.total ?? 0) / 1e6).toFixed(1)}MB` +
          `  ${parsed.progress.speed ? `${(parsed.progress.speed / 1e6).toFixed(1)}MB/s` : '--'}` +
          `  part ${parsed.progress.part + 1}/${parsed.progress.totalParts}`,
      )
      break
    case 'phase':
      console.log('  phase     ', parsed.target)
      break
    case 'file':
      console.log('  file      ', parsed.file)
      break
    case 'warning':
      console.log('  warning   ', parsed.text)
      break
    default:
      console.log('  other     ', JSON.stringify(parsed))
  }
}
console.log('  tracked for cleanup:', [...state.written].join(', ') || '(none)')

/* ------------------------------------------------------------------ *
 * 2. the picker on a realistic probe result
 * ------------------------------------------------------------------ */

console.log('\n--- choices ---')
const info: MediaInfo = {
  title: 'Real Video',
  uploader: 'Someone',
  duration: 3725,
  width: 1920,
  height: 1080,
  extractor: 'Youtube',
  formats: [
    {format_id: '401', ext: 'mp4', vcodec: 'av01.0.12M.08', acodec: 'none', height: 2160, width: 3840, tbr: 18_000, filesize: 300_000_000},
    {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, tbr: 4_500, filesize: 60_000_000},
    {format_id: '248', ext: 'webm', vcodec: 'vp09.00.50.08', acodec: 'none', height: 1080, width: 1920, tbr: 4_000, filesize: 52_000_000},
    {format_id: '22', ext: 'mp4', vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', height: 720, width: 1280, tbr: 1_500, filesize: 24_000_000},
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 130, filesize: 8_000_000},
  ],
}
for (const choice of buildChoices(info)) {
  console.log(`  ${choice.label.padEnd(24)} ${choice.detail[0].padEnd(10)} ${choice.detail[1].padEnd(8)} ${choice.detail[2].padEnd(9)} ${choice.estimate ? `${(choice.estimate / 1e6).toFixed(1)}MB` : '--'}`)
}
console.log('  codecs:', ['av01.0.12M.08', 'avc1.640028', 'vp09.00.50.08', 'hev1.1.6.L93', 'mp4a.40.2', 'none'].map(codecLabel).join(' '))

/* ------------------------------------------------------------------ *
 * 3. a binary that cannot start, and a url that fails every rung
 * ------------------------------------------------------------------ */

console.log('\n--- failure paths ---')
// A .cmd shim is the realistic EINVAL case: Node will not spawn it directly and
// we do not use `shell: true` because the url travels through these arguments.
const shim: Environment = {ytdlp: path.join(process.cwd(), 'tools', 'yt-dlp.cmd')}
const outcome = await resolve('https://example.invalid/watch?v=abc', shim, {}, {
  status: message => console.log(`  status: ${message}`),
})

if (outcome.kind === 'failed') {
  console.log(`  attempts recorded: ${outcome.attempts.length}`)
  console.log(`  first attempt   : ${outcome.attempts[0]?.error.slice(0, 120)}`)
  const d = diagnose(outcome.error, 'fetch')
  console.log(`  says            : ${d.message}`)
} else {
  console.log(`  kind            : ${outcome.kind}`)
  for (const attempt of (outcome as {attempts?: unknown[]}).attempts ?? []) console.log('   ', JSON.stringify(attempt))
}