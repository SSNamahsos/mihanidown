import assert from 'node:assert/strict'
import test from 'node:test'
import {formatBytes, formatDuration, formatEta, formatSpeed, safeFilename, oneLine, extensionFor} from './format.js'

test('formatBytes scales to readable units', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(999), '999 B')
  assert.equal(formatBytes(1000), '1.0 KB')
  assert.equal(formatBytes(1_500_000), '1.5 MB')
  // under 100 keeps a decimal, at or above rounds — the columns stop jittering
  assert.equal(formatBytes(94_200_000), '94.2 MB')
  assert.equal(formatBytes(312_000_000), '312 MB')
  assert.equal(formatBytes(undefined), '--')
})

test('formatDuration pads seconds, promotes to hours only when needed', () => {
  assert.equal(formatDuration(0), '0:00')
  assert.equal(formatDuration(9), '0:09')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3725), '1:02:05')
  assert.equal(formatDuration(undefined), '--:--')
})

test('formatEta caps rather than printing an hour', () => {
  assert.equal(formatEta(6.4), '0:06')
  assert.equal(formatEta(undefined), '--')
  assert.equal(formatEta(99_999), '99:59+')
})

test('formatSpeed appends a rate', () => {
  assert.equal(formatSpeed(8_240_000), '8.2 MB/s')
  assert.equal(formatSpeed(0), '--')
})

test('safeFilename strips separators, control characters and dot runs', () => {
  assert.equal(safeFilename('a/b\\c:d*e?f"g<h>i|j'), 'abcdefghi j'.replace(' ', ''))
  assert.equal(safeFilename('../../etc/passwd'), 'etcpasswd')
  assert.equal(safeFilename('  ...  '), 'download')
  assert.equal(safeFilename('normal title.mp4'), 'normal title.mp4')
  assert.ok(safeFilename('x'.repeat(200)).length <= 80)
})

test('oneLine flattens newlines that would break a single-row render', () => {
  assert.equal(oneLine('a\nb\tc'), 'a b c')
  assert.equal(oneLine('a\u0000b'), 'a b')
})

test('extensionFor prefers mime, falls back to the path, then gives up', () => {
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('video/mp4; codecs=avc1'), 'mp4')
  assert.equal(extensionFor(undefined, 'https://x.test/a/b.PNG'), 'png')
  assert.equal(extensionFor(undefined, 'https://x.test/noext'), undefined)
  // an unknown subtype is not worth guessing at: appending it could produce a
  // filename the wrong extension entirely
  assert.equal(extensionFor('application/x-made-up'), undefined)
})