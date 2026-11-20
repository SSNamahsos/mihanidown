import {Sheet} from '../lib/sheet.js'
import {GLYPH} from '../theme.js'
import {drawChrome, frame, rule, type Chrome} from './frame.js'
import {buttonRow, statusLine} from './ui.js'
import type {AppState} from '../state.js'
import os from 'node:os'
import path from 'node:path'

/**
 * 00 · INTAKE
 *
 * One job: get a url in. A field, a Fetch button, where files will land, and
 * the recent list. Everything on the screen is either information you asked
 * for or a button you can click.
 */
export function drawHome(sheet: Sheet, chrome: Chrome, state: AppState): void {
  const {x, w} = frame(chrome.cols, chrome.rows)
  drawChrome(sheet, chrome, {
    stamp: state.frontOn ? 'front on' : state.poToken ? 'proof ready' : statusStamp(state),
    hints: [
      {key: 'Enter', label: 'fetch'},
      {key: GLYPH.up + GLYPH.down, label: 'history'},
      {key: '^t', label: 'theme'},
      {key: '^f', label: 'save to'},
      {key: 'q', label: 'quit'},
    ],
    themeName: state.theme,
  })

  if (state.phase === 'boot') {
    drawBoot(sheet, chrome, state, x, w)
    return
  }

  const fieldWidth = Math.min(w - 4, 76)
  const fieldX = x + Math.floor((w - fieldWidth) / 2)

  const showHistory = state.history.length > 0 && chrome.rows >= 26
  const contentHeight = (showHistory ? Math.min(state.history.length, 4) + 4 : 0) + 14
  const topLimit = 6
  const bottomLimit = chrome.rows - 7
  const bodyTop = Math.max(topLimit, topLimit + Math.floor((bottomLimit - topLimit - contentHeight) / 2))

  // Hero line. One sentence, in the user's terms.
  sheet.text(fieldX, bodyTop, 'paste a video link, or type words to search', 'title', {bold: true})

  // The field
  const fieldY = bodyTop + 2
  sheet.box(fieldX, fieldY, fieldWidth, 3, 'rule')
  const browsing = state.historyCursor >= 0
  const shown = browsing ? (state.history[state.historyCursor] ?? '') : state.url
  const prompt = browsing ? 'from history: ' : '> '
  const promptIntent = browsing ? 'measure' : 'accent'
  const after = sheet.text(fieldX + 2, fieldY + 1, prompt, promptIntent, {bold: !browsing})
  const inner = fieldWidth - 4
  sheet.clip(after, fieldY + 1, shown, Math.max(0, inner - 1), 'ink')
  if (!browsing) {
    // a block caret, not a bar: it reads as an insertion point on the sheet
    const caretX = Math.min(fieldX + fieldWidth - 3, after + Math.max(0, Math.min(state.url.length, inner - 1)))
    sheet.put(caretX, fieldY + 1, GLYPH.block, 'accent', {bold: true})
  } else {
    sheet.text(fieldX + fieldWidth - 7, fieldY + 1, `${state.historyCursor + 1}/${state.history.length}`, 'muted')
  }
  sheet.region('field', fieldX, fieldY, fieldWidth, 3)

  // Ghost hint when the field is empty — show a real example, not lorem.
  if (state.url.length === 0 && state.history.length === 0 && !browsing) {
    sheet.clip(after, fieldY + 1, 'https://youtube.com/watch?v=...  or  some video title', Math.max(0, inner - 1), 'muted')
  }

  // Buttons
  const buttonY = fieldY + 5
  const usedRows = buttonRow(
    sheet,
    [
      {id: 'btn:fetch', label: 'Fetch (Enter)', style: {primary: true}},
      {id: 'btn:save', label: 'Save to... (^f)'},
      {id: 'btn:cookies', label: 'Cookies (^k)'},
      {id: 'btn:theme', label: `Theme: ${state.theme} (^t)`},
      {id: 'btn:quit', label: 'Quit (q)'},
    ],
    fieldX,
    buttonY,
    fieldWidth,
  )

  // Where the file will land, and what can do the fetching.
  let row = buttonY + usedRows + 1
  rule(sheet, fieldX, row, fieldWidth, 'setup')
  row += 1
  statusLine(sheet, fieldX, row, fieldWidth, 'saving to', shorten(state.outDir, fieldWidth - 14), 'measure')
  sheet.region('btn:save', fieldX, row, fieldWidth, 1)
  row += 1
  const engine = [
    `yt-dlp ${state.ytdlpVersion}`,
    state.ffmpeg ? 'ffmpeg ready' : 'ffmpeg missing (no merging, no mp3)',
    state.frontOn ? 'front on' : 'front ready',
  ].join('  ' + GLYPH.bullet + '  ')
  statusLine(
    sheet,
    fieldX,
    row,
    fieldWidth,
    'engine',
    engine,
    engine.includes('missing') ? 'bad' : 'ink',
  )

  // Recent
  if (showHistory) {
    row += 2
    rule(sheet, fieldX, row, fieldWidth, 'recent  (click to reuse, Enter to fetch)')
    row += 1
    const budget = Math.max(1, Math.min(state.history.length, bottomLimit - row - 1))
    const start = Math.max(0, Math.min(state.history.length - budget, state.historyCursor - Math.floor(budget / 2)))
    for (let i = 0; i < budget; i++) {
      const entry = state.history[start + i]
      if (entry === undefined) break
      const index = start + i
      const active = index === state.historyCursor
      const prefix = `${String(index + 1).padStart(2, '0')}  `
      sheet.text(fieldX, row, prefix, active ? 'accent' : 'muted', {bold: active})
      sheet.clip(fieldX + 5, row, entry, fieldWidth - 5, active ? 'accent' : 'muted', active ? {underline: true} : undefined)
      sheet.region(`hist:${index}`, fieldX, row, fieldWidth, 1)
      row += 1
    }
  }
}

function statusStamp(state: AppState): string {
  return state.theme === 'auto' ? '' : `theme: ${state.theme}`
}

function drawBoot(sheet: Sheet, chrome: Chrome, state: AppState, x: number, w: number): void {
  const fieldWidth = Math.min(w - 4, 76)
  const fieldX = x + Math.floor((w - fieldWidth) / 2)
  const top = Math.max(7, Math.floor(chrome.rows / 2) - 4)

  sheet.text(fieldX, top, 'paste a video link, or type words to search', 'title', {bold: true})
  sheet.box(fieldX, top + 2, fieldWidth, 3, 'rule')

  /*
   * The three real dependencies, in the order they resolve. Spacing is measured
   * from each label rather than fixed, because the labels differ in width and
   * a fixed pitch would run the last one into the edge.
   */
  const steps = ['yt-dlp', 'ffmpeg', 'po-token']
  const detail = state.bootDetail.toLowerCase()
  const current = steps.findIndex(step => detail.includes(step))
  const done = current === -1 ? steps.length : current

  let col = fieldX + 2
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i] as string
    const isDone = i < done
    const isCurrent = i === current
    const glyph = isDone ? GLYPH.tick : isCurrent ? GLYPH.block : GLYPH.shade
    const intent = isDone ? 'good' : isCurrent ? 'accent' : 'muted'
    sheet.put(col, top + 6, glyph, intent, {bold: isCurrent})
    sheet.text(col + 2, top + 6, step, isCurrent ? 'ink' : 'muted', isCurrent ? {bold: true} : undefined)
    col += step.length + 6
  }

  sheet.clip(fieldX, top + 8, state.bootDetail || state.boot, fieldWidth, 'muted')
}

export function shorten(value: string, max: number): string {
  if (value.length <= max) return value
  const home = os.homedir()
  const withTilde = value.startsWith(home) ? `~${value.slice(home.length)}` : value
  if (withTilde.length <= max) return withTilde
  const tail = withTilde.slice(-(max - 3))
  return `...${tail}`
}
