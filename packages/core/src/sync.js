// The sync engine: keeps every document in a Yjs CRDT, persists every change
// locally, and exchanges encrypted updates with whichever peers are reachable.
//
// It has no idea how peers are found. Transports (swarm.js today, a relay
// later) hand it connected byte streams via addConnection().
//
// Consistency comes from the CRDT, not from an owner: any two copies that have
// seen the same updates are identical, whatever order the updates arrived in.
// Authority over *who* may take part comes from the owner-signed membership
// log (members.js): every peer checks each connection's signed identity
// against it, accepts edits only from editors, and sends nothing new to
// people who were removed.

import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { deriveDocKeys, epochKeys, seal, open } from './crypto.js'
import { MSG, encodeFrame, FrameReader, encodeHello, decodeHello, helloProof } from './protocol.js'
import { verifySignature } from './identity.js'
import { Membership, canEdit } from './members.js'
import { stateVectorMap, hasOpsBeyond, sameState, docFrom } from './conflicts.js'

const EMPTY_UPDATE_BYTES = 2

class Connection {
  constructor (engine, stream, { remoteId, localId }) {
    this.engine = engine
    this.stream = stream
    this.remoteId = remoteId || null // the peer's Noise public key (hex)
    this.localId = localId || null // ours on this connection
    this.closed = false
    this.ackTimers = new Map()
    this.reader = new FrameReader((type, docId, epoch, payload) => engine._onFrame(this, type, docId, epoch, payload))
    stream.on('data', (chunk) => {
      try {
        this.reader.push(chunk)
      } catch {
        this.destroy() // malformed stream; drop the peer
      }
    })
    stream.on('error', () => {})
    stream.on('close', () => this._onClose())
  }

  send (type, docId, epoch, payload) {
    if (this.closed) return
    this.stream.write(encodeFrame(type, docId, epoch, payload))
  }

  destroy () {
    this.stream.destroy()
  }

  _onClose () {
    if (this.closed) return
    this.closed = true
    for (const t of this.ackTimers.values()) clearTimeout(t)
    this.engine._onConnectionClosed(this)
  }
}

class DocHandle {
  constructor (engine, secret) {
    this.engine = engine
    this.secret = Buffer.from(secret)
    this.docId = deriveDocKeys(this.secret).docId
    this.epochs = new Map([[0, { secret: this.secret, ...epochKeys(this.secret) }]])
    this.ydoc = new Y.Doc({ gc: true })
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    this.awareness.setLocalState(null) // the engine itself is not a cursor
    this.members = new Membership(this.docId)
    this.invite = null // the signed invite I joined with, if any
    this.active = true // false = not syncing right now (per-file setting)
    // Connection -> { user, role, pending, epochs: Set, contentEpoch, awarenessIds }
    this.links = new Map()
    this.state = { clientIds: [], acked: {}, lastSyncedAt: null, lastSyncedWith: null }
    this._statusTimer = null
  }

  get meta () { return this.ydoc.getMap('meta') }

  // The newest epoch I hold a key for (that the membership log has reached).
  get myEpoch () {
    let best = 0
    for (const e of this.epochs.keys()) if (e <= this.members.epoch && e > best) best = e
    return best
  }

  // Content flows only on the current epoch, and only if I still have access.
  get contentEpoch () {
    if (!this.myAccess) return null
    return this.myEpoch === this.members.epoch ? this.myEpoch : null
  }

  get myAccess () {
    return this.members.roleOf(this.engine.identity.userId, this.invite)
  }

  get topics () {
    return [...this.epochs.values()].map((e) => e.topic)
  }

  keyFor (epoch) {
    return this.epochs.get(epoch)?.encKey || null
  }
}

export class SyncEngine extends EventEmitter {
  constructor ({ identity, store }) {
    super()
    this.identity = identity
    this.store = store
    this.docs = new Map()
    this.connections = new Set()
  }

  // Opens (or creates) a document from its root secret, loads it from disk and
  // starts syncing it with every connected peer that also has it.
  openDoc (secret, { invite = null, active = true } = {}) {
    const { docId } = deriveDocKeys(Buffer.from(secret))
    if (this.docs.has(docId)) return this.docs.get(docId)
    const doc = new DocHandle(this, secret)
    doc.invite = invite
    doc.active = active
    this.docs.set(docId, doc)

    this.store.load(docId, doc.ydoc)
    doc.state = { ...doc.state, ...(this.store.readState(docId) || {}) }
    const savedKeys = this.store.readJSON(docId, 'keys') || {}
    for (const [epoch, b64] of Object.entries(savedKeys)) this._addEpoch(doc, Number(epoch), Buffer.from(b64, 'base64'), { save: false })
    // The last state I had in common with another computer (for conflicts).
    doc.base = this.store.readBinary?.(docId, 'base') || null
    const savedLog = this.store.readJSON(docId, 'members')
    if (savedLog) doc.members.merge(savedLog)
    this._collectGrants(doc)

    doc.ydoc.on('update', (update, origin) => {
      if (origin !== 'disk') this.store.append(docId, update)
      // Relay what peers sent us; send my own edits only if I may edit.
      const fromPeer = origin instanceof Connection
      if (fromPeer || canEdit(doc.myAccess?.role)) this._broadcast(doc, MSG.UPDATE, update, origin)
      this.emit('update', docId, update, origin)
      this._scheduleStatus(doc)
    })

    doc.awareness.on('update', ({ added, updated, removed }, origin) => {
      const changed = added.concat(updated, removed)
      if (origin instanceof Connection) {
        const link = doc.links.get(origin)
        if (link) {
          for (const id of added.concat(updated)) link.awarenessIds.add(id)
          for (const id of removed) link.awarenessIds.delete(id)
        }
      }
      const msg = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, changed)
      this._broadcast(doc, MSG.AWARENESS, msg, origin)
      this.emit('awareness', docId, msg, origin)
      this._scheduleStatus(doc)
    })

    if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
    return doc
  }

  getDoc (docId) {
    return this.docs.get(docId) || null
  }

  closeDoc (docId, { deleteLocalData = false } = {}) {
    const doc = this.docs.get(docId)
    if (!doc) return
    this.docs.delete(docId)
    clearTimeout(doc._baseTimer)
    doc.awareness.destroy()
    doc.ydoc.destroy()
    if (deleteLocalData) this.store.remove(docId)
  }

  // Turns syncing for one document on or off without closing it.
  setActive (docId, active) {
    const doc = this.docs.get(docId)
    if (!doc || doc.active === active) return
    doc.active = active
    if (active) {
      for (const conn of this.connections) this._sendHellos(doc, conn)
    } else {
      // Tell peers, so they stop counting me as connected to this file.
      for (const [conn, link] of doc.links) {
        for (const epoch of link.epochs) if (doc.keyFor(epoch)) conn.send(MSG.LEAVE, doc.docId, epoch, seal(doc.keyFor(epoch), Buffer.alloc(0)))
        this._dropLink(doc, conn, link)
      }
      doc.links.clear()
    }
    this._scheduleStatus(doc)
  }

  // Records that a local editor (identified by its Yjs clientID) writes to
  // this doc, so we can tell the user which of their edits no peer has yet.
  registerLocalClient (docId, clientId) {
    const doc = this.docs.get(docId)
    if (!doc || doc.state.clientIds.includes(clientId)) return
    doc.state.clientIds.push(clientId)
    this.store.writeState(docId, doc.state)
  }

  applyLocalUpdate (docId, update, origin = 'local') {
    const doc = this.docs.get(docId)
    if (doc) Y.applyUpdate(doc.ydoc, update, origin)
  }

  applyLocalAwareness (docId, update, origin = 'local') {
    const doc = this.docs.get(docId)
    if (doc) awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, origin)
  }

  topicsFor (docId) {
    return this.docs.get(docId)?.topics || []
  }

  // ---- membership ---------------------------------------------------------------

  membership (docId) {
    return this.docs.get(docId)?.members || null
  }

  access (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return null
    const a = doc.myAccess
    const removed = doc.members.isRemoved(this.identity.userId) && !doc.members.member(this.identity.userId)
    return {
      role: a?.role || null,
      pending: Boolean(a?.pending),
      removed,
      // Waiting for the owner to hand over the current key.
      waitingForKey: Boolean(a) && doc.myEpoch < doc.members.epoch,
      hasMembership: doc.members.exists,
      owner: doc.members.owner
    }
  }

  // Starts a membership log for a document I own. `members` keeps people who
  // were already working on a document made before membership existed.
  ensureMembership (docId, { members = [] } = {}) {
    const doc = this.docs.get(docId)
    if (!doc || doc.members.exists) return false
    doc.members = Membership.create(this.identity, docId, { members })
    this._membersChanged(doc)
    return true
  }

  createInvite (docId, role) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    return doc.members.createInvite(this.identity, role)
  }

  setRole (docId, userId, role) {
    this._ownerAction(docId, (doc) => doc.members.setRole(this.identity, userId, role))
  }

  // Removes someone: they keep what they already have, but get nothing new.
  removeMember (docId, userId) {
    this._ownerAction(docId, (doc) => doc.members.remove(this.identity, userId, crypto.randomBytes(32)))
  }

  transferOwnership (docId, userId) {
    this._ownerAction(docId, (doc) => doc.members.transfer(this.identity, userId))
  }

  // Stops every invite link issued so far and moves everyone to a new key.
  resetInvites (docId) {
    this._ownerAction(docId, (doc) => [doc.members.rotate(this.identity, crypto.randomBytes(32))])
  }

  _ownerAction (docId, fn) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    if (doc.members.owner !== this.identity.userId) throw new Error('Only the owner can change who has access.')
    fn(doc)
    this._membersChanged(doc)
  }

  // ---- status -------------------------------------------------------------------

  status (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return null
    const local = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc))
    let pending = 0
    if (canEdit(doc.myAccess?.role)) {
      for (const id of doc.state.clientIds) pending += Math.max(0, (local.get(id) || 0) - (doc.state.acked[id] || 0))
    }
    const peers = new Map()
    for (const link of doc.links.values()) if (link.contentEpoch != null) peers.set(link.user.userId, { ...link.user, role: link.role, pending: link.pending })
    // People with the document open right now (their editor publishes presence).
    const here = new Map()
    for (const [clientId, s] of doc.awareness.getStates()) {
      if (clientId === doc.ydoc.clientID || !s?.user?.userId || s.user.userId === this.identity.userId) continue
      here.set(s.user.userId, { userId: s.user.userId, name: s.user.name, color: s.user.color })
    }
    return {
      docId,
      active: doc.active,
      peers: [...peers.values()],
      here: [...here.values()],
      lastSyncedAt: doc.state.lastSyncedAt,
      lastSyncedWith: doc.state.lastSyncedWith,
      pending
    }
  }

  // Called by a transport for every new connected peer.
  addConnection (stream, { remoteId = null, localId = null } = {}) {
    const conn = new Connection(this, stream, { remoteId, localId })
    this.connections.add(conn)
    for (const doc of this.docs.values()) if (doc.active) this._sendHellos(doc, conn)
    return conn
  }

  destroy () {
    for (const conn of this.connections) conn.destroy()
    for (const docId of [...this.docs.keys()]) this.closeDoc(docId)
  }

  // ---- internals ------------------------------------------------------------------

  _addEpoch (doc, epoch, secret, { save = true } = {}) {
    if (doc.epochs.has(epoch)) return false
    doc.epochs.set(epoch, { secret, ...epochKeys(secret) })
    if (save) {
      const out = {}
      for (const [e, k] of doc.epochs) if (e > 0) out[e] = k.secret.toString('base64')
      this.store.writeJSON(doc.docId, 'keys', out)
    }
    return true
  }

  // Opens any keys the membership log has sealed to me.
  _collectGrants (doc) {
    let added = false
    for (let e = 1; e <= doc.members.epoch; e++) {
      if (doc.epochs.has(e)) continue
      const sealed = doc.members.sealedKeyFor(this.identity.userId, e)
      const secret = sealed && this.identity.openSealed(sealed)
      if (secret?.length === 32) added = this._addEpoch(doc, e, secret) || added
    }
    return added
  }

  _membersChanged (doc) {
    this.store.writeJSON(doc.docId, 'members', doc.members.entries)
    const newKeys = this._collectGrants(doc)
    const log = Buffer.from(JSON.stringify(doc.members.entries))
    for (const [conn, link] of doc.links) {
      // Tell everyone, on the newest epoch we share.
      const shared = Math.max(...[...link.epochs].filter((e) => doc.epochs.has(e)))
      if (Number.isFinite(shared)) conn.send(MSG.MEMBERS, doc.docId, shared, seal(doc.keyFor(shared), log))
      // Re-check what each peer may do now.
      const access = doc.members.roleOf(link.user.userId, link.invite)
      link.role = access?.role || null
      link.pending = Boolean(access?.pending)
      if (!access || link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
    }
    if (newKeys) {
      this.emit('topics', doc.docId)
      if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
    }
    this.emit('members', doc.docId)
    this._scheduleStatus(doc)
  }

  _sendHellos (doc, conn) {
    if (!doc.active) return
    const sv = Y.encodeStateVector(doc.ydoc)
    for (const epoch of doc.epochs.keys()) {
      const info = {
        userId: this.identity.userId,
        name: this.identity.name,
        color: this.identity.color,
        enc: this.identity.encPublic,
        sig: this.identity.sign(helloProof(doc.docId, epoch, conn.localId, this.identity.encPublic)).toString('base64'),
        invite: doc.invite,
        head: doc.members.head
      }
      conn.send(MSG.HELLO, doc.docId, epoch, seal(doc.keyFor(epoch), encodeHello(info, sv)))
    }
  }

  _broadcast (doc, type, payload, except) {
    const epoch = doc.contentEpoch
    if (epoch == null) return
    const sealed = seal(doc.keyFor(epoch), payload)
    for (const [conn, link] of doc.links) {
      if (conn !== except && link.contentEpoch === epoch) conn.send(type, doc.docId, epoch, sealed)
    }
  }

  _onFrame (conn, type, docId, epoch, payload) {
    const doc = this.docs.get(docId)
    if (!doc || !doc.active) return // a doc we don't have, or aren't syncing now
    const key = doc.keyFor(epoch)
    if (!key) return
    const plain = open(key, payload)
    if (!plain) return // wrong key or tampered; ignore

    if (type === MSG.HELLO) return this._onHello(doc, conn, epoch, plain)
    if (type === MSG.LEAVE) {
      const left = doc.links.get(conn)
      if (left) { this._dropLink(doc, conn, left); doc.links.delete(conn); this._scheduleStatus(doc) }
      return
    }
    if (type === MSG.MEMBERS) {
      let entries
      try { entries = JSON.parse(plain.toString('utf8')) } catch { return }
      if (doc.members.merge(entries)) this._membersChanged(doc)
      return
    }

    const link = doc.links.get(conn)
    if (!link || link.contentEpoch !== epoch) return
    switch (type) {
      case MSG.UPDATE: {
        if (!canEdit(link.role)) return // viewers can't change the document
        const check = link.mergeCheck
        link.mergeCheck = null
        try { Y.applyUpdate(doc.ydoc, plain, conn) } catch { return }
        if (!check && link.lastSV && sameState(link.lastSV, Y.decodeStateVector(Y.encodeStateVector(doc.ydoc)))) this._saveBase(doc)
        if (check) {
          // Both of us changed the file while apart: let the app look for
          // edits to the same paragraph.
          this.emit('diverged', {
            docId: doc.docId,
            peer: link.user,
            base: check.base,
            mine: check.mine,
            theirs: Y.encodeStateAsUpdate(docFrom(check.base, plain))
          })
        }
        this._scheduleAck(conn, doc)
        break
      }
      case MSG.ACK:
        this._markAcked(doc, plain, link.user, link)
        break
      case MSG.AWARENESS:
        try { awarenessProtocol.applyAwarenessUpdate(doc.awareness, plain, conn) } catch {}
        break
    }
  }

  _onHello (doc, conn, epoch, plain) {
    let hello
    try { hello = decodeHello(plain) } catch { return }
    const info = hello.info || {}
    // The peer proves who they are by signing this document, epoch and the
    // Noise key of this very connection.
    if (typeof info.userId !== 'string' || !/^[0-9a-f]{64}$/.test(info.userId)) return
    if (!conn.remoteId || !verifySignature(info.userId, helloProof(doc.docId, epoch, conn.remoteId, info.enc), Buffer.from(String(info.sig || ''), 'base64'))) return

    let link = doc.links.get(conn)
    const isNew = !link
    if (!link) {
      link = { user: null, role: null, pending: false, epochs: new Set(), contentEpoch: null, awarenessIds: new Set(), invite: null }
      doc.links.set(conn, link)
    }
    link.user = sanitizeUser(info)
    link.enc = typeof info.enc === 'string' && /^[0-9a-f]{64}$/.test(info.enc) ? info.enc : null
    link.invite = info.invite && typeof info.invite === 'object' ? info.invite : null
    link.epochs.add(epoch)
    link.lastSV = stateVectorMap(hello.stateVector)

    // Share the membership log if theirs is behind or different.
    const theirs = info.head || {}
    if (doc.members.exists && (theirs.hash !== doc.members.head.hash)) {
      conn.send(MSG.MEMBERS, doc.docId, epoch, seal(doc.keyFor(epoch), Buffer.from(JSON.stringify(doc.members.entries))))
    }
    if (isNew) this._sendHellos(doc, conn) // they may have joined after we connected

    const access = doc.members.roleOf(link.user.userId, link.invite)
    link.role = access?.role || null
    link.pending = Boolean(access?.pending)

    // As owner, let in people holding a valid invite, and hand the current
    // key to members who don't have it yet.
    if (doc.members.owner === this.identity.userId && access && link.user.userId !== this.identity.userId) {
      const m = doc.members.member(link.user.userId)
      const needsKey = doc.members.epoch > 0 && !doc.members.sealedKeyFor(link.user.userId, doc.members.epoch)
      if ((access.pending || !m?.enc || needsKey) && link.enc) {
        doc.members.admit(this.identity, {
          userId: link.user.userId,
          role: access.role,
          enc: link.enc,
          epochSecret: doc.epochs.get(doc.members.epoch)?.secret
        })
        this._membersChanged(doc)
      }
    }

    // Content flows only on the current epoch, between people with access.
    const contentEpoch = doc.contentEpoch
    if (!link.role || contentEpoch == null || epoch !== contentEpoch) {
      this._scheduleStatus(doc)
      return
    }
    const starting = link.contentEpoch !== contentEpoch
    link.contentEpoch = contentEpoch
    if (starting) this._prepareMergeCheck(doc, link, hello.stateVector)
    // Send whatever they are missing, computed from their state vector.
    // (If I'm a viewer they'll ignore it; they get edits from editors.)
    const diff = Y.encodeStateAsUpdate(doc.ydoc, hello.stateVector)
    if (diff.length > EMPTY_UPDATE_BYTES) conn.send(MSG.UPDATE, doc.docId, contentEpoch, seal(doc.keyFor(contentEpoch), diff))
    if (canEdit(link.role)) this._markAcked(doc, hello.stateVector, link.user, link)
    if (starting) {
      const states = [...doc.awareness.getStates().keys()]
      if (states.length) {
        const msg = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states)
        conn.send(MSG.AWARENESS, doc.docId, contentEpoch, seal(doc.keyFor(contentEpoch), msg))
      }
    }
    this._scheduleStatus(doc)
  }

  // Decides whether the catch-up update this peer is about to send could
  // conflict with my own changes: true only if we both changed the file
  // since the last state we had in common.
  _prepareMergeCheck (doc, link, theirSVBytes) {
    if (!canEdit(doc.myAccess?.role) || !doc.base) return
    const base = stateVectorMap(Y.encodeStateVectorFromUpdate(doc.base))
    const mine = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc))
    const theirs = stateVectorMap(theirSVBytes)
    const iChanged = hasOpsBeyond(mine, base)
    const theyMissMine = [...mine].some(([client, clock]) => clock > (base.get(client) || 0) && (theirs.get(client) || 0) < clock)
    const theyChanged = hasOpsBeyond(theirs, mine)
    if (iChanged && theyMissMine && theyChanged) link.mergeCheck = { base: doc.base, mine: Y.encodeStateAsUpdate(doc.ydoc) }
  }

  // Remembers the current state as the last one shared with a peer.
  _saveBase (doc, { now = false } = {}) {
    const write = () => {
      doc._baseTimer = null
      if (this.docs.get(doc.docId) !== doc) return
      doc.base = Y.encodeStateAsUpdate(doc.ydoc)
      this.store.writeBinary?.(doc.docId, 'base', doc.base)
    }
    if (now) { clearTimeout(doc._baseTimer); write(); return }
    if (!doc._baseTimer) doc._baseTimer = setTimeout(write, 2000)
  }

  _stopContent (doc, conn, link) {
    if (link.contentEpoch == null) return
    link.contentEpoch = null
    if (link.awarenessIds.size) awarenessProtocol.removeAwarenessStates(doc.awareness, [...link.awarenessIds], 'peer-left')
    link.awarenessIds.clear()
  }

  _dropLink (doc, conn, link) {
    this._stopContent(doc, conn, link)
  }

  _scheduleAck (conn, doc) {
    if (conn.ackTimers.has(doc.docId)) return
    conn.ackTimers.set(doc.docId, setTimeout(() => {
      conn.ackTimers.delete(doc.docId)
      const epoch = doc.contentEpoch
      if (this.docs.get(doc.docId) === doc && epoch != null) conn.send(MSG.ACK, doc.docId, epoch, seal(doc.keyFor(epoch), Y.encodeStateVector(doc.ydoc)))
    }, 250))
  }

  _markAcked (doc, stateVectorBytes, user, link) {
    let sv
    try { sv = Y.decodeStateVector(stateVectorBytes) } catch { return }
    if (link) link.lastSV = sv
    if (sameState(sv, Y.decodeStateVector(Y.encodeStateVector(doc.ydoc)))) this._saveBase(doc)
    for (const id of doc.state.clientIds) {
      const theirs = sv.get(id) || 0
      if (theirs > (doc.state.acked[id] || 0)) doc.state.acked[id] = theirs
    }
    doc.state.lastSyncedAt = Date.now()
    doc.state.lastSyncedWith = user?.name || null
    this.store.writeState(doc.docId, doc.state)
    this._scheduleStatus(doc)
  }

  _onConnectionClosed (conn) {
    this.connections.delete(conn)
    for (const doc of this.docs.values()) {
      const link = doc.links.get(conn)
      if (!link) continue
      if (link.lastSV && sameState(link.lastSV, Y.decodeStateVector(Y.encodeStateVector(doc.ydoc)))) this._saveBase(doc, { now: true })
      this._dropLink(doc, conn, link)
      doc.links.delete(conn)
      this._scheduleStatus(doc)
    }
  }

  _scheduleStatus (doc) {
    if (doc._statusTimer) return
    doc._statusTimer = setTimeout(() => {
      doc._statusTimer = null
      if (this.docs.get(doc.docId) === doc) this.emit('status', this.status(doc.docId))
    }, 150)
  }
}

function sanitizeUser (u) {
  return {
    userId: typeof u?.userId === 'string' ? u.userId.slice(0, 64) : 'unknown',
    name: typeof u?.name === 'string' ? u.name.slice(0, 40) : 'Someone',
    color: typeof u?.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#777777'
  }
}
