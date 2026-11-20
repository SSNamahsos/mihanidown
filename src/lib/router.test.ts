import test from 'node:test'
import assert from 'node:assert/strict'
import {asTarget, isHttpUrl} from './router.js'

test('a link is left alone', () => {
  for (const url of [
    'https://www.youtube.com/watch?v=abc',
    'http://example.com/film.mp4',
    'https://i.ytimg.com/vi/abc/hqdefault.jpg',
  ]) {
    assert.equal(asTarget(url), url)
  }
})

test('a bare host gets the scheme people leave off', () => {
  assert.equal(asTarget('youtube.com/watch?v=abc'), 'https://youtube.com/watch?v=abc')
  assert.equal(asTarget('example.com'), 'https://example.com')
})

test('words become a youtube search', () => {
  assert.equal(asTarget('lamar jackson top 100'), 'ytsearch1:lamar jackson top 100')
  assert.equal(asTarget('big buck bunny'), 'ytsearch1:big buck bunny')
  // A single word is still more likely a title than a host with no dot.
  assert.equal(asTarget('rickroll'), 'ytsearch1:rickroll')
})

test('empty stays empty, so nothing is fetched', () => {
  assert.equal(asTarget('   '), '')
})

test('only real links count as links', () => {
  assert.equal(isHttpUrl('https://a.test'), true)
  assert.equal(isHttpUrl('a.test'), false)
  assert.equal(isHttpUrl('some video title'), false)
  assert.equal(isHttpUrl('ytsearch1:some video title'), false)
})
