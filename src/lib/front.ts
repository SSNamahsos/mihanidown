import net from 'node:net'
import tls from 'node:tls'
import type http from 'node:http'
import {Readable} from 'node:stream'
import dns from 'node:dns/promises'
import fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import {X509Certificate} from 'node:crypto'
import {APP_DIR} from './binaries.js'
import {selfSignedCertificate} from './x509.js'

/**
 * The front.
 *
 * YouTube is filtered by poisoning DNS for the youtube domain family and by
 * injecting an RST into any TLS hello that names one. The servers themselves are
 * reachable — TCP to Google's addresses connects, and Google's frontend routes on
 * the HTTP Host header rather than on the name in the hello. So the name is what
 * has to change.
 *
 * A proxy that rewrites the ClientHello in passing cannot work: the handshake's
 * Finished message hashes the ClientHello the *client* sent, so substituting bytes
 * on the wire breaks a connection that was otherwise fine. The only correct shape
 * is to end the client's TLS locally — on loopback, where no filter can see it —
 * and open a second connection under a name the filter lets through.
 *
 * That is also why yt-dlp needs `--no-check-certificates` while the front is on:
 * the certificate it is shown is ours, minted here. What still holds is the part
 * that matters: the upstream handshake verifies Google's certificate chain
 * against real root CAs, so a filter that tried to impersonate Google would need
 * a CA-signed certificate, which it does not have.
 *
 * Requests still leave from this machine's own address. That is the whole reason
 * this works where a relay in the cloud does not: YouTube scores the address it is
 * talking to, and a datacentre range scores worse than a home connection, not
 * better.
 */

export type FrontMode = 'auto' | 'on' | 'off'

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

/** The name we ask the network for, and the identity its certificate answers to. */
export const FRONT_NAME = 'www.google.com'

/**
 * The names the filter resets. Measured, not guessed: `*.googleapis.com` is
 * deliberately absent, because play/android/www/storage all answered normally
 * while youtubei did not.
 */
const FRONTED =
  /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubekids\.com|youtu\.be|ytimg\.com|googlevideo\.com|ggpht\.com|doubleclickusercontent\.com)$/i
const FRONTED_EXACT = new Set(['youtubei.googleapis.com'])

export function needsFront(host: string): boolean {
  return FRONTED.test(host) || FRONTED_EXACT.has(host)
}

/** Names that still resolve correctly and whose answers are Google's frontend. */
const CANARIES = ['www.gstatic.com', 'play.googleapis.com', 'clients1.google.com', 'www.google.com']

/**
 * An address the filter hands out instead of the real one: an internal block page,
 * or Google's own nameserver range pointed at nothing.
 */
export function sinkholed(ip: string): boolean {
  const o = ip.split('.').map(Number)
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b, c] = o as [number, number, number, number]
  if (a === 10 || a === 127 || a === 0) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 169 && b === 254) return true
  if (a === 216 && b === 239 && c >= 32 && c <= 38) return true
  return false
}

const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)] as T

let pool: readonly string[] = []

/** Live frontend addresses, taken from names the filter has no interest in. */
export async function discoverPool(): Promise<readonly string[]> {
  if (pool.length) return pool
  const found = new Set<string>()
  await Promise.all(
    CANARIES.map(async name => {
      for (const ip of (await dns.resolve4(name).catch(() => [] as string[])).filter(x => !sinkholed(x))) found.add(ip)
    }),
  )
  pool = [...found]
  return pool
}

/**
 * A media edge is not served by the generic frontend anycast — pointed at the
 * wrong address it answers 404 — so the real record is used whenever DNS gives
 * one. The anycast pool only stands in for names that were poisoned.
 */
export async function addressFor(host: string): Promise<string> {
  const answers = (await dns.resolve4(host).catch(() => [] as string[])).filter(ip => !sinkholed(ip))
  if (answers.length) return pick(answers)
  const known = await discoverPool()
  return known.length ? pick(known) : host
}

/* ------------------------------------------------------------------ *
 * Is the filter here?
 * ------------------------------------------------------------------ */

export type FilterReport = {
  /** the front is needed */
  blocked: boolean
  dnsPoisoned: boolean
  sniReset: boolean
  /** the fronting name still handshakes, so the front can work */
  usable: boolean
  detail: string
}

function tlsProbe(ip: string, servername: string, ms: number): Promise<{ok: boolean; code: string}> {
  return new Promise(resolve => {
    const socket = tls.connect({host: ip, port: 443, servername, rejectUnauthorized: false, timeout: ms}, () => {
      socket.destroy()
      resolve({ok: true, code: ''})
    })
    socket.on('timeout', () => (socket.destroy(), resolve({ok: false, code: 'timeout'})))
    socket.on('error', error => resolve({ok: false, code: String((error as NodeJS.ErrnoException).code ?? error.message).slice(0, 40)}))
  })
}

/**
 * Ask the network rather than believe a setting. A hello naming youtube is reset
 * while a hello naming Google's frontend completes, so the difference between the
 * two *is* the censorship.
 */
export async function detectFilter(): Promise<FilterReport> {
  const addresses = await discoverPool()
  if (!addresses.length) {
    return {blocked: false, dnsPoisoned: false, sniReset: false, usable: false, detail: 'no reachable Google frontend address'}
  }
  const ip = pick(addresses)
  const [youtube, front] = await Promise.all([tlsProbe(ip, 'www.youtube.com', 5000), tlsProbe(ip, FRONT_NAME, 5000)])
  const answers = await dns.resolve4('www.youtube.com').catch(() => [] as string[])
  return {
    blocked: !youtube.ok && front.ok,
    dnsPoisoned: answers.length === 0 || answers.every(sinkholed),
    sniReset: !youtube.ok && youtube.code !== 'timeout',
    usable: front.ok,
    detail: front.ok ? (youtube.ok ? 'youtube answered without help' : `youtube hello: ${youtube.code}`) : 'the fronting name did not handshake either',
  }
}

/* ------------------------------------------------------------------ *
 * The certificate this machine signs with
 * ------------------------------------------------------------------ */

const CERT_PATH = path.join(APP_DIR, 'front-cert.pem')
const KEY_PATH = path.join(APP_DIR, 'front-key.pem')

const CERT_NAMES = [
  'www.youtube.com',
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'i.ytimg.com',
  's.ytimg.com',
  'googlevideo.com',
  'r1---sn-4g5ednsy.googlevideo.com',
  'manifest.googlevideo.com',
  'yt3.ggpht.com',
  'www.googleapis.com',
  'play.googleapis.com',
  'www.gstatic.com',
]

async function frontCertificate(): Promise<{keyPem: string; certPem: string}> {
  try {
    const [keyPem, certPem] = await Promise.all([fs.readFile(KEY_PATH, 'utf8'), fs.readFile(CERT_PATH, 'utf8')])
    if (new X509Certificate(certPem).validTo && Date.parse(new X509Certificate(certPem).validTo) > Date.now() + 86_400_000) {
      return {keyPem, certPem}
    }
  } catch {
    /* absent, unreadable, or expiring: make a new one */
  }
  const made = selfSignedCertificate({commonName: 'mihanidown front', dns: CERT_NAMES, days: 820})
  await fs.mkdir(APP_DIR, {recursive: true})
  // Loopback-only key, but 0600 anyway: a shared machine should not read it back.
  await Promise.all([
    fs.writeFile(CERT_PATH, made.certPem, {encoding: 'utf8', mode: 0o600}),
    fs.writeFile(KEY_PATH, made.keyPem, {encoding: 'utf8', mode: 0o600}),
  ])
  return {keyPem: made.keyPem, certPem: made.certPem}
}

/* ------------------------------------------------------------------ *
 * The proxy
 * ------------------------------------------------------------------ */

export type Front = {
  /** http://127.0.0.1:<port> — bound to loopback; nothing else can reach it */
  proxyUrl: string
  report: FilterReport
  ytdlpArgs: string[]
  ffmpegArgs: string[]
  fetch: (url: string, init?: RequestInit) => Promise<FrontReply>
  close: () => Promise<void>
}

export type FrontReply = Response & {finalUrl: string}

export async function startFront(report: FilterReport): Promise<Front> {
  const {keyPem, certPem} = await frontCertificate()

  /**
   * One TLS listener per host the downloader asks for. Each one knows the host it
   * stands for, so nothing has to be inferred from the hello — which is exactly the
   * thing we are not allowed to trust.
   *
   * The map holds the *promise* rather than the result: yt-dlp opens several
   * connections to the same edge at once, and caching only the settled value would
   * let each of them start its own listener before the first had finished binding.
   */
  type Bridge = {server: tls.Server; port: number; live: number}
  const bridges = new Map<string, Promise<Bridge>>()
  const open = new Set<{destroy: () => void}>()

  /**
   * A media edge is a distinct hostname per connection (`r1---sn-…`, `r3---sn-…`),
   * so an unbounded map here would quietly hold hundreds of listeners open across a
   * long session. Idle ones are what can go; one with a socket on it stays.
   */
  const MAX_BRIDGES = 24
  function reclaim(): void {
    if (bridges.size <= MAX_BRIDGES) return
    for (const [host, pending] of bridges) {
      if (bridges.size <= MAX_BRIDGES) return
      void pending.then(bridge => {
        if (bridge.live !== 0) return
        bridge.server.close()
        bridges.delete(host)
      })
    }
  }

  function bridgeFor(host: string): Promise<Bridge> {
    const known = bridges.get(host)
    if (known) return known
    const making = makeBridge(host).catch(error => {
      bridges.delete(host)
      throw error
    })
    bridges.set(host, making)
    return making
  }

  async function makeBridge(host: string): Promise<Bridge> {
    const server = tls.createServer({key: keyPem, cert: certPem, ALPNProtocols: ['http/1.1']})
    const bridge: Bridge = {server, port: 0, live: 0}
    server.on('secureConnection', client => {
      bridge.live += 1
      void (async () => {
        const ip = await addressFor(host)
        // Chain verification stays on; the name check cannot mean anything when the
        // hello deliberately names somebody else.
        const upstream = tls.connect(
          {
            host: ip,
            port: 443,
            servername: FRONT_NAME,
            ALPNProtocols: ['http/1.1'],
            rejectUnauthorized: true,
            checkServerIdentity: () => undefined,
            timeout: 30_000,
          },
          () => {
            client.pipe(upstream)
            upstream.pipe(client)
          },
        )
        open.add(upstream)
        const done = (): void => {
          open.delete(upstream)
          bridge.live -= 1
          reclaim()
        }
        upstream.on('close', () => (done(), client.destroy()))
        upstream.on('error', () => (done(), client.destroy()))
        client.on('error', () => upstream.destroy())
        client.on('close', () => (done(), upstream.destroy()))
      })()
    })
    await listen(server, 0)
    bridge.port = (server.address() as net.AddressInfo).port
    return bridge
  }

  const proxy = net.createServer(client => {
    let header = Buffer.alloc(0)
    let peer: net.Socket | undefined
    let ready = false
    const early: Buffer[] = []
    client.setNoDelay(true)
    client.on('error', () => undefined)

    const attach = (next: net.Socket): void => {
      peer = next
      next.on('error', () => client.destroy())
      next.on('close', () => client.destroy())
      next.once('connect', () => {
        ready = true
        for (const q of early.splice(0)) next.write(q)
      })
      next.on('data', d => client.write(d))
    }

    client.on('data', chunk => {
      if (peer) {
        if (ready) peer.write(chunk)
        else early.push(chunk as Buffer)
        return
      }
      header = Buffer.concat([header, chunk as Buffer])
      const end = header.indexOf('\r\n\r\n')
      if (end < 0) {
        if (header.length > 16384) client.end()
        return
      }
      const line = header.subarray(0, header.indexOf(0x0d)).toString('latin1')
      const rest = header.subarray(end + 4)
      header = Buffer.alloc(0)
      if (!/^CONNECT /i.test(line)) {
        client.end('HTTP/1.1 405 Method Not Allowed\r\nProxy-Agent: mihanidown\r\n\r\n')
        return
      }
      const target = line.split(' ')[1] ?? ''
      const host = target.replace(/:\d+$/, '')
      const port = Number(target.split(':').at(-1)) || 443
      client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: mihanidown\r\n\r\n')

      if (!needsFront(host)) {
        // Not filtered: an ordinary tunnel. The client's own certificate checks
        // still apply, because nothing is being terminated here.
        return void attach(net.createConnection({host, port}))
      }
      void bridgeFor(host).then(bridge => {
        attach(net.createConnection({host: '127.0.0.1', port: bridge.port}))
        if (rest.length) (ready ? peer?.write(rest) : early.push(rest))
      })
    })

    client.on('close', () => peer?.destroy())
  })
  await listen(proxy, 0)
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`

  async function fetchFronted(url: string, init: RequestInit = {}): Promise<FrontReply> {
    const host = new URL(url).hostname
    if (!needsFront(host)) {
      const direct = await globalThis.fetch(url, {...init, redirect: 'follow'})
      return withFinalUrl(direct, direct.url || url)
    }
    return frontedRequest(url, init)
  }

  return {
    proxyUrl,
    report,
    /**
     * The downloader is shown our certificate instead of Google's, so it cannot
     * check the name. This is the one thing the front costs.
     */
    ytdlpArgs: ['--proxy', proxyUrl, '--no-check-certificates'],
    ffmpegArgs: ['-http_proxy', proxyUrl, '-tls_verify', '0'],
    fetch: fetchFronted,
    close: async () => {
      for (const s of open) s.destroy()
      // A bridge that never finished binding has nothing to close, and a failed
      // one must not stop the rest of the shutdown.
      const settled = await Promise.allSettled([...bridges.values()])
      for (const result of settled) if (result.status === 'fulfilled') result.value.server.close()
      bridges.clear()
      await new Promise<void>(resolve => proxy.close(() => resolve()))
    },
  }
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/**
 * The front's yt-dlp arguments, but only for a url that actually needs them.
 * Asking yt-dlp to skip certificate checking is a real cost, and a Vimeo or a
 * plain file url does not pay it just because some other site is blocked.
 */
export function frontArgsFor(front: Front | null, url: string): string[] | undefined {
  if (!front) return undefined
  const text = url.trim()
  // A search, or any of yt-dlp's extractor shortcuts, has no host of its own and
  // is answered by YouTube, so it needs the front exactly as a link does.
  if (!/^https?:\/\//i.test(text)) return front.ytdlpArgs
  try {
    return needsFront(new URL(text).hostname) ? front.ytdlpArgs : undefined
  } catch {
    return front.ytdlpArgs
  }
}

/**
 * One front per process. This is a single-session terminal app: nothing runs two
 * downloads against different routes, and threading the object through the direct
 * engine, the scraper, the image decoder and the filmstrip would put a parameter
 * in four signatures to say what this one line already says.
 */
let active: Front | null = null

export function activeFront(): Front | null {
  return active
}

export type FrontOutcome = {front: Front | null; report: FilterReport | null; skipped: boolean}

/**
 * `auto` asks the network and stays out of the way when the answer is fine.
 * `on` insists, for anyone whose filter does something this probe cannot see.
 */
export async function ensureFront(mode: FrontMode): Promise<FrontOutcome> {
  if (mode === 'off') return {front: null, report: null, skipped: true}
  const report = await detectFilter()
  if (mode === 'auto' && !report.blocked) return {front: null, report, skipped: true}
  if (!report.usable) return {front: null, report, skipped: false}
  const front = await startFront(report)
  active = front
  return {front, report, skipped: false}
}

export async function closeFront(): Promise<void> {
  const current = active
  active = null
  if (current) await current.close()
}

/**
 * The one way the app asks a remote server for something. Everything that is not
 * fronted behaves exactly as it did; everything that is goes through the front
 * with the app's own TLS, where the certificate is Google's and is checked.
 */
export async function httpFetch(url: string, init: RequestInit = {}): Promise<FrontReply> {
  const front = active
  if (front) return front.fetch(url, init)
  const response = await globalThis.fetch(url, {...init, redirect: 'follow'})
  return withFinalUrl(response, response.url || url)
}

function withFinalUrl(response: Response, finalUrl: string): FrontReply {
  return Object.defineProperty(response, 'finalUrl', {value: finalUrl}) as FrontReply
}

/**
 * The app's own requests. Here the app *is* the TLS client, so there is no
 * certificate problem at all — the front's name goes in the hello, the real name
 * goes in the Host header, and Google's chain is verified. Redirects are followed
 * by hand because every hop can be a different host, and each one needs its own
 * name in both places.
 */
export async function frontedRequest(url: string, init: RequestInit = {}, hops = 6): Promise<FrontReply> {
  const target = new URL(url)
  const ip = await addressFor(target.hostname)
  const caller = (init.headers ?? {}) as Record<string, string>

  const reply = await new Promise<{status: number; headers: http.IncomingHttpHeaders; body: import('node:stream').Readable; location?: string}>((resolve, reject) => {
    const req = https.request(
      {
        host: ip,
        port: 443,
        path: `${target.pathname}${target.search}`,
        method: init.method ?? 'GET',
        servername: FRONT_NAME,
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        headers: {
          // the routing name, then the defaults, then whatever the caller set
          host: target.host,
          'user-agent': UA,
          accept: '*/*',
          // undici decodes transparently; a raw socket does not
          'accept-encoding': 'identity',
          ...caller,
        },
        timeout: 20_000,
      },
      res => resolve({status: res.statusCode ?? 0, headers: res.headers, body: res, location: res.headers.location}),
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('the front timed out')))
    if (typeof init.body === 'string') req.end(init.body)
    else req.end()
  })

  if (reply.status >= 300 && reply.status < 400 && reply.location && hops > 0) {
    reply.body.destroy()
    const next = new URL(reply.location, url).toString()
    const again =
      reply.status === 307 || reply.status === 308
        ? frontedRequest(next, init, hops - 1)
        : frontedRequest(next, {...init, method: 'GET', body: undefined}, hops - 1)
    return again
  }

  const headers = new Headers()
  for (const [key, value] of Object.entries(reply.headers)) {
    if (value === undefined) continue
    for (const one of Array.isArray(value) ? value : [value]) headers.append(key, one)
  }

  // 204/205/304 may not carry a body, and Response refuses one.
  const empty = reply.status === 204 || reply.status === 205 || reply.status === 304
  const stream = empty ? null : (Readable.toWeb(reply.body as unknown as Readable) as unknown as ReadableStream)
  const response = new Response(stream, {status: reply.status})
  for (const [key, value] of headers) {
    try {
      response.headers.set(key, value)
    } catch {
      /* hop-by-hop headers have no meaning to a caller */
    }
  }
  return withFinalUrl(response, url)
}
