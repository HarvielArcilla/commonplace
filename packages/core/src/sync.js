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
import path from 'node:path'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { deriveDocKeys, epochKeys, seal, open } from './crypto.js'
import { MSG, encodeFrame, FrameReader, encodeHello, decodeHello, helloProof } from './protocol.js'
import { verifySignature } from './identity.js'
import { Membership, canEdit, canRespond } from './members.js'
import { isResponseUpdate, RESPONSES } from './respond.js'
import { ChunkExchange, BlobStore } from './chunks.js'
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
    this.requests = new Map() // userId -> people asking the owner to let them in
    this.declined = new Set() // userIds whose request the owner turned down
    this.active = true // false = not syncing right now (per-file setting)
    // Connection -> { user, role, pending, gated, epochs: Set, contentEpoch, awarenessIds, sv }
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
    const access = this.myAccess
    if (!access || access.gated) return null
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

// The end of access an invite link gives (u) and what happens then (a).
const accessFromInvite = (invite) => (invite?.u ? { until: invite.u, after: invite.a === 'hide' ? 'hide' : 'keep' } : {})

export class SyncEngine extends EventEmitter {
  // device: { id, name } for this computer, so my other computers can tell
  // which of them they're talking to.
  // blobs: where uploaded files' chunks are kept (a BlobStore), if any.
  constructor ({ identity, store, device = null, blobs = null }) {
    super()
    this.identity = identity
    this.store = store
    this.device = device
    this.docs = new Map()
    this.connections = new Set()
    // Set by the Drive from this computer's policy: people to ignore, and
    // how many answers to a form to take from one person.
    this.isBlocked = () => false
    this.answerLimit = () => Infinity
    this._endsTimer = setInterval(() => { try { this.checkEnds() } catch {} }, 15e3)
    this._endsTimer.unref?.()
    this.chunks = new ChunkExchange({
      blobs: blobs || new BlobStore(path.join(store.dir, '..', 'blobs')),
      types: MSG,
      send: (conn, type, docId, plain) => {
        const doc = this.docs.get(docId)
        if (doc?.contentEpoch != null) conn.send(type, docId, doc.contentEpoch, seal(doc.keyFor(doc.contentEpoch), plain))
      },
      links: (docId) => {
        const doc = this.docs.get(docId)
        return doc ? [...doc.links].filter(([, l]) => l.contentEpoch === doc.contentEpoch && l.contentEpoch != null).map(([c]) => c) : []
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
    if (savedLog) doc.members.merge(savedLog)
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
      waitingForKey: Boolean(a) && !a.gated && doc.myEpoch < doc.members.epoch,
      // Holding a single-use or approval link the owner hasn't acted on yet.
      waitingForApproval: Boolean(a?.gated),
      // Why my invite link doesn't work, if it doesn't: expired, used, revoked.
      inviteProblem: !a && doc.invite && doc.members.exists ? doc.members.inviteProblem(doc.invite, { userId: this.identity.userId }) : null,
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

  createInvite (docId, role, options) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    return doc.members.createInvite(this.identity, role, options)
  }

  // People holding an approval link who are waiting for the owner.
  requests (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return []
    return [...doc.requests.values()]
      .filter((r) => !doc.members.member(r.userId) && !doc.declined.has(r.userId))
      .map(({ userId, name, color, role, at }) => ({ userId, name, color, role, at }))
  }

  approveRequest (docId, userId, role) {
    this._ownerAction(docId, (doc) => {
      const r = doc.requests.get(userId)
      if (!r) throw new Error('That person is no longer asking to join.')
      doc.requests.delete(userId)
      this._admit(doc, { userId, role: role || r.role, enc: r.enc, invite: r.invite })
    })
  }

  declineRequest (docId, userId) {
    const doc = this.docs.get(docId)
    if (!doc) return
    doc.requests.delete(userId)
    doc.declined.add(userId)
    this.store.writeJSON(docId, 'declined', [...doc.declined])
    this._scheduleStatus(doc)
  }

  // Unsigned links from before roles existed stop working for this file.
  retireLegacyLinks (docId) {
    const doc = this.docs.get(docId)
    if (!doc || doc.members.owner !== this.identity.userId || !doc.members.acceptsLegacyLinks) return
    doc.members.retireLegacyLinks(this.identity)
    this._membersChanged(doc)
  }

  setRole (docId, userId, role) {
    this._ownerAction(docId, (doc) => doc.members.setRole(this.identity, userId, role))
  }

  // Adds someone directly, as owner (shared folders use this: the person's
  // encryption key comes from the folder's own log). `folder` records why.
  addMember (docId, { userId, role, enc, folder = undefined }) {
    this._ownerAction(docId, (doc) => this._admit(doc, { userId, role, enc, folder }))
  }

  membersDetailed (docId) {
    return this.docs.get(docId)?.members.detailed() || []
  }

  // Removes someone: they get nothing new. after: 'keep' (their copy stays,
  // read-only) or 'hide' (their computer deletes it).
  removeMember (docId, userId, { after } = {}) {
    this._ownerAction(docId, (doc) => doc.members.remove(this.identity, userId, crypto.randomBytes(32), { after }))
  }

  // When someone's access ends (null: never), and what happens to their copy.
  setMemberAccess (docId, userId, { until = null, after = 'keep' } = {}) {
    this._ownerAction(docId, (doc) => doc.members.setAccess(this.identity, userId, { until, after }))
  }

  // Every few seconds: access that has just ended stops on every computer
  // (by its own clock), and the owner's computer removes those people and
  // moves everyone else to a new key. Emits 'access-ended' once when my own
  // access to a file ends.
  checkEnds (now = Date.now()) {
    for (const doc of this.docs.values()) {
      if (!doc.members.exists) continue
      if (doc.members.owner === this.identity.userId) {
        const lapsed = doc.members.lapsed(now)
        if (lapsed.length) {
          this._ownerAction(doc.docId, (d) => { for (const x of lapsed) d.members.remove(this.identity, x.userId, crypto.randomBytes(32), { after: x.after }) })
          continue
        }
      }
      const mine = doc.members.member(this.identity.userId)
      const ended = doc.members.hasEnded(this.identity.userId, now)
      if (ended && !doc.endedNoticed) { doc.endedNoticed = true; this.emit('access-ended', doc.docId, { after: mine?.after || 'keep' }) }
      if (!doc.members.nextEnd(now - 60e3) && !doc.members.lapsed(now).length) continue
      for (const [conn, link] of doc.links) {
        this._checkAccess(doc, link)
        if (!this._mayExchange(doc, link) || link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
      }
    }
  }

  transferOwnership (docId, userId) {
    this._ownerAction(docId, (doc) => doc.members.transfer(this.identity, userId))
  }

  // Stops every invite link issued so far and moves everyone to a new key.
  resetInvites (docId) {
    this._ownerAction(docId, (doc) => [doc.members.rotate(this.identity, crypto.randomBytes(32))])
  }

  // Adopts a copy of a file's membership log from anywhere (a peer, a
  // relay). The log checks its own signatures.
  mergeMembers (docId, entries) {
    const doc = this.docs.get(docId)
    if (!doc || !doc.members.merge(entries)) return false
    this._membersChanged(doc)
    this._redoDropped(doc, doc.members.dropped)
    return true
  }

  // Two of my computers changed who has access at the same moment and the
  // other one's change won: make mine again on top of it, if it still applies.
  _redoDropped (doc, dropped = []) {
    const mineNow = () => doc.members.owner === this.identity.userId
    for (const e of dropped) {
      if (e.by !== this.identity.userId || !mineNow()) continue
      const m = doc.members
      try {
        if (e.type === 'add' && !m.member(e.userId)) this._admit(doc, { userId: e.userId, role: e.role, enc: e.enc, invite: e.via ? { once: true, i: e.via } : null, folder: e.folder, ...('until' in e ? { until: e.until, after: e.after } : {}) })
        else if (e.type === 'access' && m.member(e.userId)) m.setAccess(this.identity, e.userId, { until: e.until, after: e.after })
        else if (e.type === 'role' && m.member(e.userId) && m.member(e.userId).role !== e.role) m.setRole(this.identity, e.userId, e.role)
        else if (e.type === 'remove' && m.member(e.userId)) m.remove(this.identity, e.userId, crypto.randomBytes(32), { after: e.after })
        else if (e.type === 'rotate' && !dropped.some((x) => x.type === 'remove')) m.rotate(this.identity, crypto.randomBytes(32))
        else if (e.type === 'owner' && m.member(e.userId)) m.transfer(this.identity, e.userId)
        else if (e.type === 'revoke-invites') m.revokeInvites(this.identity)
        else if (e.type === 'retire-legacy') m.retireLegacyLinks(this.identity)
        else continue
      } catch { continue }
      this._membersChanged(doc)
    }
  }

  _ownerAction (docId, fn) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    if (doc.members.owner !== this.identity.userId) throw new Error('Only the owner can change who has access.')
    fn(doc)
    this._membersChanged(doc)
  }

  // ---- answering a form ---------------------------------------------------------

  // As a respondent: adds one answer (an update from responseUpdate) and
  // sends it to everyone connected who can edit. It also waits in an
  // outbox and goes again to each editor I connect to, since there may be
  // nobody to take it right now.
  respond (docId, update) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('Unknown document')
    if (!canRespond(doc.myAccess?.role)) throw new Error('Only respondents answer this way.')
    if (!isResponseUpdate(update, this.identity.userId)) throw new Error('That isn’t an answer.')
    Y.applyUpdate(doc.ydoc, update, 'response')
    const box = this.store.readJSON(docId, 'outbox') || []
    box.push(Buffer.from(update).toString('base64'))
    this.store.writeJSON(docId, 'outbox', box)
    for (const [conn, link] of doc.links) {
      if (link.contentEpoch === doc.contentEpoch && canEdit(link.role)) conn.send(MSG.UPDATE, docId, doc.contentEpoch, seal(doc.keyFor(doc.contentEpoch), update))
    }
    this.emit('response', docId, update)
  }

  outbox (docId) {
    return (this.store.readJSON(docId, 'outbox') || []).map((b64) => Buffer.from(b64, 'base64'))
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
      else peers.set(link.user.userId, { ...link.user, role: link.role, pending: link.pending })
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

  // Opens any keys the membership log has sealed to me. The log decides:
  // if I hold a different key for an epoch (from a branch of the log that
  // lost when two of the owner's computers changed access at once), the
  // log's key replaces it, or I'd be locked out of the file from then on.
  _collectGrants (doc) {
    let added = false
    for (let e = 1; e <= doc.members.epoch; e++) {
      const sealed = doc.members.sealedKeyFor(this.identity.userId, e)
      if (!sealed && doc.epochs.has(e)) continue
      const secret = sealed && this.identity.openSealed(sealed)
      if (secret?.length !== 32) continue
      const held = doc.epochs.get(e)
      if (held && held.secret.equals(secret)) continue
      if (held) doc.epochs.delete(e)
      added = this._addEpoch(doc, e, secret) || added
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
      // Re-check what each peer may do now, and start or stop content.
      this._checkAccess(doc, link)
      if (!this._mayExchange(doc, link) || link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
      if (this._mayExchange(doc, link)) this._startContent(doc, conn, link)
    }
    if (newKeys) {
      this.emit('topics', doc.docId)
      if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
    }
    this.emit('members', doc.docId)
    this._scheduleStatus(doc)
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
      invite: doc.invite,
      head: doc.members.head,
      device: this.device
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

    const link = doc.links.get(conn)
    if (!link || link.contentEpoch !== epoch) return
    switch (type) {
      case MSG.UPDATE: {
        if (!canEdit(link.role)) {
          // Viewers can't change the document; respondents can only add
          // their own sealed answers to a form.
          if (canRespond(link.role) && isResponseUpdate(plain, link.user.userId) && this.answerAllowed(doc, link.user.userId)) {
            try { Y.applyUpdate(doc.ydoc, plain, conn) } catch {}
          }
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
    if (typeof info.userId !== 'string' || !/^[0-9a-f]{64}$/.test(info.userId)) return
    if (!conn.remoteId || !verifySignature(info.userId, helloProof(doc.docId, epoch, conn.remoteId, info.enc), Buffer.from(String(info.sig || ''), 'base64'))) return

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
    link.device = info.device && typeof info.device === 'object'
      ? { id: String(info.device.id || '').slice(0, 32), name: String(info.device.name || 'Another computer').slice(0, 60) }
      : null
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
    else if (newEpoch || info.again === true) this._sendHello(doc, conn, epoch) // (never with again: no loops)

    const access = this._checkAccess(doc, link)
    if (doc.members.owner === this.identity.userId && access && link.user.userId !== this.identity.userId) this._ownerGreets(doc, link, access)

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
    return Boolean(link.role) && !this.isBlocked(link.user?.userId) && !link.gated && doc.contentEpoch != null && link.epochs.has(doc.contentEpoch)
  }

  // As owner: let in people holding a valid invite (or note their request,
  // for approval links), and hand the current key to members without it.
  _ownerGreets (doc, link, access) {
    const { userId } = link.user
    if (!link.enc) return
    if (access.pending) {
      if (link.invite?.ask) {
        if (!doc.declined.has(userId) && !doc.requests.has(userId)) {
          doc.requests.set(userId, { ...link.user, role: access.role, enc: link.enc, invite: link.invite, at: Date.now() })
          this.emit('request', doc.docId, userId)
        }
        return
      }
      this._admit(doc, { userId, role: access.role, enc: link.enc, invite: link.invite, ...accessFromInvite(link.invite) })
      this._membersChanged(doc)
      return
    }
    const m = doc.members.member(userId)
    const needsKey = doc.members.epoch > 0 && !doc.members.sealedKeyFor(userId, doc.members.epoch)
    if (!m?.enc || needsKey) {
      this._admit(doc, { userId, role: access.role, enc: link.enc, folder: m?.folder || undefined })
      this._membersChanged(doc)
    }
  }

  _admit (doc, { userId, role, enc, invite = null, folder = undefined, until = undefined, after = undefined }) {
    doc.members.admit(this.identity, {
      userId,
      role,
      enc,
      epochSecret: doc.epochs.get(doc.members.epoch)?.secret,
      via: invite?.once ? invite.i : undefined,
      folder,
      until,
      after
    })
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
    // As a respondent, hand my answers to everyone who can edit: they keep
    // them and pass them on. (Already there: nothing changes.)
    if (canEdit(link.role) && canRespond(doc.myAccess?.role)) {
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

function sanitizeUser (u) {
  return {
    userId: typeof u?.userId === 'string' ? u.userId.slice(0, 64) : 'unknown',
    name: typeof u?.name === 'string' ? u.name.slice(0, 40) : 'Someone',
    color: typeof u?.color === 'string' && /^#[0-9a-f]{6}$/i.test(u.color) ? u.color : '#777777'
  }
}
