// CommonDrive: the list of files you own or collaborate on, and the glue that
// keeps every one of them syncing in the background.
//
// Drive only ever reads a file's container metadata (type, title, owner,
// contributors). Content belongs to the app registered for that type, so new
// apps (CommonSheets, CommonSlides) plug in without changes here.

import { EventEmitter } from 'node:events'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import {
  FileStore, SyncEngine, SwarmTransport, loadOrCreateIdentity,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta, updatePerson
} from '@commonplace/core'

const INDEX_ID = 'drive-index'

export class Drive extends EventEmitter {
  constructor ({ dataDir, apps = [], swarm = {}, transport = true }) {
    super()
    this.dataDir = dataDir
    this.appsByType = new Map(apps.map((a) => [a.type, a]))
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
    // Personal folders: they organize your Drive only and are never shared.
    this.folders = this.index.getMap('folders')

    this.engine.on('status', () => this._changed())
    this._recent = new Map() // docId -> { at, by } for changes made by others
    this._persistTimers = new Map()
    this.engine.on('update', (docId, update, origin) => {
      if (origin === 'renderer') this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
      else if (origin !== 'disk' && origin !== 'local' && origin !== 'local-meta') this._remoteChange(docId, update)
    })
  }

  async start () {
    for (const entry of this.files.values()) this._attach(entry)
    this._changed()
  }

  async stop () {
    for (const [docId, t] of this._persistTimers) {
      clearTimeout(t)
      const r = this._recent.get(docId)
      if (r) this._patch(docId, { lastChangedAt: r.at, lastChangedBy: r.by })
    }
    this._persistTimers.clear()
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

  listFolders () {
    return [...this.folders.values()]
      .map((f) => ({ ...f, parentId: this.folders.has(f.parentId) ? f.parentId : null }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  }

  apps () {
    return [...this.appsByType.values()]
      .filter((a) => !a.hidden)
      .map((a) => ({ type: a.type, kind: a.kind, name: a.name, description: a.description, exports: a.exports || [] }))
  }

  describe (docId) {
    const entry = this.files.get(docId)
    if (!entry) return null
    const status = this.engine.status(docId) || { peers: [], pending: 0 }
    const app = this.appsByType.get(entry.type)
    const isOwner = entry.owner?.userId === this.identity.userId
    const ownerOnline = isOwner || status.peers.some((p) => p.userId === entry.owner?.userId)
    const doc = this.engine.getDoc(docId)
    const recent = this._recent.get(docId)
    const remoteAt = Math.max(recent?.at || 0, entry.lastChangedAt || 0)
    const changeBy = (recent?.at || 0) >= (entry.lastChangedAt || 0) ? (recent?.by || entry.lastChangedBy) : entry.lastChangedBy
    const changeAt = Math.max(remoteAt, entry.lastEditedAt || 0)
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
      // Most recent change by anyone, and who made it if it wasn't me.
      lastChangeAt: changeAt || null,
      lastChangedBy: changeAt > (entry.lastEditedAt || 0) ? changeBy : null,
      lastActivityAt: Math.max(changeAt || 0, entry.lastOpenedAt || 0, entry.addedAt || 0),
      waitingForPeer: !entry.type, // joined by invite, nothing received yet
      supported: !entry.type || (app && (entry.schemaVersion || 1) <= app.schemaVersion),
      appName: app?.name || null,
      kind: app?.kind || null,
      exports: app?.exports || [],
      folderId: this.folders.has(entry.folderId) ? entry.folderId : null,
      preview: app && doc ? safePreview(app, doc.ydoc) : '',
      sync: {
        // Show peers by the name they currently use in this document.
        peers: status.peers.map((p) => ({ ...p, name: doc?.ydoc.getMap('people').get(p.userId)?.name || p.name })),
        live: status.peers.length > 0,
        ownerOnline,
        lastSyncedAt: status.lastSyncedAt || null,
        lastSyncedWith: status.lastSyncedWith || null,
        pending: status.pending
      }
    }
  }

  // ---- commands ------------------------------------------------------------

  async create (type, title = 'Untitled', { folderId = null } = {}) {
    const app = this.appsByType.get(type)
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
      folderId: this.folders.has(folderId) ? folderId : null,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    this._changed()
    return docId
  }

  async join (inviteText, { folderId = null } = {}) {
    const secret = parseInvite(inviteText)
    if (!secret) throw new Error('That invite code is not valid.')
    const { docId } = deriveDocKeys(secret)
    if (!this.files.has(docId)) {
      this.files.set(docId, { docId, secret: secret.toString('base64'), type: null, title: 'Waiting for a peer…', owner: null, folderId: this.folders.has(folderId) ? folderId : null, addedAt: Date.now() })
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

  // ---- folders -------------------------------------------------------------

  createFolder (name, parentId = null) {
    const id = randomBytes(8).toString('hex')
    this.folders.set(id, { id, name: cleanName(name) || 'Untitled folder', parentId: this.folders.has(parentId) ? parentId : null, createdAt: Date.now() })
    this._changed()
    return id
  }

  renameFolder (id, name) {
    const f = this.folders.get(id)
    if (f && cleanName(name)) { this.folders.set(id, { ...f, name: cleanName(name) }); this._changed() }
  }

  // Deleting a folder never deletes files: its contents move up one level.
  deleteFolder (id) {
    const f = this.folders.get(id)
    if (!f) return
    const parent = this.folders.has(f.parentId) ? f.parentId : null
    this.index.transact(() => {
      for (const entry of this.files.values()) if (entry.folderId === id) this.files.set(entry.docId, { ...entry, folderId: parent })
      for (const sub of this.folders.values()) if (sub.parentId === id) this.folders.set(sub.id, { ...sub, parentId: parent })
      this.folders.delete(id)
    })
    this._changed()
  }

  moveFile (docId, folderId) {
    this._patch(docId, { folderId: this.folders.has(folderId) ? folderId : null })
  }

  moveFolder (id, parentId) {
    const f = this.folders.get(id)
    if (!f) return false
    const target = this.folders.has(parentId) ? parentId : null
    // Refuse to move a folder into itself or one of its own subfolders.
    for (let p = target; p; p = this.folders.get(p)?.parentId) if (p === id) return false
    this.folders.set(id, { ...f, parentId: target })
    this._changed()
    return true
  }

  getDoc (docId) {
    return this.engine.getDoc(docId)
  }

  // Updates my name and color, and carries the change into every document I
  // own or have taken part in, so collaborators see the new name.
  setProfile (patch) {
    this.identity.update(patch)
    for (const entry of this.files.values()) {
      const doc = this.engine.getDoc(entry.docId)
      if (!doc || !entry.type) continue
      const known = doc.ydoc.getMap('people').has(this.identity.userId)
      if (known || entry.contributed || entry.owner?.userId === this.identity.userId) this.touchPerson(entry.docId)
    }
    this._changed()
  }

  // Writes my current name into a document's people map if it's out of date.
  touchPerson (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    const me = { userId: this.identity.userId, name: this.identity.name, color: this.identity.color }
    doc.ydoc.transact(() => updatePerson(doc.ydoc, me), 'local-meta')
  }

  _remoteChange (docId, update) {
    const doc = this.engine.getDoc(docId)
    let by = null
    try {
      const client = Y.decodeUpdate(update).structs[0]?.id.client
      const userId = doc?.ydoc.getMap('authors').get(String(client))?.userId
      if (userId && userId !== this.identity.userId) by = doc.ydoc.getMap('people').get(userId)?.name || null
    } catch {}
    const prev = this._recent.get(docId)
    this._recent.set(docId, { at: Date.now(), by: by || prev?.by || null })
    this._changed()
    // Persist at most every 10 seconds per file, not on every keystroke.
    if (!this._persistTimers.has(docId)) {
      this._persistTimers.set(docId, setTimeout(() => {
        this._persistTimers.delete(docId)
        const r = this._recent.get(docId)
        if (r) this._patch(docId, { lastChangedAt: r.at, lastChangedBy: r.by })
      }, 10000))
    }
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
    doc.ydoc.getMap('people').observe(refresh)
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

function cleanName (name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)
}
