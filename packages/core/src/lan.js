// Same-network transport: computers on one Wi-Fi or office network find each
// other and sync directly, even with no internet.
//
// Each computer multicasts a small announcement every few seconds:
//
//   'CPL1' | public key (32) | TCP port (u16) | nonce (16) | tags (16 each)
//
// A tag is HMAC(topic, nonce) for each file topic it's syncing, so a
// computer that has the same file recognizes it, and nobody else on the
// network learns which files are there (the nonce changes every time). When
// two computers share a topic, the one with the smaller key dials the
// other over TCP, and the connection runs the same Noise handshake as the
// internet transport (Hyperswarm's secret-stream), authenticated by the
// announced key. The sync engine can't tell the two transports apart.

import dgram from 'node:dgram'
import net from 'node:net'
import crypto from 'node:crypto'
import SecretStream from '@hyperswarm/secret-stream'

const MAGIC = Buffer.from('CPL1')
const GROUP = '239.255.77.17'
const PORT = 47615
const HEAD = 4 + 32 + 2 + 16
const MAX_TAGS = 80 // keeps an announcement within one UDP packet

const tagFor = (topic, nonce) => crypto.createHmac('sha256', topic).update(nonce).digest().subarray(0, 16)

export class LanTransport {
  // keyPair: the same Noise key pair as the internet transport, so both
  // reach the engine as the same peer. topics() lists what I'm syncing now.
  constructor (engine, { keyPair = SecretStream.keyPair(), topics = () => [], group = GROUP, port = PORT, intervalMs = 3000 } = {}) {
    this.engine = engine
    this.keyPair = keyPair
    this.topics = topics
    this.group = group
    this.port = port
    this.intervalMs = intervalMs
    this.dialing = new Set()
    this.closed = false
  }

  async start () {
    this.server = net.createServer((socket) => this._accept(socket))
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, () => resolve()) })
    this.server.on('error', () => {})
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.udp.on('error', () => {}) // no network, or multicast not allowed: stay quiet
    this.udp.on('message', (msg, from) => this._onAnnounce(msg, from))
    await new Promise((resolve) => this.udp.bind(this.port, () => resolve()))
    try { this.udp.addMembership(this.group); this.udp.setMulticastLoopback(true) } catch {}
    this.timer = setInterval(() => this.announce(), this.intervalMs)
    this.timer.unref?.()
    this.announce()
  }

  announce () {
    if (this.closed) return
    const topics = this.topics()
    for (let i = 0; i < Math.max(1, topics.length); i += MAX_TAGS) {
      const nonce = crypto.randomBytes(16)
      const head = Buffer.alloc(HEAD)
      MAGIC.copy(head, 0)
      Buffer.from(this.keyPair.publicKey).copy(head, 4)
      head.writeUInt16BE(this.server.address().port, 36)
      nonce.copy(head, 38)
      const tags = topics.slice(i, i + MAX_TAGS).map((t) => tagFor(t, nonce))
      if (!tags.length) return
      this.udp.send(Buffer.concat([head, ...tags]), this.port, this.group, () => {})
    }
  }

  _onAnnounce (msg, from) {
    if (msg.length < HEAD || !msg.subarray(0, 4).equals(MAGIC) || (msg.length - HEAD) % 16) return
    const key = msg.subarray(4, 36)
    if (key.equals(Buffer.from(this.keyPair.publicKey))) return // my own
    const keyHex = key.toString('hex')
    // The smaller key dials, so two computers don't both connect.
    if (Buffer.compare(Buffer.from(this.keyPair.publicKey), key) > 0) return
    if (this.dialing.has(keyHex) || [...this.engine.connections].some((c) => c.remoteId === keyHex && !c.closed)) return
    const nonce = msg.subarray(38, 54)
    const tags = new Set()
    for (let off = HEAD; off < msg.length; off += 16) tags.add(msg.subarray(off, off + 16).toString('hex'))
    if (!this.topics().some((t) => tags.has(tagFor(t, nonce).toString('hex')))) return
    this._dial(from.address, msg.readUInt16BE(36), Buffer.from(key))
  }

  _dial (host, port, remotePublicKey) {
    const keyHex = remotePublicKey.toString('hex')
    this.dialing.add(keyHex)
    const socket = net.connect({ host, port })
    socket.setNoDelay(true)
    const stream = new SecretStream(true, socket, { keyPair: this.keyPair, remotePublicKey })
    const done = () => this.dialing.delete(keyHex)
    stream.on('error', done)
    stream.on('close', done)
    stream.once('open', () => { done(); this._hand(stream) })
    setTimeout(() => { if (!stream.opened) stream.destroy() }, 10000).unref?.()
  }

  _accept (socket) {
    socket.setNoDelay(true)
    const stream = new SecretStream(false, socket, { keyPair: this.keyPair })
    stream.on('error', () => {})
    stream.once('open', () => this._hand(stream))
    setTimeout(() => { if (!stream.opened) stream.destroy() }, 10000).unref?.()
  }

  _hand (stream) {
    if (this.closed) { stream.destroy(); return }
    stream.on('error', () => {})
    this.engine.addConnection(stream, {
      remoteId: Buffer.from(stream.remotePublicKey).toString('hex'),
      localId: Buffer.from(stream.publicKey).toString('hex')
    })
  }

  async destroy () {
    this.closed = true
    clearInterval(this.timer)
    try { this.udp?.close() } catch {}
    this.server?.close() // open connections are closed by the engine
  }
}
