import React from 'react'
import {render} from 'ink'
import App from './app.js'
import {HELP, parseArgs} from './lib/args.js'
import {catalogueText, formatExtractors} from './lib/sites.js'
import {ensureYtDlp, run, findFfmpeg, defaultOutDir, findPoTokenProvider} from './lib/binaries.js'
import {MOUSE_OFF, MOUSE_ON} from './lib/mouse.js'
import {closeFront, detectFilter, ensureFront, frontArgsFor, type FrontMode} from './lib/front.js'
import {resolve as resolveUrl, asTarget, type Resolved} from './lib/router.js'
import {buildChoices, download as ytdlpDownload, type Choice, type Environment} from './lib/ytdlp.js'
import {downloadDirect, probeRemote, type Remote} from './lib/direct.js'
import {loadConfig, saveConfig} from './lib/config.js'
import {diagnose} from './lib/errors.js'
import {extensionFor, formatBytes, formatEta, formatSpeed, safeFilename} from './lib/format.js'
import type {ThemeName} from './theme.js'

const VERSION = '0.2.0'

/* ------------------------------------------------------------------ *
 * Alternate screen + cursor + pointer
 * ------------------------------------------------------------------ *
 *
 * The sheet takes the whole terminal and gives it back on exit with scrollback
 * intact. Without the alt buffer every frame would append and you would scroll
 * through a film of yourself downloading. Mouse reporting is enabled with the
 * same care: SGR encoding where the terminal supports it, and never left on
 * after exit, or the terminal keeps sending clicks as escape sequences to
 * whatever runs next.
 */
const ALT_ON = `\u001b[?1049h\u001b[?25l${MOUSE_ON}`
const ALT_OFF = `${MOUSE_OFF}\u001b[?25h\u001b[?1049l`

function enterFullscreen(): () => void {
  process.stdout.write(ALT_ON)
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.stdout.write(ALT_OFF)
  }
  process.on('exit', restore)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      restore()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
  return restore
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const {options, unknown} = parseArgs(argv)

  if (options.version) {
    process.stdout.write(`mihanidown ${VERSION}\n`)
    return
  }

  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }

  if (unknown.length > 0) {
    process.stderr.write(`mihanidown: ${unknown.join(', ')}\nRun \`mihanidown --help\`.\n`)
    process.exitCode = 2
    return
  }

  if (options.sites) {
    await printSites()
    return
  }

  if (options.poToken) {
    await explainPoToken()
    return
  }

  if (options.frontCheck) {
    await printFrontCheck()
    return
  }

  const config = await loadConfig()
  const theme: ThemeName = options.theme ?? config.theme ?? 'auto'
  // The save folder is where the terminal was opened, every session. -o wins
  // for this run; the picker changes it for this session only. It is
  // deliberately not persisted: "save where I am" is the contract, and a
  // folder remembered from yesterday would quietly break it.
  const outDir = options.outDir ?? defaultOutDir()
  const cookies = options.cookies ?? config.cookies

  await saveConfig({cookies, theme, ...(options.front ? {front: options.front} : {})})

  // A url plus a flag means do the whole thing without opening the sheet, so
  // mihanidown drops into a shell pipeline.
  const headless =
    options.url !== undefined &&
    (options.best || options.mp3 || options.quality !== undefined || options.probe)

  if (headless && options.url) {
    await runHeadless(options.url, {
      outDir,
      cookies,
      client: options.client,
      best: options.best,
      mp3: options.mp3,
      quality: options.quality,
      probe: options.probe,
      front: options.front,
    })
    return
  }

  /*
   * The sheet is interactive: it needs a terminal to draw on and raw mode to
   * read keys. Piped into a file, a CI job or `Start-Job`, Ink cannot get
   * either, and the honest thing to do is say so in a sentence rather than
   * dump a screenful of escape codes and an exception.
   *
   * Headless flags still work without a TTY, which is why this check sits after
   * the branch above.
   */
  if (!process.stdin.isTTY) {
    process.stderr.write(
      [
        'mihanidown: the sheet needs an interactive terminal.',
        '',
        '  stdin is not a terminal, so there is nowhere to draw the picker and',
        '  nowhere to read key presses from.',
        '',
        '  Run it directly:',
        '    mihanidown <url>                        the picker, in a real terminal',
        '    mihanidown <url> --best                no picker at all, works anywhere',
        '    mihanidown <url> --mp3                 audio only, works anywhere',
        '    mihanidown <url> -q 1080 --best        cap the height, no picker',
        '    mihanidown <url> -p                    print what was resolved, then exit',
        '',
      ].join('\n'),
    )
    process.exitCode = 1
    return
  }

  const restore = enterFullscreen()
  const instance = render(
    <App cliTheme={theme} cliUrl={options.url} cliOutDir={outDir} cliCookies={cookies} cliFront={options.front} />,
    {exitOnCtrlC: false},
  )
  await instance.waitUntilExit()
  restore()
}

/* ------------------------------------------------------------------ *
 * --sites
 * ------------------------------------------------------------------ */

async function printSites(): Promise<void> {
  process.stdout.write(catalogueText())
  try {
    const {bin} = await ensureYtDlp(() => undefined, {preferSystem: true})
    const {stdout} = await run(bin, ['--list-extractors'])
    const names = stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
    process.stdout.write(formatExtractors(names))
  } catch {
    process.stderr.write('yt-dlp is not available yet, so the live extractor list is missing.\n')
  }
}

/* ------------------------------------------------------------------ *
 * Scriptable mode
 * ------------------------------------------------------------------ */

type Headless = {
  outDir: string
  cookies?: string
  client?: string
  best: boolean
  mp3: boolean
  quality?: number
  probe: boolean
  front?: FrontMode
}

async function runHeadless(url: string, options: Headless): Promise<void> {
  const ffmpeg = await findFfmpeg()
  const {bin: ytdlp} = await ensureYtDlp(message => process.stderr.write(`${message}\n`), {preferSystem: true})
  const {front, report} = await ensureFront(options.front ?? 'auto')
  if (front) process.stderr.write(`\u001b[2mfront on: ${report?.detail}\u001b[0m\n`)
  // One normalised string for the probe, the front decision and the download, so
  // a search cannot resolve one video and fetch another.
  const target = asTarget(url)
  const env: Environment = {ytdlp, ffmpeg, cookies: options.cookies, forcedClient: options.client, frontArgs: frontArgsFor(front, target)}

  try {
    await transfer(url, env, options)
  } finally {
    await closeFront()
  }
}

async function transfer(url: string, env: Environment, options: Headless): Promise<void> {
  const resolved = await resolveUrl(url, env, {quality: options.quality}, {
    status: message => process.stderr.write(`\u001b[2m${message}\u001b[0m\n`),
  })

  if (resolved.kind === 'failed') {
    const d = diagnose(resolved.error, 'fetch', {frontOff: !env.frontArgs})
    process.stderr.write(`\n  ${d.message}\n  ${d.action}\n\n`)
    process.exitCode = 1
    return
  }

  if (options.probe) {
    printResolved(resolved)
    return
  }

  const choice = pick(resolved.choices, options)
  if (!choice) {
    process.stderr.write('nothing to fetch\n')
    process.exitCode = 1
    return
  }

  // Scraped rows are just urls, so they go through the direct engine; only
  // extractor output needs yt-dlp to do the fetching.
  if (resolved.kind === 'direct' || resolved.kind === 'scrape') {
    const url = resolved.kind === 'direct' ? resolved.remote.finalUrl : choice.sourceUrl
    if (!url) {
      process.stderr.write('that row has no url behind it\n')
      process.exitCode = 1
      return
    }
    const probed = await probeRemote(url)
    if (!probed.ok) {
      process.stderr.write(`  ${probed.error}\n`)
      process.exitCode = 1
      return
    }
    await transferDirect(probed.remote, options.outDir)
    return
  }

  const started = Date.now()
  let lastPaint = 0
  const outcome = await ytdlpDownload(
    {
      env,
      url: asTarget(url),
      rung: resolved.probe.rung,
      choice,
      outDir: options.outDir,
    },
    progress => {
      const now = Date.now()
      if (now - lastPaint < 250 && !progress.processing) return
      lastPaint = now
      if (progress.processing) {
        process.stderr.write('\r  remuxing\u2026'.padEnd(64))
        return
      }
      process.stderr.write(`\r${meter({received: progress.downloaded, total: progress.total, speed: progress.speed, eta: progress.eta})}`)
    },
  )
  process.stderr.write('\n')

  /*
   * The thumbnail rides along unless it was refused in the config. A failed
   * artwork fetch must never fail the download that already succeeded, so it
   * degrades to a note on stderr.
   */
  const files = [...outcome.files]
  const info = resolved.probe.info
  if (info.thumbnail && (await loadConfig()).saveThumbnail) {
    try {
      const probed = await probeRemote(info.thumbnail)
      if (probed.ok) {
        const ext = extensionFor(probed.remote.contentType, info.thumbnail) ?? 'jpg'
        const name = `${safeFilename(info.title ?? 'thumbnail', 'thumbnail')}.${ext}`
        const thumb = await downloadDirect({
          url: info.thumbnail,
          outDir: options.outDir,
          filename: name,
          remote: probed.remote,
        })
        files.push(thumb.file)
      }
    } catch (error) {
      process.stderr.write(`\u001b[2mthumbnail not saved: ${error instanceof Error ? error.message : String(error)}\u001b[0m\n`)
    }
  }

  for (const file of files) process.stdout.write(`${file}\n`)
  process.stdout.write(`\n  ${files.length} file(s) in ${((Date.now() - started) / 1000).toFixed(1)}s\n`)
}

async function transferDirect(remote: Remote, outDir: string): Promise<void> {
  let lastPaint = 0
  const result = await downloadDirect({
    url: remote.finalUrl,
    outDir,
    filename: remote.filename,
    remote,
    onProgress: p => {
      const now = Date.now()
      if (now - lastPaint < 250) return
      lastPaint = now
      process.stderr.write(`\r${meter({received: p.received, total: p.total, speed: p.speed, eta: p.eta})}`)
    },
  })
  process.stderr.write('\n')
  process.stdout.write(`${result.file}\n`)
}

/**
 * The transfer line, rewritten in place. Throughput and time left are the two
 * numbers worth watching while something is moving, so they sit on the bar rather
 * than in a summary that only arrives after it.
 */
type Meter = {received: number; total?: number; speed?: number; eta?: number}

function meter(done: Meter): string {
  const width = 28
  const ratio = done.total && done.total > 0 ? Math.min(1, done.received / done.total) : 0
  const filled = Math.floor(width * ratio)
  const bytes = `${formatBytes(done.received)}${done.total ? ` / ${formatBytes(done.total)}` : ''}`
  return `  ${'\u2588'.repeat(filled)}${'\u2591'.repeat(width - filled)}  ${String(Math.floor(ratio * 100)).padStart(3)}%  ${bytes}  ${formatSpeed(done.speed)}  ${formatEta(done.eta)} left`.padEnd(80)
}

function pick(choices: Choice[], options: Headless): Choice | undefined {
  if (choices.length === 0) return undefined
  if (options.mp3) return choices.find(c => c.kind === 'audio' && c.label.includes('mp3')) ?? choices.find(c => c.kind === 'audio') ?? choices[0]
  const videos = choices.filter(c => c.kind === 'video')
  if (options.quality !== undefined) {
    const exact = videos.find(c => c.detail[0].endsWith(`${options.quality}`))
    if (exact) return exact
    const below = videos.filter(c => {
      const height = Number.parseInt(c.detail[0].split('x')[1] ?? '0', 10)
      return height > 0 && height <= (options.quality as number)
    })
    if (below.length > 0) return below[0]
  }
  return videos[0] ?? choices[0]
}

function printResolved(resolved: Resolved): void {
  if (resolved.kind === 'direct') {
    const {remote} = resolved
    process.stdout.write(
      `\n  ${remote.filename}\n  ${remote.contentType ?? 'unknown type'}\n  ${formatBytes(remote.contentLength)}  ${remote.finalUrl}\n\n`,
    )
    return
  }
  if (resolved.kind === 'scrape') {
    process.stdout.write(`\n  ${resolved.page.title}\n`)
    for (const item of resolved.media.slice(0, 20)) {
      process.stdout.write(`  ${item.kind.padEnd(6)} ${item.url}\n`)
    }
    process.stdout.write('\n')
    return
  }
  const info = resolved.probe.info
  process.stdout.write(
    `\n  ${info.title ?? 'untitled'}\n  ${info.uploader ?? info.extractor ?? ''}\n  client: ${resolved.probe.rung.note}\n\n`,
  )
  for (const choice of buildChoices(info)) {
    process.stdout.write(`  ${choice.label.padEnd(28)} ${choice.detail.join('  ')}\n`)
  }
  process.stdout.write('\n')
}

/* ------------------------------------------------------------------ *
 * --po-token
 * ------------------------------------------------------------------ */

async function printFrontCheck(): Promise<void> {
  const config = await loadConfig()
  const mode = config.front ?? 'auto'
  const report = await detectFilter()

  process.stdout.write(`
  THE FRONT
  ===========

  Some governments filter YouTube by name instead of by address: the DNS answer
  is replaced with a block page, and any TLS handshake that names the site is cut
  off before the server can reply. The servers themselves are reachable. The front
  works inside that, from your own machine, without a VPN and without relaying
  your traffic to anybody else's server.

  This connection
  ---------------
    youtube name resolves to   ${report.dnsPoisoned ? 'a sinkhole, not the real answer' : 'the real answer'}
    hello naming youtube       ${report.sniReset ? 'cut off mid-handshake' : 'answered'}
    hello naming google        ${report.usable ? 'answered' : 'also cut off — the front cannot help here'}
    verdict                    ${report.blocked ? 'filtered — the front is what carries this' : 'not filtered by name'}
    configured                 front: ${mode}

  ${
    report.blocked
      ? `  Run mihanidown normally: \`front: auto\` turns the front on by itself.
  Force it with \`mihanidown --front on\`, or refuse it with \`--front off\`.`
      : `  Nothing to do. The front stays out of the way when the network answers.`
  }

  What it does not do
  -------------------
    It changes the name you ask under, not the country your packets come from. A
    video the uploader locked to one territory stays locked. It does not touch DRM,
    and it does not make you anonymous — your address is still the address YouTube
    sees, which is precisely why the download still works.

`)
  if (!report.usable) process.exitCode = 1
}

async function explainPoToken(): Promise<void> {
  const provider = await findPoTokenProvider()
  const deno = await hasCommand('deno')

  process.stdout.write(`
  PROOF-OF-ORIGIN TOKENS
  =======================

  YouTube withholds its top formats unless the request carries a PO token: a
  value its own JavaScript generates in a real browser, attesting that the
  request came from somewhere plausible. yt-dlp cannot compute one. bgutil is
  an open-source provider that runs exactly that JavaScript locally in Deno,
  so nothing leaves your machine.

  Current status
  --------------
    provider   ${provider ?? 'not installed'}
    deno       ${deno ? 'found' : 'not installed'}

  Setup
  -----
    curl -fsSL https://deno.land/install.sh | sh
    git clone https://github.com/Brainicism/bgutil-ytdlp-pot-provider
    cd bgutil-ytdlp-pot-provider && python3 -m server

  Then point mihanidown at it and restart:
    set BGUTIL_POT_PATH=<repo>/server.py

  Or run bgutil-pot as a local server; mihanidown finds it automatically:
    bgutil-pot

  Working without one
  -------------------
  mihanidown already leads with the \`tv\` player client, which answers 1080p with
  no token at all. The provider is how you reach past that on the formats
  YouTube serves only to browsers.

  Why a Cloudflare Worker is not the answer
  ------------------------------------------
  YouTube scores the address a request comes from, and Cloudflare's egress
  ranges are well known datacentre traffic. Relaying through a Worker raises
  your bot score rather than lowering it. A proxy also cannot mint a
  proof-of-origin token: that value comes from YouTube's obfuscated JavaScript
  running in a browser engine, which a Worker edge runtime is not.
`)
}

async function hasCommand(cmd: string): Promise<boolean> {
  try {
    const {code} = await run(cmd, ['--version'])
    return code === 0
  } catch {
    return false
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`\nmihanidown: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})

export {VERSION}