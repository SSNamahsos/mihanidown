import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import {needsFront, sinkholed} from './front.js'

test('the youtube family is fronted', () => {
  for (const host of ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'i.ytimg.com', 'r3---sn-4g5ednsy.googlevideo.com', 'youtu.be', 'yt3.ggpht.com']) {
    assert.equal(needsFront(host), true, host)
  }
})

test('names that were measured as unanswered are not', () => {
  for (const host of ['www.google.com', 'play.googleapis.com', 'storage.googleapis.com', 'vimeo.com', 'example.com', 'notyoutube.com', 'youtube.com.evil.test']) {
    assert.equal(needsFront(host), false, host)
  }
})

test('youtubei is the one googleapis name that is filtered', () => {
  assert.equal(needsFront('youtubei.googleapis.com'), true)
  assert.equal(needsFront('www.googleapis.com'), false)
})

test('sinkhole answers are recognised', () => {
  assert.equal(sinkholed('10.10.34.36'), true, 'the internal block page')
  assert.equal(sinkholed('216.239.38.119'), true, "google's own nameserver range")
  assert.equal(sinkholed('192.168.1.5'), true)
  assert.equal(sinkholed('172.16.0.1'), true)
  assert.equal(sinkholed('not-an-ip'), true)
})

test('real google answers are not sinkholes', () => {
  for (const ip of ['142.251.13.94', '172.217.115.4', '74.125.11.105', '173.194.188.105', '142.250.154.139']) {
    assert.equal(sinkholed(ip), false, ip)
  }
})

test('a host the filter does not care about gets an ordinary tunnel', async () => {
  const {startFront} = await import('./front.js')
  // A local server stands in for an unfiltered site. Nothing about it is Google's,
  // so the proxy must not terminate it — the bytes must arrive untouched.
  const seen: string[] = []
  const origin = net.createServer(socket => {
    socket.on('data', d => {
      seen.push(d.toString('latin1'))
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nhi')
    })
  })
  await new Promise<void>(resolve => origin.listen(0, '127.0.0.1', resolve))
  const originPort = (origin.address() as net.AddressInfo).port

  const front = await startFront({blocked: true, dnsPoisoned: true, sniReset: true, usable: true, detail: 'test'})
  try {
    const proxyPort = Number(new URL(front.proxyUrl).port)
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({host: '127.0.0.1', port: proxyPort}, () => {
        socket.write(`CONNECT 127.0.0.1:${originPort} HTTP/1.1\r\nHost: 127.0.0.1:${originPort}\r\n\r\n`)
      })
      let text = ''
      let asked = false
      socket.on('data', d => {
        text += d.toString('latin1')
        if (!asked && text.includes('200 Connection Established')) {
          asked = true
          socket.write('GET /probe HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')
        }
        if (text.includes('hi')) {
          socket.destroy()
          resolve(text)
        }
      })
      socket.on('error', reject)
      socket.setTimeout(4000, () => (socket.destroy(), reject(new Error('tunnel timed out'))))
    })
    assert.match(reply, /200 OK/)
    assert.match(seen.join(''), /GET \/probe/, 'the request reached the origin intact')
  } finally {
    await front.close()
    origin.close()
  }
})
