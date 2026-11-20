import assert from 'node:assert/strict'
import test from 'node:test'
import {Sheet, visibleWidth} from './sheet.js'
import {createStyleResolver} from '../theme.js'

const styles = createStyleResolver('dark', 24)
const plain = createStyleResolver('auto', 0)

// toLines returns coloured text; assertions about glyphs need it stripped.
// eslint-disable-next-line no-control-regex
const bare = (sheet: Sheet): string[] => sheet.toLines().map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))

test('text lands at the column it was given', () => {
  const sheet = new Sheet(20, 3, styles)
  sheet.text(4, 1, 'hi')
  const lines = bare(sheet)
  assert.equal(visibleWidth(lines[1] ?? ''), 20)
  assert.match(lines[1] ?? '', /^ {4}hi/)
})

test('clip adds an ellipsis rather than spilling', () => {
  const sheet = new Sheet(20, 1, styles)
  sheet.clip(0, 0, 'abcdefghij', 5)
  const line = bare(sheet)[0] ?? ''
  assert.equal(visibleWidth(line), 20)
  // 4 kept characters plus the ellipsis fill the 5-cell budget
  assert.match(line, /^abcd\u2026 {15}$/)
})

test('clip writes the value whole when it fits', () => {
  const sheet = new Sheet(10, 1, styles)
  sheet.clip(0, 0, 'abc', 5)
  assert.match(bare(sheet)[0] ?? '', /^abc {7}$/)
})

test('box draws closed corners and hairline walls', () => {
  const sheet = new Sheet(6, 3, styles)
  sheet.box(0, 0, 6, 3)
  const lines = bare(sheet)
  assert.match(lines[0] ?? '', /^\u250c\u2500{4}\u2510$/)
  assert.match(lines[1] ?? '', /^\u2502 {4}\u2502$/)
  assert.match(lines[2] ?? '', /^\u2514\u2500{4}\u2518$/)
})

test('every line is exactly the sheet width', () => {
  const sheet = new Sheet(37, 11, styles)
  sheet.grid('grid', 2)
  sheet.box(3, 2, 20, 6)
  sheet.text(4, 3, 'something')
  for (const line of sheet.toLines()) assert.equal(visibleWidth(line), 37)
})

test('grid only claims cells nothing else has taken', () => {
  const sheet = new Sheet(10, 4, styles)
  sheet.gridRegion(0, 0, 10, 4, 'grid', 2)
  sheet.text(0, 0, 'XXXXXXXXXX')
  const lines = bare(sheet)
  assert.equal(visibleWidth(lines[0] ?? ''), 10)
  assert.match(lines[0] ?? '', /^X{10}/)
  // row 2 was never written, so the lattice shows there: every other column
  assert.equal(visibleWidth(lines[2] ?? ''), 10)
  assert.match(lines[2] ?? '', /^\u00b7(?: \u00b7){4} $/)
})

test('grid spacing is measured from the region corner', () => {
  // A band starting on an odd row must still get a lattice. Spacing measured
  // from the sheet origin would print nothing at all here.
  const sheet = new Sheet(12, 3, styles)
  sheet.gridRegion(0, 1, 12, 2, 'grid', 2)
  const lines = bare(sheet)
  assert.equal(visibleWidth(lines[1] ?? ''), 12)
  assert.match(lines[1] ?? '', /^\u00b7(?: \u00b7){5} $/)
  assert.equal(visibleWidth(lines[2] ?? ''), 12)
  assert.equal(lines[0], ' '.repeat(12), 'the row above the band is untouched')
})

test('a pre-rendered block survives verbatim and keeps its neighbours', () => {
  const sheet = new Sheet(12, 1, styles)
  sheet.text(0, 0, 'ab')
  sheet.block(4, 0, '\u001b[38;2;1;2;3m\u2580\u001b[48;2;4;5;6m\u2580', 1)
  const line = sheet.toLines()[0] ?? ''
  // the block's own escapes are not re-derived from cells, or the truecolour
  // foreground/background pair would be lost
  assert.ok(line.includes('\u001b[38;2;1;2;3m\u2580'))
  assert.ok(line.includes('\u001b[48;2;4;5;6m\u2580'))
  assert.equal(visibleWidth(line), 12)
  assert.match(bare(sheet)[0] ?? '', /^ab {2}\u2580\u2580 {6}$/)
})

test('labelledRule centres its label in a break between two rules', () => {
  const sheet = new Sheet(21, 1, styles)
  sheet.labelledRule(0, 0, 21, 'choose')
  const line = bare(sheet)[0] ?? ''
  assert.equal(visibleWidth(line), 21)
  assert.ok(line.includes('choose'), 'label is written plain')
  // the gap either side of the label is intentional: the rule breaks for it
  assert.match(line, /^\u2500+ choose \u2500+$/)
})

test('auto theme leans on attributes so hierarchy survives with no colour', () => {
  const sheet = new Sheet(10, 1, plain)
  sheet.text(0, 0, 'a', 'muted')
  sheet.text(1, 0, 'b', 'title')
  const line = sheet.toLines()[0] ?? ''
  assert.ok(line.includes('\u001b[2m'), 'muted maps to dim')
  assert.ok(line.includes('\u001b[1m'), 'title maps to bold')
  // no palette of our own, so nothing is emitted as a colour
  assert.ok(!line.includes('\u001b[38;2;'))
})

test('writing outside the sheet is ignored, not fatal', () => {
  const sheet = new Sheet(4, 2, styles)
  sheet.text(-3, 0, 'nope')
  sheet.text(0, 9, 'nope')
  sheet.text(99, 0, 'nope')
  assert.equal(sheet.toLines().length, 2)
})

test('clipping to zero width writes nothing', () => {
  const sheet = new Sheet(4, 1, styles)
  sheet.clip(2, 0, 'abc', 0)
  assert.equal(visibleWidth(bare(sheet)[0] ?? ''), 4)
})

test('cellAt exposes cells so overlays can knock out what is beneath', () => {
  const sheet = new Sheet(4, 2, styles)
  sheet.text(1, 1, 'ab')
  for (let col = 1; col <= 2; col++) {
    const cell = sheet.cellAt(col, 1)
    assert.ok(cell)
    cell.char = ' '
  }
  assert.match(bare(sheet)[1] ?? '', /^ {4}$/)
})