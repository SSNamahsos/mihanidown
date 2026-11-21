import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Box, Text, useApp, useInput} from 'ink'
import {Sheet, type Region} from './lib/sheet.js'
import {createStyleResolver, type StyleResolver, type ThemeName} from './theme.js'
import {drawHome} from './views/home.js'
import {drawFailed, drawFiled, drawInspect, drawTransfer, thumbnailUrl} from './views/inspect.js'
import {drawChrome, frame, type Chrome} from './views/frame.js'
import {drawCookiesMenu, drawSaveMenu} from './views/overlay.js'
import {drawHelpMenu} from './views/keys.js'
import type {AppState, Transfer} from './state.js'
import {mediaInfoOf} from './state.js'
import {resolve as resolveUrl, asTarget, type Resolved} from './lib/router.js'
import {download as ytdlpDownload, cancelActive, type Choice, type Environment, type Progress} from './lib/ytdlp.js'
import {downloadDirect, fileSize, probeRemote, type Remote} from './lib/direct.js'
import {decodeImage, type Pixels} from './lib/media/decode.js'
import {buildFilmstrip} from './lib/media/filmstrip.js'
import {pickRenderer, type Renderer} from './lib/media/ansi.js'
import {diagnose} from './lib/errors.js'
import {loadConfig, loadHistory, rememberUrl, saveConfig} from './lib/config.js'
import {defaultOutDir, resolveBinaries, type BinaryStatus} from './lib/binaries.js'
import {closeFront, ensureFront, frontArgsFor, type Front, type FrontMode} from './lib/front.js'
import {prepare, roots} from './lib/destinations.js'
import {extensionFor, formatBytes, safeFilename} from './lib/format.js'
import {readClipboard} from './lib/clipboard.js'
import {openFolder} from './lib/open.js'
import {BROWSERS, type Browser} from './lib/browsers.js'
import {MOUSE_OFF, MOUSE_ON, createMouseParser, type MouseEvent as PointerEvent} from './lib/mouse.js'

export type Props = {
  cliTheme: ThemeName
  cliUrl?: string
  cliOutDir?: string
  cliCookies?: string
  cliFront?: FrontMode
}

const SPINNER = ['\u280b', '\u2819', '\u2839', '\u2838']

export default function App({cliTheme, cliUrl, cliOutDir, cliCookies, cliFront}: Props): React.JSX.Element {
  const {exit} = useApp()

  const [state, setState] = useState<AppState>(() => ({
    phase: 'boot',
    theme: cliTheme,
    cols: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
    colorDepth: detectColorDepth(),
    boot: 'starting',
    bootDetail: 'reading configuration',
    url: cliUrl ?? '',
    history: [],
    historyCursor: -1,
    status: '',
    choices: [],
    selected: 0,
    listOffset: 0,
    plate: {kind: 'none', frame: 0, loaded: 0, expected: 0},
    outDir: cliOutDir ?? defaultOutDir(),
    cookies: cliCookies,
    hover: '',
    saveThumbnail: true,
    poToken: false,
    ytdlpVersion: 'checking',
    frontMode: 'auto',
    frontOn: false,
    frontDetail: '',
    cookiesMenu: false,
    cookiesCursor: 0,
    saveMenu: false,
    saveCursor: 0,
    roots: [],
    helpMenu: false,
  }))

  const patch = useCallback((next: Partial<AppState>) => {
    setState(prev => ({...prev, ...next}))
  }, [])

  // Async work reads state through a ref so it never closes over a stale copy.
  const stateRef = useRef(state)
  stateRef.current = state

  const binRef = useRef<BinaryStatus | null>(null)
  const frontRef = useRef<Front | null>(null)
  const fetchAbort = useRef<AbortController | null>(null)
  const stripAbort = useRef<AbortController | null>(null)
  /** Clickable rectangles of the frame currently on screen. */
  const regionsRef = useRef<readonly Region[]>([])
  /** Decodes pointer bytes into events; stateful because of X10 payloads. */
  const mouseParser = useMemo(() => createMouseParser(), [])
  const lastClick = useRef<{id: string; at: number}>({id: '', at: 0})

  /* ---------------------------------------------------------------- *
   * Geometry
   * ---------------------------------------------------------------- */

  useEffect(() => {
    const measure = () => patch({cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24})
    measure()
    process.stdout.on('resize', measure)
    return () => {
      process.stdout.off('resize', measure)
    }
  }, [patch])

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()

    void (async () => {
      const config = await loadConfig()
      if (cancelled) return

      // Where files land is where the terminal was opened; only -o moves it
      // before the user does. Never persisted, never remembered.
      const outDir = cliOutDir ?? defaultOutDir()
      const cookies = cliCookies ?? config.cookies
      patch({
        outDir,
        cookies,
        saveThumbnail: config.saveThumbnail,
        cookiesCursor: Math.max(0, BROWSERS.indexOf((cookies ?? '') as Browser)),
        history: await loadHistory(),
        ytdlpVersion: 'fetching',
        bootDetail: 'fetching yt-dlp',
      })

      const mode = cliFront ?? config.front ?? 'auto'
      // Measuring the connection costs about a third of a second and only matters
      // before the first fetch, so it runs alongside the binary hunt rather than
      // after it. The sheet is drawn with the answer already in it either way.
      const [binaries, outcome] = await Promise.all([
        resolveBinaries(message => patch({bootDetail: message}), {}, controller.signal),
        ensureFront(mode),
      ])
      if (cancelled) return
      binRef.current = binaries
      frontRef.current = outcome.front

      // A link already on the clipboard is a better first draft than an empty
      // field, so use it when the user launched bare.
      let url = cliUrl ?? ''
      if (!url) {
        const clipboard = await readClipboard()
        if (/^https?:\/\/\S+$/i.test(clipboard)) url = clipboard.trim()
      }

      if (cancelled) return
      await saveConfig({cookies, theme: cliTheme, ...(cliFront ? {front: cliFront} : {})})
      patch({
        phase: 'home',
        boot: 'ready',
        bootDetail: 'ready',
        url,
        ffmpeg: binaries.ffmpeg,
        poToken: Boolean(binaries.poTokenProvider),
        ytdlpVersion: binaries.ytdlpVersion,
        frontMode: mode,
        frontOn: Boolean(outcome.front),
        frontDetail: outcome.report?.detail ?? '',
        notice: outcome.front
          ? {text: 'front on: this connection filters youtube by name', intent: 'good'}
          : mode !== 'off' && outcome.report && !outcome.report.usable
            ? {text: `front unavailable: ${outcome.report.detail}`, intent: 'bad'}
            : undefined,
      })
    })()

    return () => {
      cancelled = true
      controller.abort()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const quit = useCallback(() => {
    cancelActive()
    stripAbort.current?.abort()
    fetchAbort.current?.abort()
    // The front is a pair of loopback listeners. Close them, but never let a
    // socket that refuses to shut down hold the terminal open.
    void Promise.race([closeFront(), new Promise(resolve => setTimeout(resolve, 250))]).then(() => exit())
  }, [exit])

  /* ---------------------------------------------------------------- *
   * The plate
   * ---------------------------------------------------------------- */

  const loadPlate = useCallback(
    async (resolved: Resolved, env: Environment) => {
      stripAbort.current?.abort()
      const controller = new AbortController()
      stripAbort.current = controller

      patch({plate: {kind: 'loading', frame: 0, loaded: 0, expected: 0}})

      // Frames arrive one at a time, so the plate fills in as ffmpeg decodes
      // rather than blinking in after the whole strip is built.
      const onFrame = (frames: Pixels[], duration: number) => {
        if (frames.length === 0) return
        patch({
          plate: {
            kind: 'strip',
            strip: {
              frames,
              times: frames.map((_, i) => (duration > 0 ? (i / frames.length) * duration : 0)),
              width: 100,
              height: 100,
            },
            frame: 0,
            loaded: frames.length,
            expected: Math.max(32, frames.length),
          },
        })
      }

      try {
        if (resolved.kind === 'direct') {
          const {remote} = resolved
          const mime = remote.contentType ?? ''

          // A remote video can be sampled before a single byte is stored —
          // ffmpeg seeks with range requests, so this costs almost nothing.
          if (mime.startsWith('video/') && env.ffmpeg) {
            const strip = await buildFilmstrip({
              source: remote.finalUrl,
              isUrl: true,
              ffmpeg: env.ffmpeg,
              signal: controller.signal,
              onFrame,
            })
            if (strip) {
              patch({plate: {kind: 'strip', strip, frame: 0, loaded: strip.frames.length, expected: strip.frames.length}})
              return
            }
          }

          const pixels = await decodeImage({source: remote.finalUrl, isUrl: true, ffmpeg: env.ffmpeg, signal: controller.signal})
          if (pixels) {
            patch({
              plate: {kind: 'still', pixels, frame: 0, loaded: 1, expected: 1, caption: remote.filename},
            })
            return
          }
          patch({plate: {kind: 'none', frame: 0, loaded: 0, expected: 0, empty: `${mime || 'binary'} \u2014 nothing to draw`}})
          return
        }

        if (resolved.kind === 'ytdlp') {
          const info = resolved.probe.info
          if (!info.thumbnail) {
            patch({plate: {kind: 'none', frame: 0, loaded: 0, expected: 0, empty: 'no artwork published for this url'}})
            return
          }
          const pixels = await decodeImage({
            source: info.thumbnail,
            isUrl: true,
            ffmpeg: env.ffmpeg,
            signal: controller.signal,
          })
          if (pixels) {
            patch({
              plate: {
                kind: 'still',
                pixels,
                frame: 0,
                loaded: 1,
                expected: 1,
                caption: info.duration ? `thumbnail \u00b7 ${clock(info.duration)} long` : 'thumbnail',
              },
            })
            return
          }
          patch({plate: {kind: 'none', frame: 0, loaded: 0, expected: 0, empty: 'thumbnail could not be decoded'}})
          return
        }

        const image = resolved.media.find(m => m.kind === 'image')
        if (image) {
          const pixels = await decodeImage({
            source: image.url,
            isUrl: true,
            ffmpeg: env.ffmpeg,
            signal: controller.signal,
          })
          if (pixels) {
            patch({plate: {kind: 'still', pixels, frame: 0, loaded: 1, expected: 1, caption: image.label}})
            return
          }
        }
        patch({plate: {kind: 'none', frame: 0, loaded: 0, expected: 0, empty: 'page published no artwork'}})
      } catch (error) {
        if (controller.signal.aborted) return
        patch({
          plate: {
            kind: 'none',
            frame: 0,
            loaded: 0,
            expected: 0,
            error: error instanceof Error ? error.message : 'preview unavailable',
          },
        })
      }
    },
    [patch],
  )

  /* ---------------------------------------------------------------- *
   * Fetch
   * ---------------------------------------------------------------- */

  const fetchUrl = useCallback(
    async (raw: string) => {
      const url = raw.trim()
      const binaries = binRef.current
      if (!binaries || url.length === 0) return

      fetchAbort.current?.abort()
      const controller = new AbortController()
      fetchAbort.current = controller

      const current = stateRef.current
      const env: Environment = {
        ytdlp: binaries.ytdlp,
        ffmpeg: binaries.ffmpeg,
        poTokenProvider: binaries.poTokenProvider,
        deno: binaries.deno,
        cookies: current?.cookies,
        frontArgs: frontArgsFor(frontRef.current, asTarget(url)),
      }

      patch({
        phase: 'resolving',
        status: 'fetching',
        url,
        choices: [],
        selected: 0,
        listOffset: 0,
        resolved: undefined,
        failure: undefined,
        filed: undefined,
      })

      try {
        const resolved = await resolveUrl(url, env, {}, {
          status: message => patch({status: message}),
          signal: controller.signal,
        })
        if (controller.signal.aborted) return

        if (resolved.kind === 'failed') {
          patch({
            phase: 'failed',
            status: '',
            failure: {diagnosis: diagnose(resolved.error, 'fetch', {frontOff: !frontRef.current}), attempts: resolved.attempts},
          })
          return
        }

        patch({
          phase: 'inspect',
          resolved,
          engine: resolved.kind,
          choices: resolved.choices,
          rung: resolved.kind === 'ytdlp' ? resolved.probe.rung : undefined,
          warning: resolved.kind === 'ytdlp' ? resolved.warning : undefined,
          status: '',
        })

        void rememberUrl(url).then(() => loadHistory().then(history => patch({history})))
        void loadPlate(resolved, env)
      } catch (error) {
        if (controller.signal.aborted) return
        patch({phase: 'failed', status: '', failure: {diagnosis: diagnose(message(error), 'fetch', {frontOff: !frontRef.current})}})
      }
    },
    [loadPlate, patch],
  )

  /* ---------------------------------------------------------------- *
   * Transfer
   * ---------------------------------------------------------------- */

  const emit = useCallback(
    (transfer: Transfer) => {
      patch({transfer})
    },
    [patch],
  )

  /* ---------------------------------------------------------------- *
   * Thumbnails
   * ---------------------------------------------------------------- */

  /**
   * Fetch the artwork of the inspected link into the output folder. Used as
   * the standalone "Save thumbnail" action and as the automatic companion
   * download when the thumbnail toggle is on. The fetch goes through the
   * front when the link is a filtered name, like every other request here.
   */
  const fetchThumbnail = useCallback(
    async (source: string, title: string, outDir: string): Promise<string> => {
      const probed = await probeRemote(source)
      if (!probed.ok) throw new Error(probed.error)
      const ext = extensionFor(probed.remote.contentType, source) ?? 'jpg'
      const name = `${safeFilename(title || 'thumbnail', 'thumbnail')}.${ext}`
      const result = await downloadDirect({
        url: source,
        outDir,
        filename: name,
        remote: probed.remote,
      })
      return result.file
    },
    [],
  )

  /** The "Save thumbnail" button: artwork only, no media download. */
  const saveThumbnailNow = useCallback(async () => {
    const current = stateRef.current
    const source = thumbnailUrl(current)
    if (!source) {
      patch({notice: {text: 'no thumbnail published for this link', intent: 'muted'}})
      return
    }
    const info = mediaInfoOf(current)
    const title = current.resolved?.kind === 'ytdlp' ? (info?.title ?? 'thumbnail') : 'thumbnail'
    try {
      const file = await fetchThumbnail(source, title, current.outDir)
      patch({notice: {text: `thumbnail saved: ${file.split(/[\\/]/).at(-1)}`, intent: 'good'}})
    } catch (error) {
      patch({notice: {text: `thumbnail failed: ${message(error)}`, intent: 'bad'}})
    }
  }, [fetchThumbnail, patch])

  const toggleSaveThumbnail = useCallback(() => {
    const next = !stateRef.current.saveThumbnail
    patch({saveThumbnail: next})
    void saveConfig({saveThumbnail: next})
    patch({
      notice: {
        text: next ? 'thumbnails will be saved with every download' : 'thumbnails will not be saved',
        intent: 'muted',
      },
    })
  }, [patch])

  const startTransfer = useCallback(async () => {
    const current = stateRef.current
    const binaries = binRef.current
    if (!current || !binaries || !current.resolved) return

    const choice = current.choices[current.selected]
    if (!choice) return

    fetchAbort.current?.abort()
    const controller = new AbortController()
    fetchAbort.current = controller

    const startedAt = Date.now()
    const base: Transfer = {
      received: 0,
      speed: 0,
      part: 1,
      totalParts: 1,
      processing: false,
      startedAt,
    }
    patch({phase: 'transfer', transfer: base, notice: undefined})

    // The field holds what was typed, which may be words. Normalise it the same
    // way the fetch did, so the search that produced this list is the same search
    // that downloads from it.
    const target = asTarget(current.url)
    const env: Environment = {
      ytdlp: binaries.ytdlp,
      ffmpeg: binaries.ffmpeg,
      poTokenProvider: binaries.poTokenProvider,
      deno: binaries.deno,
      cookies: current.cookies,
      frontArgs: frontArgsFor(frontRef.current, target),
    }

    try {
      const files =
        current.resolved.kind === 'direct'
          ? await fetchDirectFile(current.resolved.remote, current.outDir, emit, base, controller.signal)
          : current.resolved.kind === 'scrape'
            ? await fetchScraped(choice, current.outDir, emit, base, controller.signal)
            : await fetchWithYtDlp(
                current.resolved,
                target,
                env,
                choice,
                current.outDir,
                emit,
                base,
                controller.signal,
              )

      if (controller.signal.aborted) return

      // The thumbnail rides along with the media when the toggle is on. A
      // failed artwork fetch must never fail the download that already
      // succeeded, so it degrades to a warning line on the filed screen.
      const warnings: string[] = []
      let finalFiles = files
      if (current.resolved.kind === 'ytdlp' && current.saveThumbnail) {
        const info = current.resolved.probe.info
        if (info.thumbnail) {
          try {
            const thumb = await fetchThumbnail(info.thumbnail, info.title ?? 'thumbnail', current.outDir)
            finalFiles = [...files, thumb]
          } catch (error) {
            warnings.push(`thumbnail not saved: ${message(error)}`)
          }
        }
      }

      let bytes = 0
      for (const file of finalFiles) bytes += (await fileSize(file)) ?? 0
      const elapsed = (Date.now() - startedAt) / 1000
      patch({
        phase: 'filed',
        transfer: undefined,
        filed: {
          files: finalFiles,
          summary: `${finalFiles.length} file${finalFiles.length === 1 ? '' : 's'} \u00b7 ${formatBytes(bytes)} \u00b7 ${elapsed.toFixed(1)}s`,
          warnings,
        },
      })

      // The bytes are local now, so sample real frames: the honest preview of
      // what you actually ended up with.
      void buildLocalFilmstrip(files[0], env.ffmpeg, patch, stripAbort)
    } catch (error) {
      if (controller.signal.aborted) {
        patch({phase: 'inspect', transfer: undefined, notice: {text: 'cancelled', intent: 'muted'}})
        return
      }
      patch({phase: 'failed', transfer: undefined, failure: {diagnosis: diagnose(message(error), 'download', {frontOff: !frontRef.current})}})
    }
  }, [emit, fetchThumbnail, patch])

  /* ---------------------------------------------------------------- *
   * Input
   * ---------------------------------------------------------------- */

  useInput((input, key) => {
    const current = stateRef.current

    /* ---- the pointer, before any keyboard handling ---- */
    const pointer = mouseParser.parse(input)
    if (pointer) {
      pointerEvent(pointer)
      return
    }
    /*
     * Escape sequences we do not speak — focus events, paste markers, kitty
     * keys — must never land in the url field as if they were typed text. A
     * lone `[` still types, because the shape below requires a final byte.
     */
    if (input.length > 1 && /^\[[\x20-\x3f]*[A-Za-z~]$/.test(input)) return

    /* ---- the shortcut sheet, available from anywhere ---- *
     *
     * `?` is a real character in a url — every YouTube link contains one — so
     * while there is text in the field it types instead of toggling. ^h opens
     * the sheet in every case, including mid-typing. */
    if ((key.ctrl && input === 'h') || (input === '?' && (current.phase !== 'home' || current.url.length === 0))) {
      patch({helpMenu: !current.helpMenu})
      return
    }

    /* ---- cookies overlay swallows everything else ---- */
    if (current.cookiesMenu) {
      if (key.upArrow) patch({cookiesCursor: (current.cookiesCursor - 1 + BROWSERS.length) % BROWSERS.length})
      else if (key.downArrow) patch({cookiesCursor: (current.cookiesCursor + 1) % BROWSERS.length})
      else if (key.escape || key.ctrl) patch({cookiesMenu: false})
      else if (key.return) {
        const browser = BROWSERS[current.cookiesCursor] as string
        patch({cookiesMenu: false, cookies: browser})
        void saveConfig({cookies: browser})
        if (current.url.trim()) void fetchUrl(current.url)
      }
      return
    }

    /* ---- save-location overlay swallows everything else ---- */
    if (current.saveMenu) {
      const count = current.roots.length
      if (key.upArrow) patch({saveCursor: (current.saveCursor - 1 + count) % Math.max(1, count)})
      else if (key.downArrow) patch({saveCursor: (current.saveCursor + 1) % Math.max(1, count)})
      else if (key.escape || key.ctrl) patch({saveMenu: false})
      else if (key.return) {
        const chosen = current.roots[current.saveCursor]
        if (chosen) {
          void prepare(chosen.dir).then(dir => {
            // The notice is drawn flush right, so it carries the short label —
            // the full path is already on the intake screen under `save to`.
            patch({saveMenu: false, outDir: dir, notice: {text: `saving to ${chosen.label}`, intent: 'good'}})
          })
        }
      }
      return
    }

    if (current.helpMenu) {
      if (key.escape || key.return) patch({helpMenu: false})
      return
    }

    /* ---- global chords ---- */
    if (key.ctrl && input === 't') {
      const order: ThemeName[] = ['auto', 'light', 'dark']
      const next = order[(order.indexOf(current.theme) + 1) % order.length] as ThemeName
      patch({theme: next})
      void saveConfig({theme: next})
      return
    }
    /*
     * `^f` for folder, not `^s`: with flow control on — the default almost
     * everywhere — Ctrl+S is XOFF and pauses the terminal instead of reaching the
     * app, which is the same trap that keeps quit on plain `q`.
     */
    if (key.ctrl && input === 'f') {
      // The folder list is a handful of stat calls plus a registry read, but it
      // is still disk: gather it off the keystroke rather than making the key
      // wait on it.
      patch({saveMenu: true, roots: [], saveCursor: 0})
      void Promise.resolve().then(async () => {
        const list = await roots()
        const idx = Math.max(0, list.findIndex(r => r.dir === stateRef.current.outDir))
        patch({roots: list, saveCursor: idx})
      })
      return
    }
    if (key.ctrl && input === 'o') {
      // Useful on every screen, not only after a download: it is how you check
      // where things are going before you commit to one.
      void openFolder(current.outDir)
      return
    }
    if (key.ctrl && input === 'k') {
      patch({cookiesMenu: true, cookiesCursor: Math.max(0, BROWSERS.indexOf((current.cookies ?? '') as Browser))})
      return
    }
    /*
     * Quit. Ctrl+Q is deliberately *not* the primary binding: with terminal
     * flow control on (the default almost everywhere) Ctrl+Q is XON and gets
     * swallowed by the tty before the app ever sees it, which reads as "quit is
     * broken". Ctrl+X and plain `q` both work everywhere.
     */
    if ((key.ctrl && input === 'x') || (key.ctrl && input === 'q')) {
      quit()
      return
    }
    if (key.ctrl && input === 'c') {
      if (current.phase === 'transfer') {
        cancelActive()
        fetchAbort.current?.abort()
        patch({phase: 'inspect', transfer: undefined, notice: {text: 'cancelled', intent: 'muted'}})
        return
      }
      quit()
      return
    }

    switch (current.phase) {
      case 'boot':
        return

      case 'home': {
        if (key.return) {
          if (current.url.trim()) void fetchUrl(current.url)
          return
        }
        if (key.upArrow) {
          const cursor = Math.min(current.history.length - 1, current.historyCursor + 1)
          if (cursor >= 0 && current.history[cursor]) {
            patch({historyCursor: cursor, url: current.history[cursor] as string})
          }
          return
        }
        if (key.downArrow) {
          const cursor = current.historyCursor - 1
          patch({historyCursor: cursor, url: cursor < 0 ? '' : (current.history[cursor] ?? '')})
          return
        }
        if (key.ctrl && input === 'u') {
          patch({url: '', historyCursor: -1})
          return
        }
        if (key.backspace || key.delete) {
          patch({url: current.url.slice(0, -1), historyCursor: -1})
          return
        }
        // On the field, esc clears what is typed rather than deleting one
        // character: it is the key people reach for when the paste was wrong.
        if (key.escape) {
          if (current.url.length > 0) patch({url: '', historyCursor: -1})
          return
        }
        if (input && !key.ctrl && !key.meta && input.charCodeAt(0) >= 32 && input.charCodeAt(0) !== 127) {
          patch({url: current.url + input, historyCursor: -1})
        }
        return
      }

      case 'resolving': {
        if (key.escape || key.backspace || key.delete) {
          fetchAbort.current?.abort()
          patch({phase: 'home', status: ''})
        }
        if (input === 'q') quit()
        return
      }

      case 'inspect': {
        const count = current.choices.length
        const last = Math.max(0, count - 1)
        /*
         * Moving the cursor must not re-fetch anything.
         *
         * This used to call loadPlate() on every arrow press, which meant each
         * keypress opened a fresh HTTP request for the thumbnail and spawned
         * ffmpeg. Holding `down` produced eight requests in a second and the
         * sheet crawled. The artwork for a given url is the same artwork
         * whichever row you are on, so it is fetched once and then left alone;
         * audio rows simply note that there is nothing to draw.
         */
        const move = (next: number) => {
          const clamped = Math.max(0, Math.min(next, last))
          patch({selected: clamped, listOffset: clamped})
          if (count > 0) notePreview(clamped)
        }

        const notePreview = (index: number) => {
          const choice = current.choices[index]
          if (!choice) return
          // never clobber a picture we already have
          if (current.plate.kind === 'still' || current.plate.kind === 'strip') return
          if (choice.kind === 'audio') {
            patch({plate: {kind: 'none', frame: 0, loaded: 0, expected: 0, empty: 'audio only \u2014 nothing to draw'}})
          }
        }

        if (key.upArrow || input === 'k') {
          move(current.selected - 1)
          return
        }
        if (key.downArrow || input === 'j') {
          move(current.selected + 1)
          return
        }
        if (key.leftArrow || key.rightArrow) {
          patchPlateFrame(key.rightArrow ? 1 : -1)
          return
        }
        if (key.return) {
          void startTransfer()
          return
        }
        if (key.ctrl && input === 'r') {
          void fetchUrl(current.url)
          return
        }
        if (key.escape || key.backspace || key.delete) {
          patch({phase: 'home', choices: [], selected: 0, resolved: undefined, rung: undefined})
          return
        }
        if (input === 'q') {
          quit()
          return
        }
        if (input && /^[1-9]$/.test(input)) {
          const index = Number.parseInt(input, 10) - 1
          if (index <= last) move(index)
        }
        return
      }

      case 'transfer': {
        if (key.escape || key.backspace || key.delete) {
          cancelActive()
          fetchAbort.current?.abort()
          patch({phase: 'inspect', transfer: undefined, notice: {text: 'cancelled', intent: 'muted'}})
          return
        }
        if (input === 'q') quit()
        return
      }

      case 'filed': {
        if (key.leftArrow || key.rightArrow) {
          patchPlateFrame(key.rightArrow ? 1 : -1)
          return
        }
        if (key.return) {
          resetToHome()
          return
        }
        // Back, not out: the format list is still there and the next row is
        // usually what you want after seeing the first one land.
        if (key.escape || key.backspace || key.delete || key.upArrow || key.downArrow) {
          backToPicker()
          return
        }
        if (key.ctrl && input === 'r') {
          patch({filed: undefined})
          void fetchUrl(current.url)
          return
        }
        if (input === 'q') {
          quit()
          return
        }
        return
      }

      case 'failed': {
        if (key.return || (key.ctrl && input === 'r')) {
          void fetchUrl(current.url)
          return
        }
        if (key.escape || key.backspace || key.delete) {
          resetToHome()
          return
        }
        if (input === 'q') quit()
        return
      }

      default:
        return
    }

    function resetToHome(): void {
      stripAbort.current?.abort()
      patch({
        phase: 'home',
        url: '',
        historyCursor: -1,
        choices: [],
        selected: 0,
        resolved: undefined,
        failure: undefined,
        filed: undefined,
        rung: undefined,
        plate: {kind: 'none', frame: 0, loaded: 0, expected: 0},
      })
    }

    /**
     * Step back one level rather than all the way out. After a download the
     * question is usually "what else can I get from this page" — a different
     * height, the audio — so the format list is kept and only the transfer
     * result is cleared. Going home from there is one more back.
     */
    function backToPicker(): void {
      stripAbort.current?.abort()
      if (current.resolved && current.choices.length > 0) {
        patch({
          phase: 'inspect',
          transfer: undefined,
          filed: undefined,
          failure: undefined,
          status: '',
        })
        return
      }
      resetToHome()
    }

    function patchPlateFrame(delta: number): void {
      const plate = current.plate
      if (plate.kind !== 'strip' || !plate.strip) return
      const total = plate.strip.frames.length
      if (total === 0) return
      const next = (((plate.frame + delta) % total) + total) % total
      patch({plate: {...plate, frame: next}})
    }

    /* ------------------------------------------------------------ *
     * The pointer
     * ------------------------------------------------------------ */

    function pointerEvent(event: PointerEvent): void {
      const hit = (): Region | undefined => {
        const areas = regionsRef.current
        for (let i = areas.length - 1; i >= 0; i--) {
          const area = areas[i] as Region
          if (event.col >= area.x && event.col < area.x + area.w && event.row >= area.y && event.row < area.y + area.h) {
            return area
          }
        }
        return undefined
      }

      if (event.kind === 'move') {
        const id = hit()?.id ?? ''
        // Repainting on every motion event would make the pointer the
        // bottleneck, so the sheet only redraws when the pointer crosses
        // from one region to another.
        if (stateRef.current.hover !== id) patch({hover: id})
        return
      }

      if (event.kind === 'wheel') {
        const delta = event.wheel === 1 ? 1 : -1
        const at = stateRef.current
        if (at.helpMenu || at.phase === 'boot' || at.phase === 'resolving') return
        if (at.saveMenu && at.roots.length > 0) {
          const count = at.roots.length
          patch({saveCursor: (at.saveCursor + delta + count) % count})
          return
        }
        if (at.cookiesMenu) {
          patch({cookiesCursor: (at.cookiesCursor + delta + BROWSERS.length) % BROWSERS.length})
          return
        }
        if (at.phase === 'inspect') {
          const count = at.choices.length
          if (count > 0) {
            const clamped = Math.max(0, Math.min(at.selected + delta, count - 1))
            patch({selected: clamped, listOffset: clamped})
          }
          return
        }
        if (at.phase === 'home' && at.history.length > 0) {
          const cursor = Math.min(at.history.length - 1, Math.max(-1, at.historyCursor - delta))
          patch({historyCursor: cursor, url: cursor < 0 ? '' : (at.history[cursor] ?? '')})
        }
        return
      }

      if (event.kind !== 'down') return

      const region = hit()
      if (!region) {
        // A click on open sheet is the GUI reflex for "dismiss this".
        const at = stateRef.current
        if (at.helpMenu) patch({helpMenu: false})
        else if (at.cookiesMenu) patch({cookiesMenu: false})
        else if (at.saveMenu) patch({saveMenu: false})
        return
      }
      click(region, event.col)
    }

    /** Run the action a region was drawn to carry. */
    function click(region: Region, col: number): void {
      const at = stateRef.current

      // An open menu owns the pointer: its rows work, anything else closes it.
      if (at.saveMenu && !region.id.startsWith('save:')) {
        patch({saveMenu: false})
        return
      }
      if (at.cookiesMenu && !region.id.startsWith('cookie:')) {
        patch({cookiesMenu: false})
        return
      }
      if (at.helpMenu) {
        patch({helpMenu: false})
        return
      }

      const now = Date.now()
      const twice = lastClick.current.id === region.id && now - lastClick.current.at < 450
      lastClick.current = {id: region.id, at: now}

      if (region.id.startsWith('btn:')) {
        switch (region.id) {
          case 'btn:fetch':
            if (at.url.trim()) void fetchUrl(at.url)
            return
          case 'btn:save':
            patch({saveMenu: true, roots: [], saveCursor: 0})
            void Promise.resolve().then(async () => {
              const list = await roots()
              const idx = Math.max(0, list.findIndex(r => r.dir === stateRef.current.outDir))
              patch({roots: list, saveCursor: idx})
            })
            return
          case 'btn:cookies':
            patch({cookiesMenu: true, cookiesCursor: Math.max(0, BROWSERS.indexOf((at.cookies ?? '') as Browser))})
            return
          case 'btn:theme': {
            const order: ThemeName[] = ['auto', 'light', 'dark']
            const next = order[(order.indexOf(at.theme) + 1) % order.length] as ThemeName
            patch({theme: next})
            void saveConfig({theme: next})
            return
          }
          case 'btn:quit':
            quit()
            return
          case 'btn:folder':
            void openFolder(at.outDir)
            return
          case 'btn:download':
            void startTransfer()
            return
          case 'btn:thumb':
            void saveThumbnailNow()
            return
          case 'btn:thumb-toggle':
            toggleSaveThumbnail()
            return
          case 'btn:cancel':
            cancelActive()
            fetchAbort.current?.abort()
            patch({phase: 'inspect', transfer: undefined, notice: {text: 'cancelled', intent: 'muted'}})
            return
          case 'btn:retry':
            void fetchUrl(at.url)
            return
          case 'btn:next':
            resetToHome()
            return
          case 'btn:back':
            if (at.phase === 'filed') backToPicker()
            else if (at.phase === 'failed' || at.phase === 'inspect') resetToHome()
            return
          default:
            return
        }
      }

      if (region.id.startsWith('save:')) {
        const index = Number(region.id.slice(5))
        const chosen = at.roots[index]
        if (!chosen) return
        patch({saveCursor: index})
        void prepare(chosen.dir).then(dir => {
          patch({saveMenu: false, outDir: dir, notice: {text: `saving to ${chosen.label}`, intent: 'good'}})
        })
        return
      }

      if (region.id.startsWith('cookie:')) {
        const browser = BROWSERS[Number(region.id.slice(7))] as string
        if (!browser) return
        patch({cookiesMenu: false, cookies: browser})
        void saveConfig({cookies: browser})
        if (at.url.trim()) void fetchUrl(at.url)
        return
      }

      if (region.id.startsWith('choice:')) {
        const index = Number(region.id.slice(7))
        if (index >= at.choices.length) return
        // One click selects; a second click on the same row within half a
        // second commits — the list behaves like an operating-system picker.
        patch({selected: index, listOffset: index})
        if (twice && at.phase === 'inspect') void startTransfer()
        return
      }

      if (region.id.startsWith('hist:')) {
        const index = Number(region.id.slice(5))
        const entry = at.history[index]
        if (entry === undefined) return
        patch({url: entry, historyCursor: index})
        if (twice) void fetchUrl(entry)
        return
      }

      if (region.id === 'scrub') {
        const plate = at.plate
        if (plate.kind !== 'strip' || !plate.strip || plate.strip.frames.length === 0) return
        const total = plate.strip.frames.length
        const ratio = Math.max(0, Math.min(1, (col - region.x) / Math.max(1, region.w - 1)))
        patch({plate: {...plate, frame: Math.min(total - 1, Math.round(ratio * (total - 1)))}})
        return
      }
    }
  })

  /* ---------------------------------------------------------------- *
   * Render
   * ---------------------------------------------------------------- */

  const styles = useMemo(() => createStyleResolver(state.theme, state.colorDepth), [state.theme, state.colorDepth])
  const renderer = useMemo<Renderer>(() => pickRenderer(state.colorDepth, true), [state.colorDepth])

  /*
   * A spinner that only advances on a re-render is a frozen spinner. Fetching
   * and transferring are long enough that the user needs to see the app is
   * alive, so while either is in flight we tick a clock at 8Hz. Nothing else
   * re-renders, so this costs nothing when idle.
   */
  const busy = state.phase === 'resolving' || state.phase === 'transfer' || state.phase === 'boot'
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!busy) return
    const timer = setInterval(() => setTick(t => t + 1), 125)
    return () => clearInterval(timer)
  }, [busy])

  const body = useMemo(() => {
    const sheet = new Sheet(state.cols, state.rows, styles)
    const chrome: Chrome = {
      cols: state.cols,
      rows: state.rows,
      theme: state.theme,
      colorDepth: state.colorDepth,
    }

    switch (state.phase) {
      case 'boot':
      case 'home':
        drawHome(sheet, chrome, state)
        break
      case 'resolving':
        drawResolving(sheet, chrome, state, tick)
        break
      case 'inspect':
        drawInspect(sheet, chrome, state, renderer)
        break
      case 'transfer':
        drawTransfer(sheet, chrome, state)
        break
      case 'filed':
        drawFiled(sheet, chrome, state)
        break
      case 'failed':
        drawFailed(sheet, chrome, state)
        break
    }

    if (state.notice) {
      const {x, w} = frame(state.cols, state.rows)
      const intent = state.notice.intent === 'good' ? 'good' : state.notice.intent === 'bad' ? 'bad' : 'muted'
      sheet.text(x + w - state.notice.text.length - 1, state.rows - 4, state.notice.text, intent)
    }
    if (state.cookiesMenu) drawCookiesMenu(sheet, state)
    if (state.saveMenu) drawSaveMenu(sheet, state)
    if (state.helpMenu) drawHelpMenu(sheet, state)

    // The frame is about to be painted, so its click targets are authoritative
    // until the next one: the pointer acts on what the user can actually see.
    regionsRef.current = sheet.regions

    return sheet.toString()
  }, [state, styles, renderer, tick])

  return (
    <Box flexDirection="column" width={state.cols}>
      <Text>{body}</Text>
    </Box>
  )
}

/* ------------------------------------------------------------------ *
 * Views that only exist while a phase is active
 * ------------------------------------------------------------------ */

function drawResolving(sheet: Sheet, chrome: Chrome, state: AppState, tick: number): void {
  drawChrome(sheet, chrome, {
    stamp: state.status,
    hints: [
      {key: 'esc', label: 'cancel'},
      {key: '?', label: 'keys'},
      {key: 'q', label: 'quit'},
    ],
    themeName: state.theme,
  })

  const {x, w} = frame(state.cols, state.rows)
  const inner = Math.min(w - 6, 72)
  const innerX = x + Math.floor((w - inner) / 2)
  const top = Math.max(7, Math.floor(state.rows / 2) - 3)
  const frame_ = Math.floor(tick / 2) % SPINNER.length

  sheet.clip(innerX, top, state.url, inner, 'muted')
  sheet.text(innerX, top + 2, `${SPINNER[frame_] ?? '\u280b'}  ${state.status || 'working'}`, 'accent')
  sheet.clip(
    innerX,
    top + 4,
    'trying the player clients in order until one answers',
    inner,
    'grid',
  )
}

/* ------------------------------------------------------------------ *
 * Transfer back-ends
 * ------------------------------------------------------------------ */

async function fetchDirectFile(
  remote: Remote,
  outDir: string,
  emit: (t: Transfer) => void,
  base: Transfer,
  signal: AbortSignal,
): Promise<string[]> {
  const result = await downloadDirect({
    url: remote.finalUrl,
    outDir,
    filename: remote.filename,
    remote,
    signal,
    onProgress: p => emit({...base, received: p.received, total: p.total, speed: p.speed, eta: p.eta}),
  })
  return [result.file]
}

async function fetchScraped(
  choice: Choice,
  outDir: string,
  emit: (t: Transfer) => void,
  base: Transfer,
  signal: AbortSignal,
): Promise<string[]> {
  if (!choice.sourceUrl) throw new Error('that row has no url behind it')
  const remote = await fetchRemote(choice.sourceUrl)
  return fetchDirectFile(remote, outDir, emit, base, signal)
}

async function fetchRemote(url: string): Promise<Remote> {
  const probed = await probeRemote(url)
  if (!probed.ok) throw new Error(probed.error)
  return probed.remote
}

async function fetchWithYtDlp(
  resolved: Extract<Resolved, {kind: 'ytdlp'}>,
  url: string,
  env: Environment,
  choice: Choice,
  outDir: string,
  emit: (t: Transfer) => void,
  base: Transfer,
  signal: AbortSignal,
): Promise<string[]> {
  let lastEmit = 0
  const outcome = await ytdlpDownload(
    {
      env,
      url,
      rung: resolved.probe.rung,
      choice,
      outDir,
    },
    (progress: Progress) => {
      // The meter is a drawing; redrawing it 200 times a second would make the
      // terminal, not the sheet, the bottleneck.
      const now = Date.now()
      if (!progress.processing && now - lastEmit < 120) return
      lastEmit = now
      emit({
        ...base,
        received: progress.downloaded,
        total: progress.total,
        speed: progress.speed ?? 0,
        eta: progress.eta,
        part: progress.part + 1,
        totalParts: progress.totalParts,
        processing: progress.processing,
      })
    },
    signal,
  )
  return outcome.files
}

async function buildLocalFilmstrip(
  file: string | undefined,
  ffmpeg: string | undefined,
  patch: (next: Partial<AppState>) => void,
  abortRef: React.MutableRefObject<AbortController | null>,
): Promise<void> {
  if (!file || !ffmpeg) return
  if (!/\.(mp4|mkv|webm|mov|m4v|avi)$/i.test(file)) return

  const controller = new AbortController()
  abortRef.current?.abort()
  abortRef.current = controller

  const strip = await buildFilmstrip({
    source: file,
    isUrl: false,
    ffmpeg,
    signal: controller.signal,
    onFrame: frames => {
      if (frames.length === 0) return
      patch({
        plate: {
          kind: 'strip',
          strip: {frames, times: [], width: 100, height: 100},
          frame: 0,
          loaded: frames.length,
          expected: Math.max(32, frames.length),
        },
      })
    },
  })
  if (strip) {
    patch({plate: {kind: 'strip', strip, frame: 0, loaded: strip.frames.length, expected: strip.frames.length}})
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.round(seconds % 60)
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`
}

export function detectColorDepth(): number {
  const env = process.env
  if (env['NO_COLOR'] !== undefined) return 0
  if (env['FORCE_COLOR'] === '3') return 24
  if (env['FORCE_COLOR'] === '2') return 8
  if (env['COLORTERM'] === 'truecolor' || env['COLORTERM'] === '24bit') return 24
  if (env['TERM']?.includes('256color')) return 8
  if (env['TERM'] === 'dumb') return 0
  return 24
}