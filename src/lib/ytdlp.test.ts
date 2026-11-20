import assert from 'node:assert/strict'
import test from 'node:test'
import {buildChoices, codecLabel, parseLine, newParseState, type MediaInfo} from './ytdlp.js'
import {diagnose} from './errors.js'
import {renderPixels, pickRenderer, toBlocks} from './media/ansi.js'
import {fit, pixels, type Pixels} from './media/decode.js'

/* ------------------------------------------------------------------ *
 * Choices
 * ------------------------------------------------------------------ */

const youtube: MediaInfo = {
  title: 'test',
  formats: [
    {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, tbr: 4500, filesize: 60_000_000},
    {format_id: '248', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080, width: 1920, tbr: 4000, filesize: 50_000_000},
    {format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 720, width: 1280, tbr: 2000, filesize: 20_000_000},
    {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 130, filesize: 8_000_000},
    {format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 360, width: 640, tbr: 700, filesize: 12_000_000},
  ],
}

test('one row per height, tallest first, mp4 preferred at equal heights', () => {
  const choices = buildChoices(youtube)
  const videos = choices.filter(c => c.kind === 'video')
  assert.equal(videos[0]?.label, '1080p · mp4')
  assert.equal(videos[0]?.detail[1], 'h264')
  assert.equal(videos[1]?.label, '720p · mp4')
  // the only pre-merged stream here is 360p, and nothing else covers that
  // height, so it is offered — as a one-file row, since there is no split
  // alternative and adding the audio track would be fiction
  const low = choices.find(c => c.label.startsWith('360p'))
  assert.ok(low, '360p is still worth offering when nothing else reaches it')
  assert.equal(low?.detail[1], 'no merge')
  assert.equal(low?.estimate, 12_000_000)

  // and the heights that do have split streams must not also carry a muxed row
  const heights = choices.filter(c => c.kind === 'video').map(c => c.label.split('p')[0])
  assert.equal(new Set(heights).size, heights.length, 'exactly one row per height')
})

test('a pre-merged stream is fetched in one file when no split stream covers its height', () => {
  const info: MediaInfo = {
    formats: [
      {format_id: '18', ext: 'mp4', vcodec: 'avc1.42001E', acodec: 'mp4a.40.2', height: 720, width: 1280, tbr: 2000, filesize: 20_000_000},
      {format_id: '136', ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none', height: 480, width: 854, tbr: 900, filesize: 6_000_000},
      {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 4_000_000},
    ],
  }
  const choices = buildChoices(info)
  const hd = choices.find(c => c.label.startsWith('720p'))
  assert.ok(hd, 'the pre-merged 720p should be offered')
  assert.deepEqual(hd.detail.slice(0, 2), ['1280x720', 'no merge'])
  // the whole file, audio already inside — not the file plus the audio again
  assert.equal(hd.estimate, 20_000_000)
  assert.deepEqual(hd.args, ['-f', '18'])
})

test('a pre-merged stream does not duplicate a height a split stream covers', () => {
  const info: MediaInfo = {
    formats: [
      {format_id: '137', ext: 'mp4', vcodec: 'avc1.640028', acodec: 'none', height: 1080, width: 1920, tbr: 4500, filesize: 60_000_000},
      {format_id: '22', ext: 'mp4', vcodec: 'avc1.64001F', acodec: 'mp4a.40.2', height: 1080, width: 1920, tbr: 1200, filesize: 22_000_000},
      {format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 4_000_000},
    ],
  }
  const choices = buildChoices(info)
  const at1080 = choices.filter(c => c.label.startsWith('1080p'))
  assert.equal(at1080.length, 1, 'one row per height, split preferred')
  assert.equal(at1080[0]?.detail[1], 'h264')
  assert.equal(at1080[0]?.estimate, 64_000_000)
})

test('estimates add the audio track to a video-only stream', () => {
  const choices = buildChoices(youtube)
  const hd = choices.find(c => c.label === '1080p · mp4')
  assert.equal(hd?.estimate, 68_000_000)
})

test('audio rows are always offered, mp3 first', () => {
  const audio = buildChoices(youtube).filter(c => c.kind === 'audio')
  assert.equal(audio.length, 2)
  assert.match(audio[0]?.label ?? '', /mp3/)
  assert.deepEqual(audio[0]?.args.slice(0, 3), ['-f', 'ba/b', '-x'])
  assert.match(audio[1]?.label ?? '', /source audio/)
})

test('every detail cell fits its column so nothing truncates on screen', () => {
  for (const choice of buildChoices(youtube)) {
    assert.ok(choice.detail[0].length <= 11, `geometry too wide: ${choice.detail[0]}`)
    assert.ok(choice.detail[1].length <= 8, `codec too wide: ${choice.detail[1]}`)
    assert.ok(choice.detail[2].length <= 9, `size too wide: ${choice.detail[2]}`)
  }
})

test('a quality cap keeps only rows at or below it', () => {
  const choices = buildChoices(youtube, 720)
  const heights = choices.filter(c => c.kind === 'video').map(c => Number.parseInt(c.label, 10))
  assert.ok(heights.every(h => h <= 720))
})

test('a cap below every available height still returns something', () => {
  const choices = buildChoices(youtube, 144)
  assert.ok(choices.filter(c => c.kind === 'video').length > 0)
})

test('an audio-only source yields audio rows, not video rows', () => {
  const info: MediaInfo = {
    formats: [{format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, filesize: 5_000_000}],
  }
  const choices = buildChoices(info)
  assert.ok(choices.every(c => c.kind === 'audio'))
})

test('a source with no formats at all still produces one row', () => {
  // kind is inferred from the extension: an image url can arrive with no format
  // list at all and should still be presented as an image
  const choices = buildChoices({title: 'x', ext: 'jpg', filesize: 1234})
  assert.equal(choices.length, 1)
  assert.equal(choices[0]?.kind, 'image')
})

test('codecLabel collapses the long codec strings yt-dlp emits', () => {
  assert.equal(codecLabel('avc1.640028'), 'h264')
  assert.equal(codecLabel('hev1.2.6.L120.90'), 'h265')
  assert.equal(codecLabel('vp09.00.50.08'), 'vp9')
  assert.equal(codecLabel('vp9'), 'vp9')
  assert.equal(codecLabel('vp8'), 'vp8')
  assert.equal(codecLabel('av01.0.08M.08'), 'av1')
  assert.equal(codecLabel('none'), '')
  assert.equal(codecLabel(undefined), '')
})

/* ------------------------------------------------------------------ *
 * The stdout parser — where the meter's numbers come from
 * ------------------------------------------------------------------ */

test('the progress line becomes numbers, not a frozen bar', () => {
  const state = newParseState()
  const parsed = parseLine('MHDL|15000000|60000000|60000000|7500000|6', state)
  assert.equal(parsed?.type, 'progress')
  const progress = parsed?.type === 'progress' ? parsed.progress : undefined
  assert.equal(progress?.downloaded, 15_000_000)
  assert.equal(progress?.total, 60_000_000)
  assert.equal(progress?.speed, 7_500_000)
  assert.equal(progress?.eta, 6)
})

test('total falls back to the estimate when the real length is unknown', () => {
  const state = newParseState()
  const parsed = parseLine('MHDL|1000|NA|60000000|100|10', state)
  const progress = parsed?.type === 'progress' ? parsed.progress : undefined
  assert.equal(progress?.total, 60_000_000)
})

test('a restarting byte counter means a second file, not a rewind', () => {
  const state = newParseState()
  parseLine('[youtube] abc: Downloading 2 format(s): 137+140', state)
  parseLine('MHDL|60000000|60000000|60000000|8000000|0', state)
  const second = parseLine('MHDL|2000000|4000000|4000000|2000000|1', state)
  const progress = second?.type === 'progress' ? second.progress : undefined
  assert.equal(progress?.part, 1)
  assert.equal(progress?.totalParts, 2)
})

test('the format-count line sets how many files to expect', () => {
  const state = newParseState()
  assert.equal(parseLine('[youtube] abc: Downloading 3 format(s): 137+140+251', state), null)
  assert.equal(state.totalParts, 3)
})

test('merge and remux lines are recognised and their targets kept for cleanup', () => {
  const state = newParseState()
  assert.equal(parseLine('[Merger] Merging formats into "C:/out/Clip.mp4"', state)?.type, 'phase')
  assert.equal(parseLine('[ExtractAudio] Destination: C:/out/Clip.mp3', state)?.type, 'phase')
  assert.deepEqual([...state.written], ['C:/out/Clip.mp4', 'C:/out/Clip.mp3'])
})

test('download destinations and final filepaths are recorded', () => {
  const state = newParseState()
  assert.equal(parseLine('[download] Destination: C:/out/Clip.f137.mp4', state)?.type, 'destination')
  assert.ok(state.written.has('C:/out/Clip.f137.mp4'))
  assert.equal(parseLine('C:/out/Clip.mp4', state)?.type, 'file')
})

test('warnings are surfaced rather than swallowed by --no-quiet', () => {
  const state = newParseState()
  const warning = parseLine('WARNING: [youtube] abc: Some formats are missing a URL', state)
  assert.equal(warning?.type, 'warning')
  assert.match(warning?.type === 'warning' ? warning.text : '', /missing a URL/)
})

test('chatty non-progress output is ignored instead of throwing', () => {
  const state = newParseState()
  for (const line of ['', '   ', '[info] abc: Downloading webpage', '[download]  50.0% of 60.00MiB']) {
    assert.doesNotThrow(() => parseLine(line, state))
  }
})

/* ------------------------------------------------------------------ *
 * Error diagnosis
 * ------------------------------------------------------------------ */

test('the bot check points at cookies, which is the thing that fixes it', () => {
  const d = diagnose('ERROR: [youtube] abc: Sign in to confirm you are not a bot.', 'fetch')
  assert.match(d.message, /not a bot/)
  assert.match(d.action, /cookies/i)
})

test('members-only content says what to actually do about it', () => {
  const d = diagnose('ERROR: [youtube] abc: Join this channel', 'fetch')
  assert.match(d.message, /members-only/)
  assert.match(d.action, /cookies/i)
})

test('a cut-off handshake points at the front, not at the network', () => {
  // Both strings are verbatim from yt-dlp on a filtered connection: the Windows
  // build reports 10054, the OpenSSL one an EOF inside the record layer.
  const windows = diagnose(
    "ERROR: [youtube] abc: Unable to download API page: ('Connection aborted.', ConnectionResetError(10054, 'An existing connection was forcibly closed by the remote host', None, 10054, None))",
    'fetch',
    {frontOff: true},
  )
  assert.match(windows.action, /--front/, windows.action)
  const openssl = diagnose('ERROR: [youtube] abc: Unable to download webpage: EOF occurred in violation of protocol (_ssl.c:1007)', 'fetch', {frontOff: true})
  assert.match(openssl.action, /--front/, openssl.action)
})

test('a geo-lock is the uploader, not the filter, and says so', () => {
  const d = diagnose('ERROR: [youtube] abc: Video unavailable. This video is not available in your country', 'fetch')
  assert.equal(d.retryable, false)
  assert.match(d.message, /locked/i)
  assert.match(d.action, /stays locked|only a connection/i)
})

test('DRM is refused outright rather than retried', () => {
  const d = diagnose('ERROR: [youtube] abc: This video is DRM protected', 'download')
  assert.equal(d.retryable, false)
  assert.match(d.message, /DRM/)
})

test('a removed video is terminal, not retryable', () => {
  const d = diagnose('ERROR: [youtube] abc: Video unavailable', 'fetch')
  assert.equal(d.recoverable, false)
  assert.equal(d.retryable, false)
})

test('a 403 stays retryable, a 404-ish removal does not', () => {
  assert.equal(diagnose('ERROR: unable to download: HTTP Error 403: Forbidden', 'download').retryable, true)
  assert.equal(diagnose('ERROR: Video unavailable. This video has been removed', 'download').retryable, false)
})

test('an unknown error still says something and offers a way forward', () => {
  const d = diagnose('ERROR: [youtube] abc: something new and unrecognised', 'fetch')
  assert.ok(d.message.length > 0)
  assert.match(d.action, /\^r|\^q/)
})

test('a PO-Token warning is distinguished from a hard failure', () => {
  const d = diagnose('WARNING: [youtube] Some web client https formats have been skipped as missing a URL', 'fetch')
  assert.match(d.message, /proof-of-origin/i)
})

/* ------------------------------------------------------------------ *
 * The plate
 * ------------------------------------------------------------------ */

function solid(width: number, height: number, r: number, g: number, b: number): Pixels {
  return pixels(width, height, new Uint8Array(width * height * 3).fill(0).map((_, i) => [r, g, b][i % 3] as number))
}

test('fit samples to the cell grid, not the pixel grid', () => {
  const source = solid(1920, 1080, 10, 20, 30)
  // two pixel rows per cell row, so a 24-cell plate needs 48 rows of pixels
  const fitted = fit(source, 40, 48)
  assert.equal(fitted.width, 40)
  assert.equal(fitted.height, 48)
  assert.equal(fitted.data.length, 40 * 48 * 3)
})

test('fit centre-crops rather than stretching', () => {
  const source = pixels(10, 10)
  // mark the four corners so a crop is detectable
  for (const [x, y] of [[0, 0], [9, 0], [0, 9], [9, 9]] as const) {
    const o = (y * 10 + x) * 3
    source.data[o] = 255
  }
  const square = fit(source, 10, 5)
  const wide = fit(source, 40, 5)
  assert.equal(square.width, 10)
  assert.equal(wide.width, 40)
  // a wider target must not invent pixels outside the source
  for (const value of wide.data) assert.ok(value === 0 || value === 255)
})

test('toBlocks emits one half-block per cell with a truecolour pair', () => {
  const rendered = toBlocks(solid(4, 2, 255, 0, 0), 4, 1)
  assert.equal(rendered.split('\n').length, 1)
  assert.equal([...rendered].filter(c => c === '\u2580').length, 4)
  assert.ok(rendered.includes('\u001b[38;2;255;0;0m'))
  assert.ok(rendered.includes('\u001b[48;2;255;0;0m'))
})

test('identical pixels collapse into one escape pair', () => {
  const rendered = toBlocks(solid(20, 2, 1, 2, 3), 20, 1)
  assert.equal(rendered.split('\u001b[38;2;1;2;3m').length - 1, 1)
  assert.equal(rendered.split('\u001b[48;2;1;2;3m').length - 1, 1)
})

test('renderPixels produces the requested grid for both renderers', () => {
  const source = solid(64, 36, 200, 100, 50)
  for (const mode of ['blocks', 'ascii'] as const) {
    const rendered = renderPixels(source, 30, 10, mode)
    assert.equal(rendered.split('\n').length, 10, mode)
    for (const line of rendered.split('\n')) {
      // eslint-disable-next-line no-control-regex
      assert.equal(line.replace(/\u001b\[[0-9;]*m/g, '').length, 30, mode)
    }
  }
})

test('no colour support degrades to ascii rather than blank output', () => {
  assert.equal(pickRenderer(0, true), 'none')
  assert.equal(pickRenderer(8, true), 'blocks')
  assert.equal(pickRenderer(24, true), 'blocks')
  // 8 colours but no unicode half-blocks: ascii still beats nothing
  assert.equal(pickRenderer(8, false), 'ascii')
  const source = solid(8, 8, 255, 255, 255)
  assert.equal(renderPixels(source, 8, 4, 'none'), '')
  assert.ok(renderPixels(source, 8, 4, 'ascii').length > 0)
})