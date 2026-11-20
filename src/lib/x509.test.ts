import test from 'node:test'
import assert from 'node:assert/strict'
import tls from 'node:tls'
import {X509Certificate} from 'node:crypto'
import {selfSignedCertificate} from './x509.js'

const pair = selfSignedCertificate({commonName: 'mihanidown front', dns: ['www.youtube.com', '*.googlevideo.com']})

test('the DER parses as a certificate', () => {
  const cert = new X509Certificate(pair.certPem)
  assert.match(cert.subject, /CN=mihanidown front/)
  assert.equal(cert.issuer, cert.subject, 'self-signed: issuer equals subject')
  assert.ok(cert.subjectAltName?.includes('www.youtube.com'))
  assert.ok(cert.subjectAltName?.includes('*.googlevideo.com'))
  assert.equal(cert.ca, false, 'must not be a CA — it must not be able to sign other certificates')
  assert.equal(cert.publicKey.asymmetricKeyType, 'rsa')
  assert.ok((cert.publicKey as {asymmetricKeyDetails?: {modulusLength?: number}}).asymmetricKeyDetails?.modulusLength === 2048)
})

test('the signature verifies against its own public key', () => {
  const cert = new X509Certificate(pair.certPem)
  assert.equal(cert.verify(cert.publicKey), true)
})

test('validity window straddles now', () => {
  const cert = new X509Certificate(pair.certPem)
  const now = Date.now()
  assert.ok(Date.parse(cert.validFrom) < now, cert.validFrom)
  assert.ok(Date.parse(cert.validTo) > now, cert.validTo)
})

function handshake(servername: string): Promise<{ok: boolean; error?: string}> {
  return new Promise(resolve => {
    const server = tls.createServer({key: pair.keyPem, cert: pair.certPem}, socket => {
      socket.end('ok')
    })
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as {port: number}).port
      const client = tls.connect({host: '127.0.0.1', port, servername, ca: [pair.certPem], rejectUnauthorized: true}, () => {
        client.destroy()
        server.close()
        resolve({ok: true})
      })
      client.on('error', error => {
        client.destroy()
        server.close()
        resolve({ok: false, error: (error as Error & {code?: string}).code ?? error.message})
      })
    })
  })
}

test('a real TLS client accepts it for a name in the SAN list', async () => {
  const r = await handshake('www.youtube.com')
  assert.equal(r.error, undefined, r.error)
  assert.equal(r.ok, true)
})

test('and rejects it for a name that is not', async () => {
  const r = await handshake('evil.example')
  assert.equal(r.ok, false)
  assert.match(String(r.error), /ALTNAME|UNABLE_TO_VERIFY|ERR/)
})

test('key usage says server authentication', () => {
  const cert = new X509Certificate(pair.certPem)
  // 0x05 unused bits + 0xA0 == digitalSignature | keyEncipherment
  assert.ok(Buffer.from(cert.raw).includes(Buffer.from([0x05, 0xa0])), 'keyUsage extension bytes')
})
