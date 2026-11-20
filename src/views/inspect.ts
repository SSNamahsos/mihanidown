import {Sheet} from '../lib/sheet.js'
import {GLYPH, type Intent} from '../theme.js'
import {drawChrome, frame, rule, tierFor, type Chrome} from './frame.js'
import {button, buttonRow} from './ui.js'
import type {AppState, PlateState} from '../state.js'
import {clamp, formatBytes, formatDuration, formatEta, formatSpeed, oneLine} from '../lib/format.js'
import {renderPixels, type Renderer} from '../lib/media/ansi.js'
import {mediaInfoOf} from '../state.js'
import {shorten} from './home.js'

/**
 * 01 · PLATE
 *
 * The signature screen. The artwork sits on one side, the real measurements of
 * it on the other, and the format picker plus the action buttons sit underneath.
 * Every button is clickable, every format row is clickable, and the scrub bar
 * seeks on click.
 */
export function drawInspect(sheet: Sheet, chrome: Chrome, state: AppState, renderer: Renderer): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  const tier = tierFor(chrome.rows, chrome.cols)

  drawChrome(sheet, chrome, {
    stamp: state.rung ? state.rung.note : state.engine ? `${state.engine} engine` : '',
    hints: hintsFor(state),
    themeName: state.theme,
  })

  if (state.resolved?.kind === 'scrape') {
    drawScrape(sheet, chrome, state, x, w)
    return
  }

  const top = 4
  const bottom = chrome.rows - 9 // room for the button row above the footer
  const available = bottom - top

  if (tier === 'stack') {
    drawChoices(sheet, state, x, top, w, available)
    drawActionBar(sheet, state, x, chrome.rows - 8, w)
    return
  }

  const showSpec = tier === 'full'
  const specWidth = showSpec ? 28 : 0
  const gutter = showSpec ? 3 : 0
  const rightX = x + specWidth + gutter
  const rightW = w - specWidth - gutter

  // The picker gets a fixed share of the column; the plate takes what is left.
  // Both matter, so the split is a ratio rather than "whichever fits".
  const choicesH = clamp(Math.round(available * 0.4), 5, 12)
  const plateH = available - choicesH - 1

  if (showSpec) drawSpecSheet(sheet, state, x, top, specWidth, available)
  drawPlate(sheet, chrome, state, rightX, top, rightW, plateH, renderer)
  drawChoices(sheet, state, rightX, top + plateH + 1, rightW, choicesH)
  drawActionBar(sheet, state, x, bottom + 1, w)
}

/* ------------------------------------------------------------------ *
 * The action bar: the buttons that do the thing
 * ------------------------------------------------------------------ */

function drawActionBar(sheet: Sheet, state: AppState, x: number, y: number, w: number): void {
  const hasThumb = thumbnailUrl(state) !== undefined
  const buttons: {id: string; label: string; style?: {primary?: boolean; hovered?: boolean; muted?: boolean}}[] = [
    {id: 'btn:download', label: 'Download (Enter)', style: {primary: true}},
  ]
  if (hasThumb) {
    buttons.push({id: 'btn:thumb', label: 'Save thumbnail'})
    buttons.push({
      id: 'btn:thumb-toggle',
      label: `Thumbnail with video: ${state.saveThumbnail ? 'ON' : 'OFF'}`,
      style: {muted: !state.saveThumbnail},
    })
  }
  buttons.push({id: 'btn:folder', label: 'Open folder (^o)'})
  buttons.push({id: 'btn:back', label: 'Back (Esc)'})
  buttonRow(sheet, buttons, x, y, w)
}

/** The thumbnail url behind the current inspection, when there is one. */
export function thumbnailUrl(state: AppState): string | undefined {
  if (state.resolved?.kind === 'ytdlp') return state.resolved.probe.info.thumbnail
  if (state.resolved?.kind === 'scrape') return state.resolved.page.image
  return undefined
}

/* ------------------------------------------------------------------ *
 * The title block
 * ------------------------------------------------------------------ */

export function specFields(state: AppState): {label: string; value: string; intent?: Intent}[] {
  const info = mediaInfoOf(state)
  const fields: {label: string; value: string; intent?: Intent}[] = []

  if (state.resolved?.kind === 'direct') {
    const {remote} = state.resolved
    return [
      {label: 'title', value: remote.filename},
      {label: 'type', value: remote.contentType?.split(';')[0] ?? 'unknown'},
      {label: 'size', value: formatBytes(remote.contentLength), intent: 'measure'},
      {label: 'resume', value: remote.acceptRanges ? 'range requests' : 'single stream'},
      {label: 'host', value: hostOf(remote.finalUrl)},
      {label: 'route', value: 'direct fetch'},
    ]
  }

  if (info) {
    if (info.uploader ?? info.channel) fields.push({label: 'by', value: oneLine(info.uploader ?? (info.channel as string))})
    if (info.width && info.height) fields.push({label: 'frame', value: `${info.width}x${info.height}`})
    if (info.duration) fields.push({label: 'length', value: formatDuration(info.duration)})
    if (info.is_live) fields.push({label: 'state', value: 'live', intent: 'measure'})
    if (info.extractor) fields.push({label: 'site', value: info.extractor})
    const entries = info.entries?.length ?? 1
    if (entries > 1) fields.push({label: 'entries', value: String(entries), intent: 'measure'})
    if (info.age_limit && info.age_limit > 0) fields.push({label: 'access', value: `age ${info.age_limit}+`, intent: 'measure'})
  }

  fields.push({label: 'save to', value: shorten(state.outDir, 40)})
  return fields
}

/**
 * The title block: the subject across the top at full width, then measured
 * values in one column. Putting the title in the key/value grid would force it
 * into the same narrow slot as "1920x1080" and truncate the one thing you most
 * need to read.
 */
function drawSpecSheet(sheet: Sheet, state: AppState, x: number, y: number, w: number, h: number): void {
  sheet.box(x, y, w, h, 'rule')
  const inner = w - 4
  let row = y + 1

  const info = mediaInfoOf(state)
  const remoteTitle =
    state.resolved?.kind === 'direct' ? state.resolved.remote.filename : oneLine(info?.title ?? 'untitled')

  sheet.text(x + 2, row, 'VIDEO', 'mark', {bold: true})
  row += 1
  for (const line of wrapText(remoteTitle, inner, 3)) {
    if (row >= y + h - 3) break
    sheet.clip(x + 2, row, line, inner, 'ink')
    row += 1
  }
  if (row < y + h - 3) {
    sheet.hline(x + 2, row, inner, 'rule')
    row += 1
  }

  const labelW = 9
  for (const field of specFields(state)) {
    if (row >= y + h - 2) break
    sheet.text(x + 2, row, field.label, 'muted')
    sheet.clip(x + 2 + labelW, row, field.value, inner - labelW, field.intent ?? 'ink')
    row += 1
  }
}

/** Greedy wrap, so a long title reads as a title and not as a truncated slug. */
function wrapText(value: string, width: number, maxLines: number): string[] {
  if (value.length <= width) return [value]
  const words = value.split(/\s+/)
  const lines: string[] = []
  let line = ''
  let truncated = false

  for (const word of words) {
    const candidate = line.length === 0 ? word : `${line} ${word}`
    if (candidate.length <= width) {
      line = candidate
      continue
    }
    if (lines.length === maxLines - 1 && word.length <= width && lines.length + 1 >= maxLines) {
      // last line: try to squeeze the next word in, otherwise admit the cut
      if (candidate.length <= width) {
        line = candidate
        continue
      }
      truncated = true
      line = line.length > 0 ? line : word
      break
    }
    if (line.length > 0) lines.push(line)
    line = word.length > width ? `${word.slice(0, Math.max(1, width - 1))}...` : word
    if (lines.length >= maxLines) {
      truncated = true
      break
    }
  }
  if (line.length > 0 && lines.length < maxLines) lines.push(line)
  if (truncated) {
    const last = lines[maxLines - 1]
    if (last !== undefined) lines[maxLines - 1] = `${last.slice(0, Math.max(1, width - 1))}...`
  }
  return lines.length > 0 ? lines : ['...']
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url.slice(0, 24)
  }
}

/* ------------------------------------------------------------------ *
 * The plate
 * ------------------------------------------------------------------ */

function drawPlate(
  sheet: Sheet,
  chrome: Chrome,
  state: AppState,
  x: number,
  y: number,
  w: number,
  h: number,
  renderer: Renderer,
): void {
  sheet.box(x, y, w, h, 'rule')
  const plate = state.plate

  let source = plate.pixels
  if (plate.kind === 'strip' && plate.strip && plate.strip.frames.length > 0) {
    source = plate.strip.frames[Math.min(plate.frame, plate.strip.frames.length - 1)]
  }

  // Reserve the caption and scrub rows before sizing the artwork, or the last
  // line of text lands on the box border.
  const wantsScrub = plate.kind === 'strip' && (plate.strip?.frames.length ?? 0) > 1
  const caption = plate.caption ?? (plate.kind === 'still' ? 'thumbnail' : '')
  const captionRows = source && caption.length > 0 ? 1 : 0

  let gap = h >= 9 ? 1 : 0
  let scrubRows = wantsScrub ? 2 : 0
  let usable = h - 2 - gap - captionRows - scrubRows

  if (scrubRows > 0 && usable < 4) {
    scrubRows = 0
    usable = h - 2 - gap - captionRows
  }
  if (usable < 2) {
    gap = 0
    usable = h - 2 - captionRows - scrubRows
  }

  if (source && usable >= 2) {
    /*
     * Size the plate from the artwork's own aspect ratio rather than filling
     * the box. Filling it would mean cropping 20% off the top and bottom of a
     * 16:9 thumbnail; matching the ratio means the whole frame is on screen and
     * the box simply breathes around it.
     */
    const maxCols = Math.max(8, Math.floor((w - 6) / 2) * 2)
    const aspect = source.height > 0 ? source.width / source.height : 16 / 9
    let cols = Math.min(maxCols, 44)
    let cellRows = Math.round(cols / (2 * aspect))
    if (cellRows > usable) {
      cellRows = usable
      cols = Math.min(maxCols, Math.floor((cellRows * 2 * aspect) / 2) * 2)
    }
    cols = Math.max(6, cols)
    cellRows = Math.max(2, Math.min(cellRows, usable))

    const startX = x + Math.floor((w - cols) / 2)
    const startY = y + 1 + gap + Math.max(0, Math.floor((usable - cellRows) / 2))
    sheet.block(startX, startY, renderPixels(source, cols, cellRows, renderer), cellRows)

    let nextRow = startY + cellRows
    if (captionRows === 1) {
      sheet.clip(x + Math.floor((w - caption.length) / 2), nextRow, caption, w - 4, 'mark')
      nextRow += 1
    }
    if (wantsScrub && scrubRows > 0) drawScrub(sheet, plate, startX, nextRow, cols)
    return
  }

  // Nothing to draw — say why, in the middle of the empty plate.
  const note =
    plate.kind === 'loading'
      ? 'decoding...'
      : (plate.error ?? plate.empty ?? 'no artwork for this link')
  const row = y + Math.floor(h / 2)
  sheet.clip(x + 2, row, note, w - 4, plate.error ? 'bad' : 'muted')

  if (plate.kind === 'loading') {
    const barW = Math.max(4, Math.min(36, w - 10))
    const ratio = plate.expected > 0 ? clamp(plate.loaded / plate.expected, 0, 1) : 0
    const start = x + Math.floor((w - barW) / 2)
    sheet.repeat(start, row + 2, Math.floor(barW * ratio), GLYPH.block, 'accent')
    sheet.repeat(start + Math.floor(barW * ratio), row + 2, barW - Math.floor(barW * ratio), GLYPH.shade, 'muted')
    sheet.text(x + 2, row + 1, `frames ${plate.loaded}/${plate.expected || '?'}`, 'muted')
  }
}

function drawScrub(sheet: Sheet, plate: PlateState, x: number, y: number, width: number): void {
  const strip = plate.strip
  if (!strip || strip.frames.length === 0) return
  const total = strip.times.at(-1) ?? 0
  const position = strip.times[Math.min(plate.frame, strip.times.length - 1)] ?? 0
  const ratio = total > 0 ? clamp(position / total, 0, 1) : 0
  const markerX = x + clamp(Math.round(ratio * (width - 1)), 0, width - 1)

  sheet.repeat(x, y, width, GLYPH.h, 'muted')
  sheet.repeat(x, y, markerX - x, GLYPH.h, 'accent')
  sheet.put(markerX, y, GLYPH.pointer, 'measure', {bold: true})
  // The whole timeline is one region: clicking anywhere on it seeks.
  sheet.region('scrub', x, y, width, 1)

  const left = `${GLYPH.leftTri} ${formatDuration(position)}`
  const right = `${formatDuration(total)} ${GLYPH.pointer}`

  if (width >= left.length + right.length + 3) {
    sheet.text(x, y + 1, left, 'muted')
    sheet.text(x + width - right.length, y + 1, right, 'muted')
    const counter = `${plate.frame + 1}/${strip.frames.length}`
    const gap = width - left.length - right.length - counter.length - 2
    if (gap >= 2) sheet.text(x + left.length + Math.floor(gap / 2), y + 1, counter, 'mark')
    return
  }
  if (width >= right.length + 1) {
    sheet.text(x + width - right.length, y + 1, right, 'muted')
    return
  }
  sheet.clip(x, y + 1, `${position}s / ${total}s`, width, 'muted')
}

/* ------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------ */

function drawChoices(sheet: Sheet, state: AppState, x: number, y: number, w: number, h: number): void {
  sheet.box(x, y, w, h, 'rule')

  const rows = h - 3
  if (rows <= 0) {
    const note = state.choices.length > 0 ? 'Enter downloads - ? keys' : 'no formats offered'
    sheet.text(x + 2, y + 1, note, 'muted')
    return
  }

  if (state.choices.length === 0) {
    rule(sheet, x + 2, y + 1, w - 4, 'nothing found')
    sheet.text(x + 2, y + 3, 'the source offered no downloadable formats', 'muted')
    sheet.text(x + 2, y + 4, 'Esc back  -  ? keys', 'muted')
    return
  }

  rule(sheet, x + 2, y + 1, w - 4, 'formats  (up/down, 1-9, or click)')

  const choices = state.choices
  const maxRows = Math.min(rows - 1, choices.length)
  if (maxRows <= 0) return

  // Keep the cursor inside the window.
  let offset = state.listOffset
  if (state.selected < offset) offset = state.selected
  if (state.selected >= offset + maxRows) offset = state.selected - maxRows + 1
  offset = Math.max(0, Math.min(offset, Math.max(0, choices.length - maxRows)))

  for (let i = 0; i < maxRows; i++) {
    const index = offset + i
    const choice = choices[index]
    if (!choice) break
    drawChoiceRow(sheet, choice, index, y + 2 + i, x, w, index === state.selected)
  }

  if (choices.length > maxRows) {
    const counter = `${index0(offset)}-${index0(offset + maxRows - 1)} of ${choices.length}`
    sheet.clip(x + w - counter.length - 2, y + 1, counter, w - 4, 'muted')
  }
}

function index0(value: number): string {
  return String(value + 1).padStart(2, '0')
}

function drawChoiceRow(
  sheet: Sheet,
  choice: {kind: string; label: string; detail: [string, string, string]; estimate?: number},
  index: number,
  y: number,
  x: number,
  w: number,
  active: boolean,
): void {
  const intent: Intent = active ? 'select' : 'muted'
  const decor = active ? {bold: true} : undefined

  // Focus has to survive a terminal with no colour at all, so the pointer is a
  // shape and the label is bold, not just tinted.
  sheet.put(x + 2, y, active ? GLYPH.pointer : ' ', active ? 'accent' : 'rule', active ? {bold: true} : undefined)

  // The row number is a real key: press 1-9 to jump straight there.
  sheet.text(x + 4, y, String((index + 1) % 10), active ? 'accent' : 'muted', active ? {bold: true} : undefined)
  sheet.text(x + 6, y, glyphFor(choice.kind), kindIntent(choice.kind, active))

  const sizeText = choice.detail[2]
  const sizeW = Math.max(9, sizeText.length + 1)
  const right = x + w - 2
  const labelBudget = Math.max(6, right - sizeW - 21 - 10 - (x + 8))

  sheet.clip(x + 8, y, choice.label, labelBudget, intent, decor)

  // Three measured columns at fixed offsets so the digits line up down the list.
  sheet.clip(right - sizeW - 21, y, choice.detail[0], 11, active ? 'ink' : 'muted')
  sheet.clip(right - sizeW - 9, y, choice.detail[1], 8, active ? 'ink' : 'muted')
  sheet.text(right - sizeW, y, sizeText, active ? 'measure' : 'muted', active ? {bold: true} : undefined)
  sheet.region(`choice:${index}`, x, y, w, 1)
}

function glyphFor(kind: string): string {
  switch (kind) {
    case 'audio':
      return '\u266a'
    case 'image':
      return '\u2219'
    case 'file':
      return '\u00a7'
    default:
      return '\u25a0'
  }
}

function kindIntent(kind: string, active: boolean): 'accent' | 'measure' | 'mark' {
  if (active) return 'accent'
  if (kind === 'audio') return 'measure'
  return 'mark'
}

/* ------------------------------------------------------------------ *
 * Scrape fallback
 * ------------------------------------------------------------------ */

function drawScrape(sheet: Sheet, chrome: Chrome, state: AppState, x: number, w: number): void {
  const resolved = state.resolved
  if (!resolved || resolved.kind !== 'scrape') return
  const top = 4
  const available = chrome.rows - top - 9
  const headerH = clamp(Math.round(available * 0.3), 6, 12)

  sheet.box(x, top, w, headerH, 'rule')
  sheet.text(x + 2, top + 1, 'PAGE', 'mark', {bold: true})
  sheet.clip(x + 8, top + 1, resolved.page.title, w - 10, 'ink')
  if (resolved.page.description) {
    sheet.clip(x + 2, top + 3, resolved.page.description, w - 4, 'muted')
  }
  sheet.text(x + 2, top + headerH - 2, `${resolved.media.length} media found - no extractor claimed this url`, 'measure')

  drawChoices(sheet, state, x, top + headerH + 1, w, Math.max(3, available - headerH - 1))
  drawActionBar(sheet, state, x, chrome.rows - 8, w)
}

/* ------------------------------------------------------------------ *
 * Transfer, filed, failed
 * ------------------------------------------------------------------ */

export function drawTransfer(sheet: Sheet, chrome: Chrome, state: AppState): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  drawChrome(sheet, chrome, {
    stamp: state.rung?.note ?? '',
    hints: [
      {key: 'Esc', label: 'cancel'},
      {key: 'q', label: 'quit'},
    ],
    themeName: state.theme,
  })

  const transfer = state.transfer
  const top = Math.max(7, Math.floor(chrome.rows / 2) - 6)
  const inner = Math.min(w - 8, 74)
  const innerX = x + Math.floor((w - inner) / 2)

  if (!transfer) return

  sheet.clip(innerX, top, state.url, inner, 'muted')
  const chosen = chosenLabel(state)
  if (chosen !== state.url) sheet.clip(innerX, top + 1, chosen, inner, 'ink')

  const total = transfer.total ?? 0
  const ratio = total > 0 ? Math.min(1, transfer.received / total) : 0
  const barY = top + 4
  const filled = Math.floor(inner * ratio)

  sheet.repeat(innerX, barY, filled, GLYPH.block, 'accent')
  sheet.repeat(innerX + filled, barY, inner - filled, GLYPH.shade, 'muted')

  for (let i = 1; i < 10; i++) {
    sheet.put(innerX + Math.floor((inner * i) / 10), barY, GLYPH.bar, 'muted')
  }

  const percent = `${String(Math.floor(ratio * 100)).padStart(3, ' ')}%`
  const stats = [
    `${formatBytes(transfer.received)}${total > 0 ? ` / ${formatBytes(total)}` : ''}`,
    formatSpeed(transfer.speed),
    transfer.processing ? 'merging' : `${formatEta(transfer.eta)} left`,
  ]
  sheet.text(innerX, barY + 2, percent, 'measure', {bold: true})
  let cursor = innerX + 5
  for (const stat of stats) {
    sheet.text(cursor, barY + 2, stat, 'muted')
    cursor += stat.length + 3
    if (cursor > innerX + inner - 6) break
  }

  if (transfer.totalParts > 1) {
    sheet.text(innerX, barY + 4, `part ${transfer.part} of ${transfer.totalParts}`, 'mark')
  }

  if (transfer.processing) {
    sheet.clip(innerX, barY + 6, 'remuxing and writing to disk - the wait is ffmpeg, not the network', inner, 'muted')
  }

  button(sheet, 'btn:cancel', innerX, barY + 8, 'Cancel (Esc)', {muted: false})
}

export function drawFiled(sheet: Sheet, chrome: Chrome, state: AppState): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  const filed = state.filed
  drawChrome(sheet, chrome, {
    stamp: filed?.summary ?? '',
    hints: [
      {key: 'Enter', label: 'next link'},
      {key: 'Esc', label: 'back to formats'},
      {key: '^o', label: 'open folder'},
      {key: '^r', label: 'again'},
      {key: 'q', label: 'quit'},
    ],
    themeName: state.theme,
  })

  if (!filed) return
  const top = Math.max(7, Math.floor(chrome.rows / 2) - Math.min(6, filed.files.length))
  const inner = Math.min(w - 6, 78)
  const innerX = x + Math.floor((w - inner) / 2)

  const glyph = GLYPH.tick
  let row = top
  for (const file of filed.files.slice(0, 6)) {
    sheet.text(innerX, row, glyph, 'good', {bold: true})
    sheet.clip(innerX + 2, row, file, inner - 2, 'ink')
    row += 1
  }
  if (filed.files.length > 6) {
    sheet.text(innerX, row, `${GLYPH.bullet} ${filed.files.length - 6} more`, 'muted')
    row += 1
  }

  row += 1
  sheet.text(innerX, row, 'saved to', 'muted')
  sheet.clip(innerX + 10, row, shorten(state.outDir, inner - 10), inner - 10, 'measure')
  row += 1
  sheet.text(innerX, row, filed.summary, 'mark')

  for (const warning of filed.warnings.slice(0, 3)) {
    row += 1
    sheet.clip(innerX, row, `${GLYPH.bullet} ${warning}`, inner, 'measure')
  }

  buttonRow(
    sheet,
    [
      {id: 'btn:folder', label: 'Open folder (^o)', style: {primary: true}},
      {id: 'btn:next', label: 'Next link (Enter)'},
      {id: 'btn:back', label: 'Back to formats (Esc)'},
    ],
    innerX,
    row + 2,
    inner,
  )
}

export function drawFailed(sheet: Sheet, chrome: Chrome, state: AppState): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  const failure = state.failure
  drawChrome(sheet, chrome, {
    stamp: state.rung?.note ?? '',
    hints: [
      {key: '^r', label: 'retry'},
      {key: 'Esc', label: 'back'},
      {key: '^k', label: 'cookies'},
      {key: 'q', label: 'quit'},
    ],
    themeName: state.theme,
  })

  if (!failure) return
  const top = Math.max(6, Math.floor(chrome.rows / 2) - Math.min(8, chrome.rows / 3))
  const inner = Math.min(w - 6, 76)
  const innerX = x + Math.floor((w - inner) / 2)

  let row = top
  sheet.text(innerX, row, `${GLYPH.cross2}  `, 'bad', {bold: true})
  sheet.clip(innerX + 3, row, failure.diagnosis.message, inner - 3, 'bad', {bold: true})
  row += 2

  // The action is the part that matters, so it gets a box and as many lines as
  // it needs. Measure the wrap first: sizing the box from a character count
  // would under-count at word boundaries and spill the last line through the
  // border.
  const lines = wrapText(failure.diagnosis.action, inner - 4, 8)
  const actionRows = lines.length + 3
  sheet.box(innerX, row, inner, actionRows, 'rule')
  sheet.text(innerX + 2, row + 1, 'WHAT TO DO', 'mark', {bold: true})
  for (let i = 0; i < lines.length; i++) {
    sheet.clip(innerX + 2, row + 2 + i, lines[i] as string, inner - 4, 'ink')
  }
  row += actionRows + 1

  // Show the ladder we walked. Seeing which client got where is the difference
  // between "YouTube blocked us" and "this specific rung needs cookies".
  if (failure.attempts && failure.attempts.length > 0) {
    rule(sheet, innerX, row, inner, 'clients tried')
    row += 1
    for (const attempt of failure.attempts.slice(0, 7)) {
      sheet.text(innerX, row, `${attempt.client}  `, 'accent')
      sheet.clip(innerX + 16, row, attempt.error, inner - 16, 'muted')
      row += 1
    }
  }

  buttonRow(
    sheet,
    [
      {id: 'btn:retry', label: 'Retry (Enter)', style: {primary: true}},
      {id: 'btn:cookies', label: 'Cookies (^k)'},
      {id: 'btn:back', label: 'Back (Esc)'},
    ],
    innerX,
    row + 1,
    inner,
  )
}

function chosenLabel(state: AppState): string {
  const choice = state.choices[state.selected]
  if (!choice) return state.url
  const [geometry, codec, size] = choice.detail
  return [choice.label, geometry, codec, size].filter(Boolean).join('  -  ')
}

function hintsFor(state: AppState): {key: string; label: string}[] {
  const scrub = state.plate.kind === 'strip'
  return [
    {key: GLYPH.up + GLYPH.down, label: 'select'},
    {key: 'Enter', label: 'download'},
    ...(scrub ? [{key: GLYPH.left + GLYPH.arrow, label: 'scrub'}] : []),
    {key: '^r', label: 'refetch'},
    {key: 'Esc', label: 'back'},
    {key: '?', label: 'keys'},
  ]
}
