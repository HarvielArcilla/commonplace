// The sync engine: keeps every document in a Yjs CRDT, persists every change
// locally, and exchanges encrypted updates with whichever peers are reachable.
//
// It has no idea how peers are found. Transports (swarm.js, lan.js,
// relay-client.js) hand it connected byte streams via addConnection().
//
// Consistency comes from the CRDT, not from an owner: any two copies that have
// seen the same updates are identical, whatever order the updates arrived in.
// Authority over *who* may take part comes from the owner-signed membership
// log (members.js): every peer checks each connection's signed identity
// against it, accepts edits only from editors, and sends nothing new to
// people who were removed.
//
// This file is the core of it: documents, connections, hellos and content.
// Membership, my computers, and the outbox for answers and comments are
// parts in engine/.

import { EventEmitter } from 'node:events'
import path from 'node:path'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { deriveDocKeys, epochKeys, seal, open } from './crypto.js'
import { MSG, encodeFrame, FrameReader, encodeHello, decodeHello, helloProof, compatible } from './protocol.js'
import { verifySignature } from './identity.js'
import { Membership, canEdit, canComment } from './members.js'
import { RESPONSES } from './respond.js'
import { mayApply, usesOutbox } from './gate.js'
import { directory, signatureDevice } from './devices.js'
import { ChunkExchange, BlobStore } from './chunks.js'
import { stateVectorMap, hasOpsBeyond, sameState, docFrom } from './conflicts.js'
import { mixParts } from './parts.js'
import { Access } from './engine/access.js'
import { Computers } from './engine/computers.js'
import { Outbox } from './engine/outbox.js'
import { META } from './container.js'
import { isHex64 } from './ids.js'

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
    this.requests = new Map() // userId -> people asking the owner to let them in
    this.declined = new Set() // userIds whose request the owner turned down
    this.active = true // false = not syncing right now (per-file setting)
    // Connection -> { user, role, pending, gated, epochs: Set, contentEpoch, awarenessIds, sv }
    this.links = new Map()
    this.state = { clientIds: [], acked: {}, lastSyncedAt: null, lastSyncedWith: null }
    this._statusTimer = null
  }

  get meta () { return this.ydoc.getMap(META) }

  // The current epoch: the membership log's, or for a document without
  // one (the Drive index) the newest key held (see setPrivateKey).
  get logEpoch () {
    return this.members.exists ? this.members.epoch : Math.max(...this.epochs.keys())
  }

  // The newest epoch I hold a key for (that the membership log has reached).
  get myEpoch () {
    let best = 0
    for (const e of this.epochs.keys()) if (e <= this.logEpoch && e > best) best = e
    return best
  }

  // Content flows only on the current epoch, and only if I still have access.
  get contentEpoch () {
    const access = this.myAccess
    if (!access || access.gated) return null
    return this.myEpoch === this.logEpoch ? this.myEpoch : null
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
  // device: { id, name } for this computer, so my other computers can tell
  // which of them they're talking to.
  // blobs: where uploaded files' chunks are kept (a BlobStore), if any.
  // appVersion: this app's version, told to peers so people can see who
  // needs to update.
  constructor ({ identity, store, device = null, blobs = null, appVersion = null }) {
    super()
    this.identity = identity
    this.appVersion = appVersion
    this.store = store
    this.device = device
    this.docs = new Map()
    this.connections = new Set()
    // Set by the Drive from this computer's policy: people to ignore, and
    // how many answers to a form to take from one person.
    // Someone's list of computers changed (see devices.js).
    this._onDirectory = (userId) => this._directoryChanged(userId)
    directory.on('change', this._onDirectory)
    this.isBlocked = () => false
    this.answerLimit = () => Infinity
    this._endsTimer = setInterval(() => { try { this.checkEnds() } catch {} }, 15e3)
    this._endsTimer.unref?.()
    this.chunks = new ChunkExchange({
      blobs: blobs || new BlobStore(path.join(store.dir, '..', 'blobs')),
      types: MSG,
      send: (conn, type, docId, plain) => {
        const doc = this.docs.get(docId)
        if (conn.chunkSend) return conn.chunkSend(type, docId, plain) // a relay
        if (doc?.contentEpoch != null) conn.send(type, docId, doc.contentEpoch, seal(doc.keyFor(doc.contentEpoch), plain))
      },
      links: (docId) => {
        const doc = this.docs.get(docId)
        if (!doc) return []
        const peers = [...doc.links].filter(([, l]) => l.contentEpoch === doc.contentEpoch && l.contentEpoch != null).map(([c]) => c)
        return [...peers, ...(this.chunkSources?.(docId) || [])]
      },
      // Set by the Drive: whether a chunk belongs to a file.
      allow: (docId, hash) => this.allowChunk?.(docId, hash) || false
    })
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
    if (savedLog && !doc.members.merge(savedLog)) doc.pendingMembers = savedLog
    for (const userId of this.store.readJSON(docId, 'declined') || []) doc.declined.add(userId)
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

    // A peer already connected may remember this file from before I closed
    // it (a copy deleted and opened again): ask them to start over.
    if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn, { again: true })
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

  // Whether to take this update from someone with this role (see gate.js).
  accepts (doc, role, userId, update) {
    return mayApply(doc.ydoc, { role, userId, update, answerAllowed: () => this.answerAllowed(doc, userId) })
  }

  // Whether to take another answer from this person (this computer's limit).
  answerAllowed (doc, userId) {
    const limit = this.answerLimit()
    if (!Number.isFinite(limit)) return true
    let n = 0
    for (const key of doc.ydoc.getMap(RESPONSES).keys()) if (key.startsWith(`${userId}.`) && ++n >= limit) return false
    return true
  }

  // Stops or restarts exchanging content with someone just blocked or
  // unblocked (isBlocked already says which), on every file.
  recheckUser (userId) {
    for (const doc of this.docs.values()) {
      for (const [conn, link] of doc.links) {
        if (link.user?.userId !== userId) continue
        if (this._mayExchange(doc, link)) {
          this._startContent(doc, conn, link)
          this._sendHello(doc, conn, doc.contentEpoch, { again: true }) // what they sent while ignored
        } else this._stopContent(doc, conn, link)
      }
    }
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
    if (!doc) return
    // As a commenter, only changes to the comments go in, and they go to
    // everyone who can edit (like a respondent's answers).
    if (canComment(doc.myAccess?.role)) {
      if (!this.accepts(doc, doc.myAccess.role, this.identity.userId, update)) return
      Y.applyUpdate(doc.ydoc, update, origin)
      this._sendOwn(doc, update, { merge: true })
      return
    }
    Y.applyUpdate(doc.ydoc, update, origin)
  }

  applyLocalAwareness (docId, update, origin = 'local') {
    const doc = this.docs.get(docId)
    if (doc) awarenessProtocol.applyAwarenessUpdate(doc.awareness, update, origin)
  }

  topicsFor (docId) {
    return this.docs.get(docId)?.topics || []
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
    const devices = new Map() // my own other computers
    for (const [conn, link] of doc.links) {
      if (link.contentEpoch == null) continue
      if (link.user.userId === this.identity.userId) devices.set(link.device?.id || conn.remoteId, { id: link.device?.id || null, name: link.device?.name || 'Another computer' })
      else peers.set(link.user.userId, { ...link.user, role: link.role, pending: link.pending, app: link.app })
    }
    // People we can't sync with until one of us updates commonplace.
    const outdated = new Map()
    for (const link of doc.links.values()) {
      if (link.user && link.incompatible && link.user.userId !== this.identity.userId) outdated.set(link.user.userId, { userId: link.user.userId, name: link.user.name, app: link.app, side: link.incompatible })
    }
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
      devices: [...devices.values()],
      here: [...here.values()],
      outdated: [...outdated.values()],
      needsNewer: doc.members.needsNewer,
      lastSyncedAt: doc.state.lastSyncedAt,
      lastSyncedWith: doc.state.lastSyncedWith,
      lastSyncedDevice: doc.state.lastSyncedDevice || null,
      pending,
      requests: this.requests(docId).length
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
    directory.off('change', this._onDirectory)
    clearInterval(this._endsTimer)
    this.chunks.destroy()
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

  _sendHellos (doc, conn, opts) {
    if (!doc.active) return
    for (const epoch of doc.epochs.keys()) this._sendHello(doc, conn, epoch, opts)
  }

  // again: ask the peer to send what I'm missing, even though we're already
  // exchanging (after I ignored them for a while, say).
  _sendHello (doc, conn, epoch, { again = false } = {}) {
    const info = {
      ...(again ? { again: true } : {}),
      userId: this.identity.userId,
      name: this.identity.name,
      color: this.identity.color,
      enc: this.identity.encPublic,
      sig: this.identity.sign(helloProof(doc.docId, epoch, conn.localId, this.identity.encPublic)).toString('base64'),
      // My list of computers, once it matters (protection is on), and a
      // fingerprint of it so peers who know more can send it.
      ul: this.identity.isProtected ? directory.statements(this.identity.userId) : undefined,
      uld: directory.digest(this.identity.userId) || undefined,
      invite: doc.invite,
      head: doc.members.head,
      device: this.device,
      app: this.appVersion || undefined
    }
    conn.send(MSG.HELLO, doc.docId, epoch, seal(doc.keyFor(epoch), encodeHello(info, Y.encodeStateVector(doc.ydoc))))
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
      this.mergeMembers(docId, entries)
      return
    }
    if (type === MSG.USERS) {
      let users
      try { users = JSON.parse(plain.toString('utf8')) } catch { return }
      for (const [userId, statements] of Object.entries(users || {}).slice(0, 64)) directory.merge(userId, statements)
      return
    }

    const link = doc.links.get(conn)
    if (!link || link.contentEpoch !== epoch) return
    switch (type) {
      case MSG.UPDATE: {
        if (!canEdit(link.role)) {
          if (this.accepts(doc, link.role, link.user.userId, plain)) { try { Y.applyUpdate(doc.ydoc, plain, conn) } catch {} }
          return
        }
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
      case MSG.WANT:
      case MSG.CHUNK:
      case MSG.NOCHUNK:
        this.chunks.onMessage(doc.docId, conn, type, plain)
        break
    }
  }

  _onHello (doc, conn, epoch, plain) {
    let hello
    try { hello = decodeHello(plain) } catch { return }
    const info = hello.info || {}
    // The peer proves who they are by signing this document, epoch and the
    // Noise key of this very connection.
    if (typeof info.userId !== 'string' || !isHex64(info.userId)) return
    if (Array.isArray(info.ul)) directory.merge(info.userId, info.ul)
    const sig = Buffer.from(String(info.sig || ''), 'base64')
    if (!conn.remoteId || !verifySignature(info.userId, helloProof(doc.docId, epoch, conn.remoteId, info.enc), sig, { fresh: true })) return
    // They know less about their own computers (or someone's) than I do.
    if (info.uld !== directory.digest(info.userId) && directory.statements(info.userId).length) this._sendUsers(doc, conn, epoch, [info.userId])

    let link = doc.links.get(conn)
    const isNew = !link
    // A peer can gain an epoch's key after we greeted them (a late joiner
    // handed the new key), so answer the first hello on each epoch.
    const newEpoch = !link?.epochs.has(epoch)
    if (!link) {
      link = { user: null, role: null, pending: false, gated: false, epochs: new Set(), contentEpoch: null, awarenessIds: new Set(), invite: null, sv: null }
      doc.links.set(conn, link)
    }
    link.user = sanitizeUser(info)
    link.signedBy = signatureDevice(sig) // their computer's key, once they're protected
    // Which version they run, and whether we can talk at all.
    link.app = typeof info.app === 'string' ? info.app.slice(0, 20) : null
    link.incompatible = compatible(info)
    link.device = info.device && typeof info.device === 'object'
      ? { id: String(info.device.id || '').slice(0, 32), name: String(info.device.name || 'Another computer').slice(0, 60) }
      : null
    link.enc = typeof info.enc === 'string' && isHex64(info.enc) ? info.enc : null
    link.invite = info.invite && typeof info.invite === 'object' ? info.invite : null
    link.epochs.add(epoch)
    link.lastSV = stateVectorMap(hello.stateVector)

    // Share the membership log if theirs is behind or different (with the
    // lists of computers that vouch for its signatures).
    const theirs = info.head || {}
    if (doc.members.exists && (theirs.hash !== doc.members.head.hash)) {
      this._sendUsers(doc, conn, epoch, doc.members.signers())
      conn.send(MSG.MEMBERS, doc.docId, epoch, seal(doc.keyFor(epoch), Buffer.from(JSON.stringify(doc.members.entries))))
    }
    if (isNew) this._sendHellos(doc, conn) // they may have joined after we connected
    else if (newEpoch || info.again === true) this._sendHello(doc, conn, epoch) // (never with again: no loops)

    const access = this._checkAccess(doc, link)
    if (doc.members.mayManage(this.identity.userId) && access && link.user.userId !== this.identity.userId) this._ownerGreets(doc, link, access)

    // Content flows only on the current epoch, between people with access.
    link.sv = hello.stateVector
    if (info.again === true && epoch === doc.contentEpoch) link.contentEpoch = null // send it all again
    if (epoch === doc.contentEpoch && this._mayExchange(doc, link)) this._startContent(doc, conn, link)
    this._scheduleStatus(doc)
  }

  // Updates what a peer may do from the membership log and their invite.
  _checkAccess (doc, link) {
    const access = doc.members.roleOf(link.user.userId, link.invite)
    link.role = access?.role || null
    link.pending = Boolean(access?.pending)
    link.gated = Boolean(access?.gated)
    return access
  }

  _mayExchange (doc, link) {
    return Boolean(link.role) && !link.incompatible && !doc.members.needsNewer && !this.isBlocked(link.user?.userId) && !link.gated && doc.contentEpoch != null && link.epochs.has(doc.contentEpoch)
  }

  // Starts exchanging content with a peer on the current epoch: send what
  // they're missing (from the state vector in their hello) and who's here.
  _startContent (doc, conn, link) {
    const contentEpoch = doc.contentEpoch
    if (link.contentEpoch === contentEpoch || !link.sv) return
    link.contentEpoch = contentEpoch
    this._prepareMergeCheck(doc, link, link.sv)
    // (If I'm a viewer they'll ignore it; they get edits from editors.)
    const diff = Y.encodeStateAsUpdate(doc.ydoc, link.sv)
    if (diff.length > EMPTY_UPDATE_BYTES) conn.send(MSG.UPDATE, doc.docId, contentEpoch, seal(doc.keyFor(contentEpoch), diff))
    if (canEdit(link.role)) this._markAcked(doc, link.sv, link.user, link)
    // As a respondent or commenter, hand my answers or comments to everyone
    // who can edit: they keep them and pass them on. (Already there: nothing
    // changes.)
    if (canEdit(link.role) && usesOutbox(doc.myAccess?.role)) {
      for (const update of this.outbox(doc.docId)) conn.send(MSG.UPDATE, doc.docId, contentEpoch, seal(doc.keyFor(contentEpoch), update))
    }
    this.chunks.pump(doc.docId) // someone new who may have chunks I'm waiting for
    const states = [...doc.awareness.getStates().keys()]
    if (states.length) {
      const msg = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states)
      conn.send(MSG.AWARENESS, doc.docId, contentEpoch, seal(doc.keyFor(contentEpoch), msg))
    }
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
    doc.state.lastSyncedWith = user?.userId === this.identity.userId ? null : (user?.name || null)
    doc.state.lastSyncedDevice = user?.userId === this.identity.userId ? (link?.device?.name || 'your other computer') : null
    this.store.writeState(doc.docId, doc.state)
    this._scheduleStatus(doc)
  }

  _onConnectionClosed (conn) {
    this.connections.delete(conn)
    this.chunks.dropConnection(conn)
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

// Membership, my computers, and answers and comments in an outbox live in
// engine/, as parts of the same class.
mixParts(SyncEngine, [Access, Computers, Outbox])

function sanitizeUser (u) {
  return {
    userId: typeof u?.userId === 'string' ? u.userId.slice(0, 64) : 'unknown',
    name: typeof u?.name === 'string' ? u.name.slice(0, 40) : 'Someone',
    color: typeof u?.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#777777'
  }
}
