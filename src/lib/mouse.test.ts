import test from 'node:test'
import assert from 'node:assert/strict'
import {createMouseParser, parseMouse, MOUSE_ON, MOUSE_OFF} from './mouse.js'

test('SGR press decodes to a 0-based cell', () => {
  // terminal reports col 45 row 12 (1-based) -> cell 44,11
  const event = parseMouse('\u001b[<0;45;12M')
  assert.ok(event)
  assert.equal(event.kind, 'down')
  assert.equal(event.button, 0)
  assert.equal(event.col, 44)
  assert.equal(event.row, 11)
})

test('SGR release has kind up', () => {
  const event = parseMouse('\u001b[<0;45;12m')
  assert.ok(event)
  assert.equal(event.kind, 'up')
})

test('SGR wheel up and down', () => {
  const up = parseMouse('\u001b[<64;10;5M')
  assert.ok(up)
  assert.equal(up.kind, 'wheel')
  assert.equal(up.wheel, -1)
  const down = parseMouse('\u001b[<65;10;5M')
  assert.ok(down)
  assert.equal(down.kind, 'wheel')
  assert.equal(down.wheel, 1)
})

test('SGR motion is a move, and never a click', () => {
  const event = parseMouse('\u001b[<35;10;5M')
  assert.ok(event)
  assert.equal(event.kind, 'move')
})

test('Ink strips the leading ESC: the bare form parses too', () => {
  const event = parseMouse('[<0;12;3M')
  assert.ok(event)
  assert.equal(event.col, 11)
  assert.equal(event.row, 2)
})

test('X10 payload in one chunk decodes from +32 offsets', () => {
  // button 0, col 40, row 9 -> bytes 32, 72, 41
  const event = parseMouse('\u001b[M\u0020\u0048\u0029')
  assert.ok(event)
  assert.equal(event.kind, 'down')
  assert.equal(event.col, 40)
  assert.equal(event.row, 9)
})

test('X10 payload split across events is collected by the stateful parser', () => {
  const parser = createMouseParser()
  // Ink's tokenizer breaks ESC[M and the three payload bytes into four events.
  assert.equal(parser.parse('[M'), null)
  const a = parser.parse(' ')
  assert.equal(a, null)
  const b = parser.parse('H')
  assert.equal(b, null)
  const c = parser.parse(')')
  assert.ok(c)
  assert.equal(c.kind, 'down')
  assert.equal(c.col, 40)
  assert.equal(c.row, 9)
})

test('typing is never mistaken for mouse input', () => {
  assert.equal(parseMouse('a'), null)
  assert.equal(parseMouse('['), null)
  assert.equal(parseMouse('[ok]'), null)
  assert.equal(parseMouse('\u001b[A'), null) // up arrow, ink's business
})

test('drag motion with a button held is a move', () => {
  const event = parseMouse('\u001b[<32;20;20M')
  assert.ok(event)
  assert.equal(event.kind, 'move')
})

test('the enable/disable pairs are inverse mode sets', () => {
  assert.match(MOUSE_ON, /\u001b\[\?1000h/)
  assert.match(MOUSE_ON, /\u001b\[\?1006h/)
  assert.match(MOUSE_OFF, /\u001b\[\?1000l/)
  assert.match(MOUSE_OFF, /\u001b\[\?1006l/)
})
