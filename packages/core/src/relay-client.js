// Using always-on relays (see relay-protocol.js). For every file that lists
// a relay, this computer keeps the file's current box on that relay up to
// date and reads what others left there, so two people never need to be
// online at the same time.
//
// Every blob is sealed with the file's key and signed by its writer:
//   sealed( u32 headLength | { k: 'u' | 'm', by, sig, inv? } | data )
//   k 'u': a Yjs update     k 'm': the membership log (JSON)
// Readers check the signature and that the writer may edit (from the
// membership log, or the invite they joined with), exactly as for edits
// that arrive from a peer.
//
// Catching up: on connecting, read everything after the last blob seen,
// then send whatever the relay doesn't have yet, judged from the state
// vectors of what's there. While connected, every change goes up live and
// the relay passes it on to everyone else connected.
//
// Uploaded files: each relay also keeps the chunks of the files that list
// it (see relay-protocol.js), so a file downloads even when nobody who has
// it is online. Every relay connection is a chunk source for the engine's
// chunk exchange, so chunks from a relay pass the same checks (asked for,
// hash matches, within this computer's limits) as chunks from a peer.

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { seal, open, fileStoreKeys } from './crypto.js'
import { canEdit, canRespond, canComment } from './members.js'
import { isCommentUpdate } from './threads.js'
import { isResponseUpdate } from './respond.js'
import { verifySignature } from './identity.js'
import { MsgReader, encodeMsg, boxKeys, putProof, compactProof, chunkProof, sha256hex, MAX_NAMES } from './relay-protocol.js'

const PUTS_IN_FLIGHT = 4 // chunks being sent to one relay at once

const blobProof = (docId, box, data) => `commonplace/relay/v1/blob|${docId}|${box}|${sha256hex(data)}`

export class RelayClient extends EventEmitter {
  // connect(keyBuffer) / disconnect(keyBuffer) ask the transport to keep a
  // connection to a relay open (the transport hands it back via addConnection).
  // compactAfter: blobs in a box before someone rewrites it as one.
  constructor (engine, { connect, disconnect, compactAfter = 200 }) {
    super()
    this.engine = engine
    this.compactAfter = compactAfter
    this.connect = connect
    this.disconnect = disconnect
    this.docRelays = new Map() // docId -> Set(relayKey)
    this.links = new Map() // relayKey -> { send, boxes: Map(box -> state) }
    this.boxCache = new Map() // epoch secret (hex) -> boxKeys
    this.stores = new Map() // docId -> the file's chunk store keys
    this.chunksOf = () => [] // set by the Drive: the chunk hashes a file lists
    this._seedTimers = new Map()
    engine.on('update', (docId, update, origin) => {
      if (origin !== this && origin !== 'disk') this._pushUpdate(docId, update)
      if (origin !== 'disk') this._scheduleSeed(docId)
    })
    engine.chunks.on('chunk', (docId) => this._scheduleSeed(docId))
    engine.on('members', (docId) => this._pushMembers(docId))
    engine.on('outbox', (docId) => this._pushOwn(docId))
    engine.on('topics', (docId) => this._refreshDoc(docId))
  }

  isRelay (keyHex) {
    for (const set of this.docRelays.values()) if (set.has(keyHex)) return true
    return false
  }

  // Which relays a file uses (from the file itself, or the invite).
  setRelays (docId, keys) {
    const next = new Set(keys.filter((k) => /^[0-9a-f]{64}$/.test(k)))
    const before = new Set([...this.docRelays.values()].flatMap((s) => [...s]))
    if (next.size) this.docRelays.set(docId, next)
    else this.docRelays.delete(docId)
    const after = new Set([...this.docRelays.values()].flatMap((s) => [...s]))
    for (const k of after) if (!before.has(k)) this.connect(Buffer.from(k, 'hex'))
    for (const k of before) if (!after.has(k)) { this.disconnect(Buffer.from(k, 'hex')); this.links.get(k)?.socket.destroy() }
    this._refreshDoc(docId)
  }

  relaysOf (docId) {
    return [...(this.docRelays.get(docId) || [])]
  }

  // { key, online, lastSyncedAt } for each relay a file uses.
  status (docId) {
    return this.relaysOf(docId).map((key) => {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId)
      const saved = this._saved(docId)[key]
      return { key, online: Boolean(state?.caughtUp), lastSyncedAt: saved?.at || null }
    })
  }

  addConnection (socket, keyHex) {
    const old = this.links.get(keyHex)
    if (old) old.socket.destroy()
    const link = { socket, send: (head, payload) => socket.write(encodeMsg(head, payload)), boxes: new Map(), pending: new Map(), calls: new Map(), puts: [], putting: 0, known: new Set(), files: true }
    link.chunkConn = { relay: keyHex, chunkSend: (type, docId, plain) => this._ask(link, docId, type, plain) }
    this.links.set(keyHex, link)
    const reader = new MsgReader((head, payload) => this._onMessage(keyHex, link, head, payload))
    socket.on('data', (chunk) => { try { reader.push(chunk) } catch { socket.destroy() } })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.links.get(keyHex) === link) this.links.delete(keyHex)
      this.engine.chunks.dropConnection(link.chunkConn)
      for (const s of link.boxes.values()) this._status(s.docId)
    })
    for (const [docId, keys] of this.docRelays) if (keys.has(keyHex)) this._refreshDoc(docId)
  }

  // ---- per file ------------------------------------------------------------------

  _box (doc) {
    const epoch = doc.contentEpoch
    if (epoch == null) return null
    const secret = doc.epochs.get(epoch)?.secret
    if (!secret) return null
    const id = secret.toString('hex')
    if (!this.boxCache.has(id)) this.boxCache.set(id, { epoch, ...boxKeys(secret) })
    return this.boxCache.get(id)
  }

  // Starts (or moves to) the file's current box on each connected relay.
  _refreshDoc (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    const box = this._box(doc)
    for (const key of this.relaysOf(docId)) {
      const link = this.links.get(key)
      if (!link) continue
      for (const [b, s] of link.boxes) if (s.docId === docId && b !== box?.box) link.boxes.delete(b)
      if (!box || link.boxes.has(box.box)) continue
      const saved = this._saved(docId)[key]
      const resume = saved?.box === box.box
      const state = {
        docId,
        keys: box,
        epoch: box.epoch,
        after: resume ? saved.after : 0,
        sv: resume && saved.sv ? Y.decodeStateVector(Buffer.from(saved.sv, 'base64')) : new Map(),
        lastHash: resume ? saved.lastHash : null,
        answers: resume ? saved.answers : undefined,
        caughtUp: false
      }
      link.boxes.set(box.box, state)
      link.send({ t: 'get', box: box.box, after: state.after })
    }
  }

  _onMessage (key, link, head, payload) {
    if (head.id && link.calls.has(head.id)) return this._onChunkReply(link, head, payload)
    const state = link.boxes.get(head.box)
    if (!state) return
    const doc = this.engine.getDoc(state.docId)
    if (!doc) return
    if (head.t === 'blob') {
      this._receive(doc, state, payload)
      if (head.seq > state.after) state.after = head.seq
      if (state.caughtUp) this._save(key, state) // while catching up, saved once at the end
    } else if (head.t === 'end') {
      state.caughtUp = true
      this._catchUp(key, link, doc, state, head)
      this._save(key, state)
      this.engine.chunks.pump(doc.docId) // the relay may have chunks this computer is waiting for
      this.seedChunks(doc.docId)
    } else if (head.t === 'ok') {
      const sent = link.pending.get(head.id)
      link.pending.delete(head.id)
      if (sent?.sv) { mergeSV(state.sv, sent.sv); state.lastHash = sent.hash || state.lastHash; this._save(key, state) }
    }
  }

  // Applies one blob from the relay, if it's genuine and its writer may edit.
  _receive (doc, state, sealed) {
    const plain = open(doc.keyFor(state.epoch), sealed)
    if (!plain || plain.length < 4) return
    let head
    try { head = JSON.parse(plain.subarray(4, 4 + plain.readUInt32BE(0)).toString('utf8')) } catch { return }
    const data = plain.subarray(4 + plain.readUInt32BE(0))
    if (typeof head.by !== 'string' || !verifySignature(head.by, blobProof(doc.docId, state.keys.box, data), Buffer.from(String(head.sig || ''), 'base64'))) return
    if (head.k === 'm') {
      let entries
      try { entries = JSON.parse(data.toString('utf8')) } catch { return }
      this.engine.mergeMembers(doc.docId, entries)
      return
    }
    if (head.k !== 'u' || this.engine.isBlocked(head.by)) return
    const role = doc.members.exists ? doc.members.roleOf(head.by, head.inv && typeof head.inv === 'object' ? head.inv : null)?.role : 'editor'
    // Editors may change anything; respondents may only add their answers,
    // and commenters may only change the comments.
    if (!canEdit(role) && !(canRespond(role) && isResponseUpdate(data, head.by) && this.engine.answerAllowed(doc, head.by)) &&
      !(canComment(role) && isCommentUpdate(doc.ydoc, data))) return
    try { Y.applyUpdate(doc.ydoc, data, this) } catch { return }
    try { mergeSV(state.sv, Y.decodeStateVector(Y.encodeStateVectorFromUpdate(data))) } catch {}
  }

  // After reading everything: send what the relay is missing, and rewrite
  // the box as one blob when it has grown long.
  _catchUp (key, link, doc, state, head) {
    if (canRespond(doc.myAccess?.role) || canComment(doc.myAccess?.role)) { this._putOwn(key, link, doc, state); return }
    if (!this._mayWrite(doc)) return
    if (doc.members.exists) this._put(link, doc, state, 'm', Buffer.from(JSON.stringify(doc.members.entries)))
    if (head.count > this.compactAfter) {
      const full = this._seal(doc, state, 'u', Y.encodeStateAsUpdate(doc.ydoc))
      link.send({ t: 'compact', box: state.keys.box, upTo: head.last, sig: state.keys.sign(compactProof(state.keys.box, head.last, full)) }, full)
      state.sv = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc))
      this._save(key, state)
      return
    }
    const diff = Y.encodeStateAsUpdate(doc.ydoc, Y.encodeStateVector(state.sv))
    const hash = sha256hex(diff)
    if (hash === state.lastHash || isEmptyUpdate(diff)) return
    this._put(link, doc, state, 'u', diff, { sv: Y.decodeStateVector(Y.encodeStateVector(doc.ydoc)), hash })
  }

  _pushUpdate (docId, update) {
    const doc = this.engine.getDoc(docId)
    if (!doc || !this._mayWrite(doc)) return
    for (const key of this.relaysOf(docId)) {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId && s.caughtUp)
      if (!state) continue
      let sv = null
      try { sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)) } catch {}
      this._put(link, doc, state, 'u', Buffer.from(update), { sv })
    }
  }

  // As a respondent or commenter: leave my answers or comments in the box,
  // once each.
  _putOwn (key, link, doc, state) {
    const sent = new Set(this._saved(doc.docId)[key]?.answers || [])
    for (const update of this.engine.outbox(doc.docId)) {
      const hash = sha256hex(update)
      if (sent.has(hash)) continue
      this._put(link, doc, state, 'u', update)
      sent.add(hash)
    }
    state.answers = [...sent]
    this._save(key, state)
  }

  _pushOwn (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    for (const key of this.relaysOf(docId)) {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId && s.caughtUp)
      if (state) this._putOwn(key, link, doc, state)
    }
  }

  _pushMembers (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc?.members.exists) return
    this._refreshDoc(docId) // the key may have changed
    for (const key of this.relaysOf(docId)) {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId && s.caughtUp)
      if (state && this._mayWrite(doc)) this._put(link, doc, state, 'm', Buffer.from(JSON.stringify(doc.members.entries)))
    }
  }

  _mayWrite (doc) {
    return doc.contentEpoch != null && (!doc.members.exists || canEdit(doc.myAccess?.role))
  }

  _seal (doc, state, kind, data) {
    const head = Buffer.from(JSON.stringify({
      k: kind,
      by: this.engine.identity.userId,
      sig: this.engine.identity.sign(blobProof(doc.docId, state.keys.box, data)).toString('base64'),
      inv: doc.members.member(this.engine.identity.userId) ? undefined : doc.invite || undefined
    }))
    const len = Buffer.alloc(4)
    len.writeUInt32BE(head.length)
    return seal(doc.keyFor(state.epoch), Buffer.concat([len, head, data]))
  }

  _put (link, doc, state, kind, data, extra = {}) {
    const blob = this._seal(doc, state, kind, data)
    const id = crypto.randomBytes(6).toString('hex')
    link.pending.set(id, extra)
    link.send({ t: 'put', box: state.keys.box, sig: state.keys.sign(putProof(state.keys.box, blob)), id }, blob)
  }

  // ---- uploaded files' chunks -----------------------------------------------------

  _store (doc) {
    if (!this.stores.has(doc.docId)) {
      const k = fileStoreKeys(doc.secret)
      this.stores.set(doc.docId, { ...boxKeys(k.storeSecret), encKey: k.encKey, nameKey: k.nameKey })
    }
    return this.stores.get(doc.docId)
  }

  _chunkName (store, hash) {
    return crypto.createHmac('sha256', store.nameKey).update(hash).digest('hex')
  }

  // Relays that can hand out a file's chunks right now (for the engine).
  chunkSources (docId) {
    return this.relaysOf(docId).map((k) => this.links.get(k)).filter((l) => l?.files).map((l) => l.chunkConn)
  }

  // The chunk exchange asking a relay for chunks, as it would a peer.
  _ask (link, docId, type, plain) {
    const doc = this.engine.getDoc(docId)
    if (!doc || type !== this.engine.chunks.T.WANT) return
    let hashes
    try { hashes = JSON.parse(plain.toString('utf8')).h } catch { return }
    const store = this._store(doc)
    for (const hash of Array.isArray(hashes) ? hashes : []) {
      const id = crypto.randomBytes(6).toString('hex')
      link.calls.set(id, { kind: 'get', docId, hash })
      link.send({ t: 'cget', box: store.box, name: this._chunkName(store, hash), id })
    }
  }

  _onChunkReply (link, head, payload) {
    const call = link.calls.get(head.id)
    link.calls.delete(head.id)
    const T = this.engine.chunks.T
    if (head.t === 'error') {
      if (head.reason === 'full') link.full = true
      else if (head.reason === 'unknown message') link.files = false // a relay from before files
    }
    if (call.kind === 'get') {
      const doc = this.engine.getDoc(call.docId)
      const plain = head.t === 'chunk' && doc ? open(this._store(doc).encKey, payload) : null
      if (plain) this.engine.chunks.onMessage(call.docId, link.chunkConn, T.CHUNK, Buffer.concat([Buffer.from(call.hash, 'hex'), plain]))
      else this.engine.chunks.onMessage(call.docId, link.chunkConn, T.NOCHUNK, Buffer.from(JSON.stringify({ h: [call.hash] })))
    } else if (call.kind === 'has') {
      if (head.t !== 'have') return
      const have = new Set(head.names)
      for (const [name, hash] of call.names) {
        if (have.has(name)) link.known.add(name)
        else link.puts.push({ docId: call.docId, hash, name })
      }
      this._pumpPuts(link)
    } else if (call.kind === 'put') {
      link.putting--
      if (head.t === 'ok') link.known.add(call.name)
      this._pumpPuts(link)
    }
  }

  _scheduleSeed (docId) {
    if (!this.docRelays.has(docId) || this._seedTimers.has(docId)) return
    const t = setTimeout(() => { this._seedTimers.delete(docId); this.seedChunks(docId) }, 1500)
    t.unref?.()
    this._seedTimers.set(docId, t)
  }

  // Leaves on each of the file's relays the chunks this computer has that
  // the relay doesn't, so the file can download while this computer is off.
  seedChunks (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    const blobs = this.engine.chunks.blobs
    const hashes = [...new Set(this.chunksOf(docId))].filter((h) => blobs.has(h))
    if (!hashes.length) return
    const store = this._store(doc)
    for (const key of this.relaysOf(docId)) {
      const link = this.links.get(key)
      if (!link?.files || link.full) continue
      const unknown = hashes.map((h) => [this._chunkName(store, h), h]).filter(([name]) => !link.known.has(name) && !link.puts.some((p) => p.name === name))
      for (let i = 0; i < unknown.length; i += MAX_NAMES) {
        const names = unknown.slice(i, i + MAX_NAMES)
        const id = crypto.randomBytes(6).toString('hex')
        link.calls.set(id, { kind: 'has', docId, names })
        link.send({ t: 'chas', box: store.box, names: names.map(([n]) => n), id })
      }
    }
  }

  _pumpPuts (link) {
    while (link.putting < PUTS_IN_FLIGHT && link.puts.length && !link.full) {
      const { docId, hash, name } = link.puts.shift()
      const doc = this.engine.getDoc(docId)
      const blobs = this.engine.chunks.blobs
      if (!doc || !blobs.has(hash) || link.known.has(name)) continue
      const store = this._store(doc)
      const sealed = seal(store.encKey, blobs.read(hash))
      const id = crypto.randomBytes(6).toString('hex')
      link.calls.set(id, { kind: 'put', name })
      link.putting++
      link.send({ t: 'cput', box: store.box, name, sig: store.sign(chunkProof(store.box, name, sealed)), id }, sealed)
    }
    if (link.full) link.puts.length = 0
  }

  // ---- bookkeeping ------------------------------------------------------------

  _saved (docId) {
    return this.engine.store.readJSON(docId, 'helpers') || {}
  }

  _save (key, state) {
    const all = this._saved(state.docId)
    all[key] = { box: state.keys.box, after: state.after, sv: Buffer.from(Y.encodeStateVector(state.sv)).toString('base64'), lastHash: state.lastHash, answers: state.answers, at: Date.now() }
    this.engine.store.writeJSON(state.docId, 'helpers', all) // (stored under its old name)
    this._status(state.docId)
  }

  _status (docId) {
    this.emit('status', docId)
  }
}

function mergeSV (into, from) {
  if (!from) return
  for (const [client, clock] of from) if (clock > (into.get(client) || 0)) into.set(client, clock)
}

// An update with no new content and an empty delete set.
function isEmptyUpdate (update) {
  try {
    const { structs, ds } = Y.decodeUpdate(update)
    return structs.length === 0 && ds.clients.size === 0
  } catch {
    return true
  }
}
