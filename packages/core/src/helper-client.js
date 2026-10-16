// Using always-on helpers (see helper-protocol.js). For every file that lists
// a helper, this computer keeps the file's current box on that helper up to
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
// then send whatever the helper doesn't have yet, judged from the state
// vectors of what's there. While connected, every change goes up live and
// the helper passes it on to everyone else connected.

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import { seal, open } from './crypto.js'
import { canEdit, canRespond } from './members.js'
import { isResponseUpdate } from './respond.js'
import { verifySignature } from './identity.js'
import { MsgReader, encodeMsg, boxKeys, putProof, compactProof, sha256hex } from './helper-protocol.js'

const blobProof = (docId, box, data) => `commonplace/helper/v1/blob|${docId}|${box}|${sha256hex(data)}`

export class HelperClient extends EventEmitter {
  // connect(keyBuffer) / disconnect(keyBuffer) ask the transport to keep a
  // connection to a helper open (the transport hands it back via addConnection).
  // compactAfter: blobs in a box before someone rewrites it as one.
  constructor (engine, { connect, disconnect, compactAfter = 200 }) {
    super()
    this.engine = engine
    this.compactAfter = compactAfter
    this.connect = connect
    this.disconnect = disconnect
    this.docHelpers = new Map() // docId -> Set(helperKey)
    this.links = new Map() // helperKey -> { send, boxes: Map(box -> state) }
    this.boxCache = new Map() // epoch secret (hex) -> boxKeys
    engine.on('update', (docId, update, origin) => { if (origin !== this && origin !== 'disk') this._pushUpdate(docId, update) })
    engine.on('members', (docId) => this._pushMembers(docId))
    engine.on('response', (docId, update) => this._pushResponse(docId, update))
    engine.on('topics', (docId) => this._refreshDoc(docId))
  }

  isHelper (keyHex) {
    for (const set of this.docHelpers.values()) if (set.has(keyHex)) return true
    return false
  }

  // Which helpers a file uses (from the file itself, or the invite).
  setHelpers (docId, keys) {
    const next = new Set(keys.filter((k) => /^[0-9a-f]{64}$/.test(k)))
    const before = new Set([...this.docHelpers.values()].flatMap((s) => [...s]))
    if (next.size) this.docHelpers.set(docId, next)
    else this.docHelpers.delete(docId)
    const after = new Set([...this.docHelpers.values()].flatMap((s) => [...s]))
    for (const k of after) if (!before.has(k)) this.connect(Buffer.from(k, 'hex'))
    for (const k of before) if (!after.has(k)) { this.disconnect(Buffer.from(k, 'hex')); this.links.get(k)?.socket.destroy() }
    this._refreshDoc(docId)
  }

  helpersOf (docId) {
    return [...(this.docHelpers.get(docId) || [])]
  }

  // { key, online, lastSyncedAt } for each helper a file uses.
  status (docId) {
    return this.helpersOf(docId).map((key) => {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId)
      const saved = this._saved(docId)[key]
      return { key, online: Boolean(state?.caughtUp), lastSyncedAt: saved?.at || null }
    })
  }

  addConnection (socket, keyHex) {
    const old = this.links.get(keyHex)
    if (old) old.socket.destroy()
    const link = { socket, send: (head, payload) => socket.write(encodeMsg(head, payload)), boxes: new Map(), pending: new Map() }
    this.links.set(keyHex, link)
    const reader = new MsgReader((head, payload) => this._onMessage(keyHex, link, head, payload))
    socket.on('data', (chunk) => { try { reader.push(chunk) } catch { socket.destroy() } })
    socket.on('error', () => {})
    socket.on('close', () => {
      if (this.links.get(keyHex) === link) this.links.delete(keyHex)
      for (const s of link.boxes.values()) this._status(s.docId)
    })
    for (const [docId, keys] of this.docHelpers) if (keys.has(keyHex)) this._refreshDoc(docId)
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

  // Starts (or moves to) the file's current box on each connected helper.
  _refreshDoc (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    const box = this._box(doc)
    for (const key of this.helpersOf(docId)) {
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
    } else if (head.t === 'ok') {
      const sent = link.pending.get(head.id)
      link.pending.delete(head.id)
      if (sent?.sv) { mergeSV(state.sv, sent.sv); state.lastHash = sent.hash || state.lastHash; this._save(key, state) }
    }
  }

  // Applies one blob from the helper, if it's genuine and its writer may edit.
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
    if (head.k !== 'u') return
    const role = doc.members.exists ? doc.members.roleOf(head.by, head.inv && typeof head.inv === 'object' ? head.inv : null)?.role : 'editor'
    // Editors may change anything; respondents may only add their answers.
    if (!canEdit(role) && !(canRespond(role) && isResponseUpdate(data, head.by))) return
    try { Y.applyUpdate(doc.ydoc, data, this) } catch { return }
    try { mergeSV(state.sv, Y.decodeStateVector(Y.encodeStateVectorFromUpdate(data))) } catch {}
  }

  // After reading everything: send what the helper is missing, and rewrite
  // the box as one blob when it has grown long.
  _catchUp (key, link, doc, state, head) {
    if (canRespond(doc.myAccess?.role)) { this._putAnswers(key, link, doc, state); return }
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
    for (const key of this.helpersOf(docId)) {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId && s.caughtUp)
      if (!state) continue
      let sv = null
      try { sv = Y.decodeStateVector(Y.encodeStateVectorFromUpdate(update)) } catch {}
      this._put(link, doc, state, 'u', Buffer.from(update), { sv })
    }
  }

  // As a respondent: leave my answers in the box, once each.
  _putAnswers (key, link, doc, state) {
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

  _pushResponse (docId, update) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    for (const key of this.helpersOf(docId)) {
      const link = this.links.get(key)
      const state = link && [...link.boxes.values()].find((s) => s.docId === docId && s.caughtUp)
      if (state) this._putAnswers(key, link, doc, state)
    }
  }

  _pushMembers (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc?.members.exists) return
    this._refreshDoc(docId) // the key may have changed
    for (const key of this.helpersOf(docId)) {
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

  // ---- bookkeeping ------------------------------------------------------------

  _saved (docId) {
    return this.engine.store.readJSON(docId, 'helpers') || {}
  }

  _save (key, state) {
    const all = this._saved(state.docId)
    all[key] = { box: state.keys.box, after: state.after, sv: Buffer.from(Y.encodeStateVector(state.sv)).toString('base64'), lastHash: state.lastHash, answers: state.answers, at: Date.now() }
    this.engine.store.writeJSON(state.docId, 'helpers', all)
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
