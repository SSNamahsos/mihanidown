import {generateKeyPairSync, sign, randomBytes} from 'node:crypto'

/**
 * A self-signed X.509 certificate, written as DER by hand.
 *
 * The front needs one: it terminates the downloader's TLS locally so it can
 * re-originate to Google under a different name. Nothing else in the app touches
 * certificates, and the last thing a terminal downloader should do is shell out
 * to `openssl` and hope it is on PATH — this is the same reasoning that led the
 * JPEG decoder to be written here rather than pulled in. It is about a hundred
 * lines, and the tests drive a real TLS handshake with the output, so a wrong
 * byte shows up as a failed handshake rather than a broken app three weeks later.
 */

/* ------------------------------------------------------------------ *
 * DER
 * ------------------------------------------------------------------ */

const SEQUENCE = 0x30
const SET = 0x31
const INTEGER = 0x02
const BOOLEAN = 0x01
const NULL = 0x05
const OID = 0x06
const UTC_TIME = 0x17
const BIT_STRING = 0x03
const OCTET_STRING = 0x04
const UTF8_STRING = 0x0c
const IA5_STRING = 0x16

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n])
  const bytes: number[] = []
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff)
  return Buffer.from([0x80 | bytes.length, ...bytes])
}

function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(value.length), value])
}

const seq = (...items: Buffer[]): Buffer => tlv(SEQUENCE, Buffer.concat(items))
const set = (...items: Buffer[]): Buffer => tlv(SET, Buffer.concat(items))

/** INTEGER is signed in ASN.1: a high bit needs a leading zero byte. */
function integer(value: number | Buffer): Buffer {
  if (typeof value === 'number') {
    const bytes: number[] = []
    for (let v = value; v > 0; v >>= 8) bytes.unshift(v & 0xff)
    if (bytes.length === 0) bytes.push(0)
    if ((bytes[0] as number) & 0x80) bytes.unshift(0)
    return tlv(INTEGER, Buffer.from(bytes))
  }
  const padded = (value[0] as number) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value
  return tlv(INTEGER, padded)
}

const boolean = (yes: boolean): Buffer => tlv(BOOLEAN, Buffer.from([yes ? 0xff : 0x00]))
const nullDer = (): Buffer => tlv(NULL, Buffer.alloc(0))

function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number)
  // The first two arcs share one byte; every later arc is a base-128 varint.
  const body: number[] = [parts[0]! * 40 + parts[1]!]
  for (const p of parts.slice(2)) {
    const stack: number[] = [p & 0x7f]
    let v = p >> 7
    while (v > 0) {
      stack.unshift((v & 0x7f) | 0x80)
      v >>= 7
    }
    body.push(...stack)
  }
  return tlv(OID, Buffer.from(body))
}

/** UTCTime: YYMMDDHHMMSSZ, valid for the two-digit century the year implies. */
function utcTime(date: Date): Buffer {
  const p = (n: number): string => String(n).padStart(2, '0')
  const s =
    p(date.getUTCFullYear() % 100) +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    'Z'
  return tlv(UTC_TIME, Buffer.from(s, 'ascii'))
}

const bitString = (content: Buffer, unusedBits = 0): Buffer => tlv(BIT_STRING, Buffer.concat([Buffer.from([unusedBits]), content]))
const octetString = (content: Buffer): Buffer => tlv(OCTET_STRING, content)

function extension(oidDotted: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(oidDotted), ...(critical ? [boolean(true)] : []), octetString(value))
}

/* ------------------------------------------------------------------ *
 * Names and extensions
 * ------------------------------------------------------------------ */

const CN = '2.5.4.3'

function name(commonName: string): Buffer {
  return seq(set(seq(oid(CN), tlv(UTF8_STRING, Buffer.from(commonName, 'utf8')))))
}

/** DNS names go in as IA5String GeneralNames (tag [2] in class CONTEXT). */
function subjectAltName(dns: string[]): Buffer {
  const entries = dns.map(d => tlv(0x82, Buffer.from(d, 'ascii')))
  return seq(...entries)
}

/* ------------------------------------------------------------------ *
 * Certificate
 * ------------------------------------------------------------------ */

const SHA256_RSA = '1.2.840.113549.1.1.11'
const BASIC_CONSTRAINTS = '2.5.29.19'
const KEY_USAGE = '2.5.29.15'
const EXT_KEY_USAGE = '2.5.29.37'
const SUBJECT_ALT_NAME = '2.5.29.17'
const SERVER_AUTH = '1.3.6.1.5.5.7.3.1'

export type SelfSigned = {certPem: string; keyPem: string; certDer: Buffer}

/**
 * digitalSignature | keyEncipherment — what a TLS server certificate asks for.
 * Written as the named-bit string DER wants: bit 7 is the first named bit.
 */
const KEY_USAGE_SERVER = Buffer.from([0x05, 0xa0])

export function selfSignedCertificate(options: {commonName: string; dns: string[]; days?: number; keyPair?: ReturnType<typeof generateKeyPairSync>}): SelfSigned {
  const pair = options.keyPair ?? generateKeyPairSync('rsa', {modulusLength: 2048})
  const notBefore = new Date(Date.now() - 60 * 60 * 1000)
  const notAfter = new Date(Date.now() + (options.days ?? 3650) * 24 * 60 * 60 * 1000)

  const spki = pair.publicKey.export({type: 'spki', format: 'der'})
  const serial = randomBytes(8)
  if ((serial[0] as number) & 0x80) serial[0] = (serial[0] as number) & 0x7f

  const algorithm = seq(oid(SHA256_RSA), nullDer())
  const subject = name(options.commonName)

  const extensions = seq(
    // not a CA: this cert signs nothing, so a compromised loopback port cannot
    // mint certificates that the wider world would honour.
    extension(BASIC_CONSTRAINTS, true, seq()),
    extension(KEY_USAGE, true, bitString(KEY_USAGE_SERVER.slice(1), KEY_USAGE_SERVER[0] as number)),
    extension(EXT_KEY_USAGE, false, seq(oid(SERVER_AUTH))),
    extension(SUBJECT_ALT_NAME, false, subjectAltName(options.dns.length ? options.dns : [options.commonName])),
  )

  const tbs = seq(
    tlv(0xa0, integer(2)), // version v3
    integer(serial),
    algorithm,
    subject, // self-signed: issuer == subject
    seq(utcTime(notBefore), utcTime(notAfter)),
    subject,
    spki,
    tlv(0xa3, extensions),
  )

  const signature = sign('sha256', tbs, pair.privateKey)
  const cert = seq(tbs, algorithm, bitString(signature))

  return {certDer: cert, certPem: pem('CERTIFICATE', cert), keyPem: pem('PRIVATE KEY', pair.privateKey.export({type: 'pkcs8', format: 'der'}))}
}

function pem(label: string, der: Buffer): string {
  const body = der.toString('base64').replace(/(.{64})/g, '$1\n').trimEnd()
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`
}
