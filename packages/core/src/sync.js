// The sync engine: keeps every document in a Yjs CRDT, persists every change
// locally, and exchanges encrypted updates with whichever peers are reachable.
//
// It has no idea how peers are found. Transports (swarm.js today, a relay
// later) hand it connected byte streams via addConnection().
//
// Consistency comes from the CRDT, not from an owner: any two copies that have
// seen the same updates are identical, whatever order the updates arrived in.

import { EventEmitter } from 'node:events'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { deriveDocKeys, seal, open } from './crypto.js'
import { MSG, encodeFrame, FrameReader, encodeHello, decodeHello } from './protocol.js'

const EMPTY_UPDATE_BYTES = 2

class Connection {
  constructor (engine, stream, remoteId) {
    this.engine = engine
    this.stream = stream
    this.remoteId = remoteId
    this.closed = false
    this.ackTimers = new Map()
    this.reader = new FrameReader((type, docId, payload) => engine._onFrame(this, type, docId, payload))
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

  send (type, docId, payload) {
    if (this.closed) return
    this.stream.write(encodeFrame(type, docId, payload))
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
    Object.assign(this, deriveDocKeys(this.secret))
    this.ydoc = new Y.Doc({ gc: true })
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    this.awareness.setLocalState(null) // the engine itself is not a cursor
    this.links = new Map() // Connection -> { user, awarenessIds: Set }
    this.state = { clientIds: [], acked: {}, lastSyncedAt: null, lastSyncedWith: null }
    this._statusTimer = null
  }

  get meta () { return this.ydoc.getMap('meta') }
}

export class SyncEngine extends EventEmitter {
  constructor ({ identity, store }) {
    super()
    this.identity = identity
    this.store = store
    this.docs = new Map()
    this.connections = new Set()
  }

  // Opens (or creates) a document from its secret, loads it from disk and
  // starts syncing it with every connected peer that also has it.
  openDoc (secret) {
    const { docId } = deriveDocKeys(Buffer.from(secret))
    if (this.docs.has(docId)) return this.docs.get(docId)
    const doc = new DocHandle(this, secret)
    this.docs.set(docId, doc)

    this.store.load(docId, doc.ydoc)
    doc.state = { ...doc.state, ...(this.store.readState(docId) || {}) }

    doc.ydoc.on('update', (update, origin) => {
      if (origin !== 'disk') this.store.append(docId, update)
      const sealed = seal(doc.encKey, update)
      for (const conn of doc.links.keys()) if (conn !== origin) conn.send(MSG.UPDATE, docId, sealed)
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
      const sealed = seal(doc.encKey, msg)
      for (const conn of doc.links.keys()) if (conn !== origin) conn.send(MSG.AWARENESS, docId, sealed)
      this.emit('awareness', docId, msg, origin)
    })

    for (const conn of this.connections) this._sendHello(doc, conn)
    return doc
  }

  getDoc (docId) {
    return this.docs.get(docId) || null
  }

  closeDoc (docId, { deleteLocalData = false } = {}) {
    const doc = this.docs.get(docId)
    if (!doc) return
    this.docs.delete(docId)
    doc.awareness.destroy()
    doc.ydoc.destroy()
    if (deleteLocalData) this.store.remove(docId)
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

  status (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return null
    const local = Y.decodeStateVector(Y.encodeStateVector(doc.ydoc))
    let pending = 0
    for (const id of doc.state.clientIds) {
      pending += Math.max(0, (local.get(id) || 0) - (doc.state.acked[id] || 0))
    }
    const peers = new Map()
    for (const { user } of doc.links.values()) peers.set(user.userId, user)
    return {
      docId,
      peers: [...peers.values()],
      lastSyncedAt: doc.state.lastSyncedAt,
      lastSyncedWith: doc.state.lastSyncedWith,
      pending
    }
  }

  // Called by a transport for every new connected peer.
  addConnection (stream, { remoteId = null } = {}) {
    const conn = new Connection(this, stream, remoteId)
    this.connections.add(conn)
    for (const doc of this.docs.values()) this._sendHello(doc, conn)
    return conn
  }

  destroy () {
    for (const conn of this.connections) conn.destroy()
    for (const docId of [...this.docs.keys()]) this.closeDoc(docId)
  }

  _sendHello (doc, conn) {
    const user = { userId: this.identity.userId, name: this.identity.name, color: this.identity.color }
    const hello = encodeHello(user, Y.encodeStateVector(doc.ydoc))
    conn.send(MSG.HELLO, doc.docId, seal(doc.encKey, hello))
  }

  _onFrame (conn, type, docId, payload) {
    const doc = this.docs.get(docId)
    if (!doc) return // a doc we don't have; nothing to say
    const plain = open(doc.encKey, payload)
    if (!plain) return // wrong key or tampered; ignore

    switch (type) {
      case MSG.HELLO: {
        let hello
        try { hello = decodeHello(plain) } catch { return }
        const isNew = !doc.links.has(conn)
        doc.links.set(conn, { user: sanitizeUser(hello.user), awarenessIds: doc.links.get(conn)?.awarenessIds || new Set() })
        // Send whatever they are missing, computed from their state vector.
        const diff = Y.encodeStateAsUpdate(doc.ydoc, hello.stateVector)
        if (diff.length > EMPTY_UPDATE_BYTES) conn.send(MSG.UPDATE, docId, seal(doc.encKey, diff))
        this._markAcked(doc, hello.stateVector, doc.links.get(conn).user)
        if (isNew) {
          this._sendHello(doc, conn) // they may have joined after we connected
          const states = [...doc.awareness.getStates().keys()]
          if (states.length) {
            const msg = awarenessProtocol.encodeAwarenessUpdate(doc.awareness, states)
            conn.send(MSG.AWARENESS, docId, seal(doc.encKey, msg))
          }
        }
        this._scheduleStatus(doc)
        break
      }
      case MSG.UPDATE: {
        if (!doc.links.has(conn)) return
        try { Y.applyUpdate(doc.ydoc, plain, conn) } catch { return }
        this._scheduleAck(conn, doc)
        break
      }
      case MSG.ACK: {
        const link = doc.links.get(conn)
        if (link) this._markAcked(doc, plain, link.user)
        break
      }
      case MSG.AWARENESS: {
        if (!doc.links.has(conn)) return
        try { awarenessProtocol.applyAwarenessUpdate(doc.awareness, plain, conn) } catch {}
        break
      }
    }
  }

  _scheduleAck (conn, doc) {
    if (conn.ackTimers.has(doc.docId)) return
    conn.ackTimers.set(doc.docId, setTimeout(() => {
      conn.ackTimers.delete(doc.docId)
      if (this.docs.get(doc.docId) === doc) conn.send(MSG.ACK, doc.docId, seal(doc.encKey, Y.encodeStateVector(doc.ydoc)))
    }, 250))
  }

  _markAcked (doc, stateVectorBytes, user) {
    let sv
    try { sv = Y.decodeStateVector(stateVectorBytes) } catch { return }
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
      doc.links.delete(conn)
      if (link.awarenessIds.size) awarenessProtocol.removeAwarenessStates(doc.awareness, [...link.awarenessIds], 'peer-left')
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
