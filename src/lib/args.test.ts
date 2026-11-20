import assert from 'node:assert/strict'
import test from 'node:test'
import {parseArgs} from './args.js'

test('a bare url is the url', () => {
  const {options, unknown} = parseArgs(['https://youtu.be/abc'])
  assert.equal(options.url, 'https://youtu.be/abc')
  assert.deepEqual(unknown, [])
})

test('no arguments leaves everything undefined so the saved config wins', () => {
  const {options} = parseArgs([])
  assert.equal(options.url, undefined)
  assert.equal(options.theme, undefined)
  assert.equal(options.best, false)
})

test('inline and separated values both parse', () => {
  assert.equal(parseArgs(['--theme=light']).options.theme, 'light')
  assert.equal(parseArgs(['--theme', 'dark']).options.theme, 'dark')
  assert.equal(parseArgs(['-t', 'light']).options.theme, 'light')
  assert.equal(parseArgs(['-oC:/tmp/a']).options.outDir, 'C:/tmp/a')
  assert.equal(parseArgs(['-o', 'C:/tmp/a']).options.outDir, 'C:/tmp/a')
})

test('a bad theme is reported rather than guessed', () => {
  const {unknown} = parseArgs(['--theme', 'neon'])
  assert.match(unknown.join(' '), /auto, light or dark/)
})

test('a flag that needs a value says so instead of eating the next url', () => {
  const {unknown} = parseArgs(['--cookies'])
  assert.match(unknown.join(' '), /needs a value/)
})

test('cookies are validated against real browsers', () => {
  assert.equal(parseArgs(['--cookies', 'FIREFOX']).options.cookies, 'firefox')
  assert.match(parseArgs(['--cookies', 'netscape']).unknown.join(' '), /--cookies must be one of/)
})

test('quality must be a positive number', () => {
  assert.equal(parseArgs(['-q', '720']).options.quality, 720)
  assert.match(parseArgs(['-q', 'tall']).unknown.join(' '), /positive number/)
})

test('unknown flags are collected, not swallowed', () => {
  const {unknown} = parseArgs(['--wat', 'https://x.test', '--also-wat'])
  assert.deepEqual(unknown, ['--wat', '--also-wat'])
})

test('a url containing dashes is not read as flags', () => {
  const {options} = parseArgs(['https://x.test/a-b-c'])
  assert.equal(options.url, 'https://x.test/a-b-c')
})

test('-- ends flag parsing', () => {
  const {options} = parseArgs(['--best', '--', '--not-a-flag'])
  assert.equal(options.best, true)
  assert.equal(options.url, '--not-a-flag')
})

test('catalog and token flags are recognised', () => {
  assert.equal(parseArgs(['--sites']).options.sites, true)
  assert.equal(parseArgs(['--po-token']).options.poToken, true)
  assert.equal(parseArgs(['--probe']).options.probe, true)
})