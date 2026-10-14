// CommonDrive: the list of files you own or collaborate on, and the glue that
// keeps every one of them syncing in the background.
//
// Drive only ever reads a file's container metadata (type, title, owner,
// contributors). Content belongs to the app registered for that type, so new
// apps (CommonSheets, CommonSlides) plug in without changes here.

import { EventEmitter } from 'node:events'
import path from 'node:path'
import * as Y from 'yjs'
import {
  FileStore, SyncEngine, SwarmTransport, loadOrCreateIdentity,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta
} from '@commonplace/core'

const INDEX_ID = 'drive-index'

export class Drive extends EventEmitter {
  constructor ({ dataDir, apps = [], swarm = {}, transport = true }) {
    super()
    this.dataDir = dataDir
    this.apps = new Map(apps.map((a) => [a.type, a]))
    this.identity = loadOrCreateIdentity(dataDir)
    this.store = new FileStore(path.join(dataDir, 'files'))
    this.engine = new SyncEngine({ identity: this.identity, store: this.store })
    this._topicToDoc = new Map()
    this.transport = transport
      ? new SwarmTransport(this.engine, {
        ...swarm,
        isLonely: (topicHex) => {
          const status = this.engine.status(this._topicToDoc.get(topicHex))
          return !status || status.peers.length === 0
        }
      })
      : null

    // The index is itself a CRDT, so it can later sync between your own
    // devices with the exact same machinery as a shared document.
    this.index = new Y.Doc()
    this.store.load(INDEX_ID, this.index)
    this.index.on('update', (u, origin) => { if (origin !== 'disk') this.store.append(INDEX_ID, u) })
    this.files = this.index.getMap('files')

    this.engine.on('status', () => this._changed())
    this.engine.on('update', (docId, _u, origin) => {
      if (origin === 'renderer' || origin === 'local') this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
    })
  }

  async start () {
    for (const entry of this.files.values()) this._attach(entry)
    this._changed()
  }

  async stop () {
    this.engine.destroy()
    if (this.transport) await this.transport.destroy()
  }

  // ---- queries -------------------------------------------------------------

  me () {
    return this.identity.toPublic()
  }

  list () {
    return [...this.files.values()]
      .map((e) => this.describe(e.docId))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  }

  describe (docId) {
    const entry = this.files.get(docId)
    if (!entry) return null
    const status = this.engine.status(docId) || { peers: [], pending: 0 }
    const app = this.apps.get(entry.type)
    const isOwner = entry.owner?.userId === this.identity.userId
    const ownerOnline = isOwner || status.peers.some((p) => p.userId === entry.owner?.userId)
    const doc = this.engine.getDoc(docId)
    return {
      docId,
      type: entry.type,
      title: entry.title,
      owner: entry.owner,
      role: isOwner ? 'owner' : 'editor',
      contributed: Boolean(entry.contributed),
      contributors: entry.contributors || [],
      addedAt: entry.addedAt,
      lastOpenedAt: entry.lastOpenedAt || null,
      lastEditedAt: entry.lastEditedAt || null,
      lastActivityAt: Math.max(entry.lastEditedAt || 0, entry.lastOpenedAt || 0, entry.addedAt || 0, status.lastSyncedAt || 0),
      waitingForPeer: !entry.type, // joined by invite, nothing received yet
      supported: !entry.type || (app && (entry.schemaVersion || 1) <= app.schemaVersion),
      appName: app?.name || null,
      preview: app && doc ? safePreview(app, doc.ydoc) : '',
      sync: {
        peers: status.peers,
        live: status.peers.length > 0,
        ownerOnline,
        lastSyncedAt: status.lastSyncedAt || null,
        lastSyncedWith: status.lastSyncedWith || null,
        pending: status.pending
      }
    }
  }

  // ---- commands ------------------------------------------------------------

  async create (type, title = 'Untitled') {
    const app = this.apps.get(type)
    if (!app) throw new Error(`no app installed for type "${type}"`)
    const secret = newDocSecret()
    const { docId } = deriveDocKeys(secret)
    const doc = this.engine.openDoc(secret)
    initContainer(doc.ydoc, { type, title, owner: this.identity, schemaVersion: app.schemaVersion })
    app.initContent?.(doc.ydoc)
    this.files.set(docId, {
      docId,
      secret: secret.toString('base64'),
      type,
      title,
      owner: { userId: this.identity.userId, name: this.identity.name },
      schemaVersion: app.schemaVersion,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    this._changed()
    return docId
  }

  async join (inviteText) {
    const secret = parseInvite(inviteText)
    if (!secret) throw new Error('That invite code is not valid.')
    const { docId } = deriveDocKeys(secret)
    if (!this.files.has(docId)) {
      this.files.set(docId, { docId, secret: secret.toString('base64'), type: null, title: 'Waiting for a peer…', owner: null, addedAt: Date.now() })
      this._attach(this.files.get(docId))
      this._changed()
    }
    return docId
  }

  invite (docId) {
    const entry = this.files.get(docId)
    return entry ? encodeInvite(Buffer.from(entry.secret, 'base64')) : null
  }

  rename (docId, title) {
    const doc = this.engine.getDoc(docId)
    if (doc) doc.ydoc.transact(() => doc.meta.set('title', String(title).slice(0, 200)), 'local')
  }

  markOpened (docId) {
    this._patch(docId, { lastOpenedAt: Date.now() })
  }

  // Removes the file from this device only. Other collaborators keep theirs.
  async remove (docId) {
    const doc = this.engine.getDoc(docId)
    if (doc && this.transport) await this.transport.leave(doc.topic)
    this.engine.closeDoc(docId, { deleteLocalData: true })
    this.files.delete(docId)
    this._changed()
  }

  getDoc (docId) {
    return this.engine.getDoc(docId)
  }

  setProfile (patch) {
    this.identity.update(patch)
    this._changed()
  }

  // ---- internals -----------------------------------------------------------

  _attach (entry) {
    const doc = this.engine.openDoc(Buffer.from(entry.secret, 'base64'))
    const refresh = () => {
      const meta = readMeta(doc.ydoc)
      if (!meta) return
      this._patch(entry.docId, {
        type: meta.type,
        title: meta.title,
        owner: meta.owner,
        schemaVersion: meta.schemaVersion,
        contributors: meta.contributors
      })
    }
    doc.meta.observe(refresh)
    doc.ydoc.getMap('authors').observe(refresh)
    refresh()
    this._topicToDoc.set(doc.topic.toString('hex'), entry.docId)
    if (this.transport) this.transport.join(doc.topic).catch((err) => this.emit('error', err))
  }

  _patch (docId, patch) {
    const cur = this.files.get(docId)
    if (!cur) return
    const next = { ...cur, ...patch }
    if (JSON.stringify(next) !== JSON.stringify(cur)) {
      this.files.set(docId, next)
      this._changed()
    }
  }

  _changed () {
    if (this._changeTimer) return
    this._changeTimer = setTimeout(() => {
      this._changeTimer = null
      this.emit('changed')
    }, 100)
  }
}

function safePreview (app, ydoc) {
  try {
    return app.preview ? String(app.preview(ydoc)).slice(0, 160) : ''
  } catch {
    return ''
  }
}
