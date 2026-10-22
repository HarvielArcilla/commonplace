// The always-on relay: a blind mailbox store that keeps encrypted copies of
// files for people who aren't online at the same time, and passes new
// changes along live to whoever is connected. See core/src/relay-protocol.js
// for what it can and can't see.
//
// Storage, one folder per box:
//   boxes/<box>/log.bin    u32 seq | u32 length | blob, appended
//   boxes/<box>/meta.json  { last, count, bytes }
// and one per file whose uploads it keeps:
//   chunks/<store>/<name>  one sealed chunk

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import Hyperswarm from 'hyperswarm'
import DHT from 'hyperdht'
import {
  MsgReader, encodeMsg, verifyBox, putProof, compactProof, dropProof, chunkProof, formatRelayAddress, MAX_RELAY_CHUNK, MAX_NAMES
} from '@commonplace/core/relay-protocol'

const BOX = /^[0-9a-f]{64}$/
const NAME = /^[0-9a-f]{64}$/

export class RelayServer extends EventEmitter {
  // quotaBytes: the most this relay stores in total, across every box.
  // files: whether it also keeps uploaded files' chunks (they count toward
  // the same quota).
  constructor ({ dir, swarm = {}, quotaBytes = 4 * 1024 ** 3, files = true } = {}) {
    super()
    this.dir = dir
    this.quotaBytes = quotaBytes
    this.files = files
    this.chunkBytes = 0
    this.swarmOpts = swarm
    this.boxes = new Map() // box -> { last, count, bytes, subs: Set(conn) }
    this.connections = new Set()
  }

  get address () { return formatRelayAddress(this.swarm.keyPair.publicKey.toString('hex')) }

  get usedBytes () {
    let n = this.chunkBytes
    for (const b of this.boxes.values()) n += b.bytes
    return n
  }

  async start () {
    fs.mkdirSync(path.join(this.dir, 'boxes'), { recursive: true })
    for (const name of fs.readdirSync(path.join(this.dir, 'boxes'))) {
      if (!BOX.test(name)) continue
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'boxes', name, 'meta.json'), 'utf8'))
        this.boxes.set(name, { last: meta.last, count: meta.count, bytes: meta.bytes, subs: new Set() })
      } catch {}
    }
    this.chunkBytes = countBytes(path.join(this.dir, 'chunks'))
    this.swarm = new Hyperswarm({ ...this.swarmOpts, keyPair: this.swarmOpts.keyPair || loadKeyPair(this.dir) })
    this.swarm.on('connection', (socket) => this.accept(socket))
    await this.swarm.listen()
    return this.address
  }

  async stop () {
    await this.swarm?.destroy()
  }

  get key () { return this.swarm?.keyPair.publicKey.toString('hex') || null }

  // How full it is, for the app's settings.
  stats () {
    return { boxes: this.boxes.size, usedBytes: this.usedBytes, quotaBytes: this.quotaBytes, connections: this.connections.size }
  }

  // Takes a connection: from the network, or in memory from a Drive running
  // in the same process.
  accept (socket) {
    socket.on('error', () => {})
    const conn = { socket, send: (head, payload) => socket.write(encodeMsg(head, payload)) }
    this.connections.add(conn)
    const reader = new MsgReader((head, payload) => {
      try { this._onMessage(conn, head, payload) } catch (err) { conn.send({ t: 'error', box: head.box, id: head.id, reason: err.message }) }
    })
    socket.on('data', (chunk) => { try { reader.push(chunk) } catch { socket.destroy() } })
    socket.on('close', () => {
      this.connections.delete(conn)
      for (const b of this.boxes.values()) b.subs.delete(conn)
    })
    this.emit('connection')
  }

  _onMessage (conn, head, payload) {
    const box = String(head.box || '')
    if (!BOX.test(box)) throw new Error('bad box')
    if (head.t === 'get') return this._get(conn, box, Number(head.after) || 0)
    if (head.t === 'put') return this._put(conn, box, head, payload)
    if (head.t === 'compact') return this._compact(conn, box, head, payload)
    if (head.t === 'drop') return this._drop(conn, box, head)
    if (this.files && head.t === 'chas') return this._chunksHas(conn, box, head)
    if (this.files && head.t === 'cput') return this._chunkPut(conn, box, head, payload)
    if (this.files && head.t === 'cget') return this._chunkGet(conn, box, head)
    throw new Error('unknown message')
  }

  _get (conn, box, after) {
    const b = this.boxes.get(box) || this._newBox(box, false)
    for (const { seq, blob } of this._read(box)) if (seq > after) conn.send({ t: 'blob', box, seq }, blob)
    conn.send({ t: 'end', box, last: b.last, count: b.count })
    b.subs.add(conn)
  }

  _put (conn, box, head, payload) {
    if (!verifyBox(box, putProof(box, payload), head.sig)) throw new Error('bad signature')
    if (this.usedBytes + payload.length > this.quotaBytes) throw new Error('full')
    const b = this.boxes.get(box) || this._newBox(box, true)
    const seq = b.last + 1
    this._append(box, seq, payload)
    b.last = seq
    b.count++
    b.bytes += payload.length + 8
    this._saveMeta(box)
    conn.send({ t: 'ok', box, seq, id: head.id })
    for (const other of b.subs) if (other !== conn) other.send({ t: 'blob', box, seq }, payload)
  }

  // Replaces every blob up to `upTo` with one (the whole file, re-sealed by
  // whoever compacts), so a box doesn't grow forever.
  _compact (conn, box, head, payload) {
    const b = this.boxes.get(box)
    const upTo = Number(head.upTo)
    if (!b || !(upTo > 0) || upTo > b.last) throw new Error('nothing to compact')
    if (!verifyBox(box, compactProof(box, upTo, payload), head.sig)) throw new Error('bad signature')
    const keep = this._read(box).filter((x) => x.seq > upTo)
    const dir = path.join(this.dir, 'boxes', box)
    const tmp = path.join(dir, 'log.bin.tmp')
    fs.writeFileSync(tmp, Buffer.concat([frame(upTo, payload), ...keep.map((x) => frame(x.seq, x.blob))]))
    fs.renameSync(tmp, path.join(dir, 'log.bin'))
    b.count = 1 + keep.length
    b.bytes = payload.length + 8 + keep.reduce((n, x) => n + x.blob.length + 8, 0)
    this._saveMeta(box)
    conn.send({ t: 'ok', box, seq: upTo, id: head.id })
  }

  _drop (conn, box, head) {
    if (!verifyBox(box, dropProof(box), head.sig)) throw new Error('bad signature')
    this.boxes.delete(box)
    fs.rmSync(path.join(this.dir, 'boxes', box), { recursive: true, force: true })
    conn.send({ t: 'ok', box, id: head.id })
  }

  // ---- uploaded files' chunks ------------------------------------------------

  _chunkFile (box, name) {
    if (!NAME.test(String(name || ''))) throw new Error('bad chunk name')
    return path.join(this.dir, 'chunks', box, name)
  }

  _chunksHas (conn, box, head) {
    const names = (Array.isArray(head.names) ? head.names : []).slice(0, MAX_NAMES)
    conn.send({ t: 'have', box, id: head.id, names: names.filter((n) => NAME.test(String(n)) && fs.existsSync(this._chunkFile(box, n))) })
  }

  _chunkPut (conn, box, head, payload) {
    const file = this._chunkFile(box, head.name)
    if (payload.length > MAX_RELAY_CHUNK) throw new Error('too big')
    if (!verifyBox(box, chunkProof(box, head.name, payload), head.sig)) throw new Error('bad signature')
    if (!fs.existsSync(file)) {
      if (this.usedBytes + payload.length > this.quotaBytes) throw new Error('full')
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(`${file}.tmp`, payload)
      fs.renameSync(`${file}.tmp`, file)
      this.chunkBytes += payload.length
    }
    conn.send({ t: 'ok', box, id: head.id })
  }

  _chunkGet (conn, box, head) {
    const file = this._chunkFile(box, head.name)
    let data = null
    try { data = fs.readFileSync(file) } catch {}
    if (data) conn.send({ t: 'chunk', box, name: head.name, id: head.id }, data)
    else conn.send({ t: 'nochunk', box, name: head.name, id: head.id })
  }

  _newBox (box, persist) {
    const b = { last: 0, count: 0, bytes: 0, subs: new Set() }
    this.boxes.set(box, b)
    if (persist) { fs.mkdirSync(path.join(this.dir, 'boxes', box), { recursive: true }); this._saveMeta(box) }
    return b
  }

  _append (box, seq, blob) {
    fs.mkdirSync(path.join(this.dir, 'boxes', box), { recursive: true })
    fs.appendFileSync(path.join(this.dir, 'boxes', box, 'log.bin'), frame(seq, blob))
  }

  _read (box) {
    let buf
    try { buf = fs.readFileSync(path.join(this.dir, 'boxes', box, 'log.bin')) } catch { return [] }
    const out = []
    for (let off = 0; off + 8 <= buf.length;) {
      const seq = buf.readUInt32BE(off)
      const len = buf.readUInt32BE(off + 4)
      if (off + 8 + len > buf.length) break // torn final write
      out.push({ seq, blob: buf.subarray(off + 8, off + 8 + len) })
      off += 8 + len
    }
    return out
  }

  _saveMeta (box) {
    const { last, count, bytes } = this.boxes.get(box)
    fs.writeFileSync(path.join(this.dir, 'boxes', box, 'meta.json'), JSON.stringify({ last, count, bytes }))
  }
}

function countBytes (dir) {
  let n = 0
  for (const store of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!BOX.test(store)) continue
    for (const name of fs.readdirSync(path.join(dir, store))) {
      if (NAME.test(name)) { try { n += fs.statSync(path.join(dir, store, name)).size } catch {} }
    }
  }
  return n
}

function frame (seq, blob) {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(seq, 0)
  head.writeUInt32BE(blob.length, 4)
  return Buffer.concat([head, blob])
}

// The relay's address is its public key, so it must stay the same.
function loadKeyPair (dir) {
  const file = path.join(dir, 'key.json')
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return { publicKey: Buffer.from(saved.publicKey, 'hex'), secretKey: Buffer.from(saved.secretKey, 'hex') }
  } catch {}
  const kp = DHT.keyPair()
  fs.writeFileSync(file, JSON.stringify({ publicKey: kp.publicKey.toString('hex'), secretKey: kp.secretKey.toString('hex') }), { mode: 0o600 })
  return kp
}
