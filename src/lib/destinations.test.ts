import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {expandDestination, roots, startDir} from './destinations.js'

const windows = process.platform === 'win32'

test('a bare drive letter becomes that drive\'s root', {skip: !windows}, () => {
  assert.equal(expandDestination('d'), 'D:\\')
  assert.equal(expandDestination('D:'), 'D:\\')
  assert.equal(expandDestination('c:\\'), 'C:\\')
})

test('anything else is taken literally', () => {
  assert.equal(expandDestination('/mnt/nas/films'), '/mnt/nas/films')
})

test('a full path with a drive is not rewritten', {skip: !windows}, () => {
  assert.equal(expandDestination('D:\\Videos\\2026'), 'D:\\Videos\\2026')
})

test('the default save folder is where the app was opened', () => {
  assert.equal(startDir(), process.cwd())
})

test('the picker offers the folder the app was opened from, first', async () => {
  const list = await roots()
  assert.ok(list.length >= 1)
  assert.equal(list[0]?.label, 'this folder')
  assert.equal(list[0]?.dir, process.cwd())
  assert.ok(list.some(r => r.dir.length > 0))
  // Every entry has to be somewhere the app can actually write.
  for (const root of list) assert.ok(path.isAbsolute(root.dir), root.dir)
})
