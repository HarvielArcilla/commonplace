// Uploaded files travel as chunks named by their SHA-256, outside the
// document's edit history (so a 50 MB video doesn't sit in every update log
// or relay box). The file's document lists its chunks; this moves them.
//
//   WANT     sealed(json { h: [hash, ...] })   "send me these"
//   CHUNK    sealed(32-byte hash | data)       one chunk
//   NOCHUNK  sealed(json { h: [hash, ...] })   "I don't have these"
//
// Protection for the person receiving:
//   - a chunk is only accepted from the connection it was asked of, only
//     while the request is open, and only if its hash matches, so nobody can
//     push data onto your disk that you didn't ask for;
//   - nothing is asked for unless the app decided to (see drive/files.js:
//     size limits, approval, free space).
// And for the person sending: chunks are only served to members of the file
// they belong to (allow(docId, hash)), so one file's connection can't be
// used to find out what other files you have.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'

export const CHUNK_SIZE = 256 * 1024
const MAX_ASK = 32 // hashes per WANT
const IN_FLIGHT = 8 // per connection per file
const TIMEOUT_MS = 30e3

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const HEX64 = /^[0-9a-f]{64}$/

export class BlobStore {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  _path (hash) {
    if (!HEX64.test(hash)) throw new Error('bad chunk name')
    return path.join(this.dir, hash.slice(0, 2), hash)
  }

  has (hash) { try { return fs.statSync(this._path(hash)).isFile() } catch { return false } }
  read (hash) { return fs.readFileSync(this._path(hash)) }
  size (hash) { try { return fs.statSync(this._path(hash)).size } catch { return 0 } }
  age (hash) { try { return Date.now() - fs.statSync(this._path(hash)).mtimeMs } catch { return Infinity } }

  // Writes a chunk only if it is what its name says.
  write (hash, data) {
    if (sha256(data) !== hash) return false
    const file = this._path(hash)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, file)
    return true
  }

  remove (hash) { try { fs.rmSync(this._path(hash), { force: true }) } catch {} }

  all () {
    const out = []
    for (const sub of fs.existsSync(this.dir) ? fs.readdirSync(this.dir) : []) {
      if (!/^[0-9a-f]{2}$/.test(sub)) continue
      for (const name of fs.readdirSync(path.join(this.dir, sub))) if (HEX64.test(name)) out.push(name)
    }
    return out
  }

  totalBytes () {
    return this.all().reduce((n, h) => n + this.size(h), 0)
  }
}

export class ChunkExchange extends EventEmitter {
  // send(conn, type, docId, plain): sends a sealed message on the file's
  // current epoch. links(docId): connections exchanging content for it.
  // allow(docId, hash): whether a chunk belongs to that file.
  constructor ({ blobs, send, links, allow = () => false, types }) {
    super()
    this.blobs = blobs
    this.send = send
    this.links = links
    this.allow = allow
    this.T = types
    this.wanted = new Map() // docId -> Set(hash)
    this.inflight = new Map() // `${docId}:${hash}` -> { conn, at }
    this.lacks = new WeakMap() // conn -> Set(hash) it said it doesn't have
    this.timer = setInterval(() => this._expire(), 5000)
    this.timer.unref?.()
  }

  // Asks peers for these chunks of a file, as they become available.
  want (docId, hashes) {
    const set = this.wanted.get(docId) || new Set()
    for (const h of hashes) if (HEX64.test(h) && !this.blobs.has(h)) set.add(h)
    if (set.size) this.wanted.set(docId, set)
    this.pump(docId)
  }

  cancel (docId) {
    this.wanted.delete(docId)
    for (const key of [...this.inflight.keys()]) if (key.startsWith(`${docId}:`)) this.inflight.delete(key)
  }

  pending (docId) { return this.wanted.get(docId)?.size || 0 }

  // Spreads what's still wanted over the connected peers.
  pump (docId) {
    const set = this.wanted.get(docId)
    if (!set?.size) return
    const conns = this.links(docId)
    if (!conns.length) return
    const load = new Map(conns.map((c) => [c, 0]))
    for (const [key, f] of this.inflight) if (key.startsWith(`${docId}:`) && load.has(f.conn)) load.set(f.conn, load.get(f.conn) + 1)
    const asks = new Map()
    for (const hash of set) {
      if (this.inflight.has(`${docId}:${hash}`)) continue
      const conn = [...load.keys()].filter((c) => load.get(c) < IN_FLIGHT && !this.lacks.get(c)?.has(hash)).sort((a, b) => load.get(a) - load.get(b))[0]
      if (!conn) continue
      load.set(conn, load.get(conn) + 1)
      this.inflight.set(`${docId}:${hash}`, { conn, at: Date.now() })
      const list = asks.get(conn) || []
      list.push(hash)
      asks.set(conn, list)
    }
    for (const [conn, list] of asks) {
      for (let i = 0; i < list.length; i += MAX_ASK) this.send(conn, this.T.WANT, docId, Buffer.from(JSON.stringify({ h: list.slice(i, i + MAX_ASK) })))
    }
  }

  onMessage (docId, conn, type, plain) {
    if (type === this.T.WANT) {
      let ask
      try { ask = JSON.parse(plain.toString('utf8')).h } catch { return }
      if (!Array.isArray(ask)) return
      const missing = []
      for (const hash of ask.slice(0, MAX_ASK)) {
        if (typeof hash !== 'string' || !HEX64.test(hash) || !this.allow(docId, hash) || !this.blobs.has(hash)) { missing.push(hash); continue }
        this.send(conn, this.T.CHUNK, docId, Buffer.concat([Buffer.from(hash, 'hex'), this.blobs.read(hash)]))
      }
      if (missing.length) this.send(conn, this.T.NOCHUNK, docId, Buffer.from(JSON.stringify({ h: missing.filter((h) => typeof h === 'string') })))
    } else if (type === this.T.CHUNK) {
      if (plain.length < 32) return
      const hash = plain.subarray(0, 32).toString('hex')
      const key = `${docId}:${hash}`
      const asked = this.inflight.get(key)
      if (!asked || asked.conn !== conn) return // not something I asked this peer for
      this.inflight.delete(key)
      if (!this.blobs.write(hash, plain.subarray(32))) { this._lacks(conn, hash); this.pump(docId); return }
      this.wanted.get(docId)?.delete(hash)
      if (!this.wanted.get(docId)?.size) this.wanted.delete(docId)
      this.emit('chunk', docId, hash)
      this.pump(docId)
    } else if (type === this.T.NOCHUNK) {
      let list
      try { list = JSON.parse(plain.toString('utf8')).h } catch { return }
      for (const hash of Array.isArray(list) ? list : []) {
        const key = `${docId}:${hash}`
        if (this.inflight.get(key)?.conn === conn) this.inflight.delete(key)
        this._lacks(conn, hash)
      }
      this.pump(docId)
    }
  }

  _lacks (conn, hash) {
    const set = this.lacks.get(conn) || new Set()
    set.add(hash)
    this.lacks.set(conn, set)
  }

  // A peer that went quiet: ask someone else.
  _expire () {
    const now = Date.now()
    const docs = new Set()
    for (const [key, f] of this.inflight) {
      if (now - f.at < TIMEOUT_MS) continue
      this.inflight.delete(key)
      this._lacks(f.conn, key.split(':')[1])
      docs.add(key.split(':')[0])
    }
    for (const docId of docs) this.pump(docId)
  }

  // A connection closed: what it was sending goes to others.
  dropConnection (conn) {
    const docs = new Set()
    for (const [key, f] of this.inflight) if (f.conn === conn) { this.inflight.delete(key); docs.add(key.split(':')[0]) }
    for (const docId of docs) this.pump(docId)
  }

  destroy () { clearInterval(this.timer) }
}
