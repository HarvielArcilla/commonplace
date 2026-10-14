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
  FileStore, SyncEngine, SwarmTransport, loadOrCreateIdentity, canEdit,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta, updatePerson
} from '@commonplace/core'

export { sendDrive, receiveDrive, newMoveCode, parseMoveCode } from './move.js'

export const INDEX_ID = 'drive-index'

export class Drive extends EventEmitter {
  constructor ({ dataDir, apps = [], swarm = {}, transport = true }) {
    super()
    this.dataDir = dataDir
    this.swarmOpts = swarm
    this.appsByType = new Map(apps.map((a) => [a.type, a]))
    this.identity = loadOrCreateIdentity(dataDir)
    this.store = new FileStore(path.join(dataDir, 'files'))
    this.engine = new SyncEngine({ identity: this.identity, store: this.store })
    this._topicToDoc = new Map()
    this._joined = new Map() // docId -> Set(topicHex)
    this._open = new Set() // files open in a window right now
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

    this.engine.on('status', (status) => { this._rememberNames(status); this._changed() })
    this.engine.on('members', () => this._changed())
    this.engine.on('topics', (docId) => this._syncTopics(docId))
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

  get isEmpty () {
    return this.files.size === 0 && this.folders.size === 0
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
    const status = this.engine.status(docId) || { peers: [], here: [], pending: 0, active: false }
    const app = this.appsByType.get(entry.type)
    const doc = this.engine.getDoc(docId)
    const people = doc?.ydoc.getMap('people')
    // Names: what people wrote in the file, else what they told us when they
    // connected (remembered for when they're offline), else a placeholder.
    const nameOf = (userId, fallback) => people?.get(userId)?.name || fallback || entry.names?.[userId] || 'Someone'
    const access = this.engine.access(docId) || {}
    const ownerId = access.owner || entry.owner?.userId || null
    const owner = ownerId ? { userId: ownerId, name: ownerId === this.identity.userId ? this.identity.name : nameOf(ownerId, entry.owner?.name) } : null
    const isOwner = ownerId === this.identity.userId
    const ownerOnline = isOwner || status.peers.some((p) => p.userId === ownerId)
    const recent = this._recent.get(docId)
    const remoteAt = Math.max(recent?.at || 0, entry.lastChangedAt || 0)
    const changeBy = (recent?.at || 0) >= (entry.lastChangedAt || 0) ? (recent?.by || entry.lastChangedBy) : entry.lastChangedBy
    const changeAt = Math.max(remoteAt, entry.lastEditedAt || 0)
    const members = doc?.members.exists
      ? doc.members.list().map((m) => ({ ...m, name: m.userId === this.identity.userId ? this.identity.name : nameOf(m.userId), online: m.userId === this.identity.userId || status.peers.some((p) => p.userId === m.userId) }))
      : []
    // People connected with a valid invite whom the owner hasn't added yet.
    const waiting = status.peers.filter((p) => p.pending && !members.some((m) => m.userId === p.userId)).map((p) => ({ userId: p.userId, role: p.role, name: nameOf(p.userId, p.name), online: true, pending: true }))
    return {
      docId,
      type: entry.type,
      title: entry.title,
      owner,
      role: access.role || (isOwner ? 'owner' : null),
      access: {
        role: access.role || null,
        pending: Boolean(access.pending),
        removed: Boolean(access.removed),
        waitingForKey: Boolean(access.waitingForKey),
        managed: Boolean(access.hasMembership)
      },
      members: [...members, ...waiting],
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
      syncMode: entry.syncMode === 'open' ? 'open' : 'always',
      sync: {
        active: Boolean(status.active),
        // Show peers by the name they currently use in this document.
        peers: status.peers.map((p) => ({ ...p, name: nameOf(p.userId, p.name) })),
        here: (status.here || []).map((p) => ({ ...p, name: nameOf(p.userId, p.name) })),
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
    this.engine.ensureMembership(docId)
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
    const parsed = parseInvite(inviteText)
    if (!parsed) throw new Error('That invite code is not valid.')
    const { docId } = deriveDocKeys(parsed.secret)
    const existing = this.files.get(docId)
    if (existing) {
      // A newer invite (say, with edit rights) replaces the one I had.
      if (parsed.token) {
        this._patch(docId, { invite: parsed.token })
        const doc = this.engine.getDoc(docId)
        if (doc) { doc.invite = parsed.token; this.engine.setActive(docId, false); this._applyActive(docId) }
      }
      return docId
    }
    this.files.set(docId, {
      docId,
      secret: parsed.secret.toString('base64'),
      invite: parsed.token,
      type: null,
      title: 'Waiting for a peer…',
      owner: parsed.token ? { userId: parsed.token.by, name: null } : null,
      folderId: this.folders.has(folderId) ? folderId : null,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    this._changed()
    return docId
  }

  // An invite link for a role. Once a file has an owner-signed membership,
  // only the owner can make links (the link carries their signature).
  invite (docId, role = 'editor') {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc) return null
    const secret = Buffer.from(entry.secret, 'base64')
    if (!doc.members.exists) return encodeInvite(secret)
    if (doc.members.owner !== this.identity.userId) throw new Error('Only the owner can invite people to this file.')
    return encodeInvite(secret, this.engine.createInvite(docId, role))
  }

  setMemberRole (docId, userId, role) { this.engine.setRole(docId, userId, role) }
  removeMember (docId, userId) { this.engine.removeMember(docId, userId) }
  transferOwnership (docId, userId) { this.engine.transferOwnership(docId, userId) }
  resetInvites (docId) { this.engine.resetInvites(docId) }

  // 'always': sync whenever Commonplace is running (default).
  // 'open': sync only while the file is open in a window.
  setSyncMode (docId, mode) {
    this._patch(docId, { syncMode: mode === 'open' ? 'open' : 'always' })
    this._applyActive(docId)
  }

  setOpen (docId, open) {
    if (open) this._open.add(docId)
    else this._open.delete(docId)
    this._applyActive(docId)
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
    await this._leaveTopics(docId)
    this.engine.closeDoc(docId, { deleteLocalData: true })
    this.files.delete(docId)
    this._open.delete(docId)
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
      if (known || entry.contributed || doc.members.owner === this.identity.userId) this.touchPerson(entry.docId)
    }
    this._changed()
  }

  // Writes my current name into a document's people map if it's out of date.
  // Viewers can't write to documents, so their names travel in their HELLO.
  touchPerson (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc || !canEdit(this.engine.access(docId)?.role)) return
    const me = { userId: this.identity.userId, name: this.identity.name, color: this.identity.color }
    doc.ydoc.transact(() => updatePerson(doc.ydoc, me), 'local-meta')
  }

  // Everything needed to recreate this Drive on another computer.
  exportForMove () {
    return {
      identity: this.identity.exportBundle(),
      index: Buffer.from(Y.encodeStateAsUpdate(this.index)).toString('base64'),
      docs: [...this.files.keys()].map((docId) => ({ docId, files: this.store.exportDoc(docId) }))
    }
  }

  // ---- internals -----------------------------------------------------------

  _rememberNames (status) {
    const entry = status && this.files.get(status.docId)
    if (!entry) return
    const names = { ...(entry.names || {}) }
    let changed = false
    for (const p of status.peers) if (p.name && names[p.userId] !== p.name) { names[p.userId] = p.name; changed = true }
    if (changed) this._patch(status.docId, { names })
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

  _attach (entry) {
    const doc = this.engine.openDoc(Buffer.from(entry.secret, 'base64'), { invite: entry.invite || null, active: this._shouldSync(entry) })
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
      // Files I created before membership existed get one now, keeping
      // everyone who has already worked on them as editors.
      if (meta.owner?.userId === this.identity.userId && !doc.members.exists) {
        const members = [...doc.ydoc.getMap('people').keys()]
          .filter((id) => id !== this.identity.userId && /^[0-9a-f]{64}$/.test(id))
          .map((userId) => ({ userId, role: 'editor' }))
        this.engine.ensureMembership(entry.docId, { members })
      }
    }
    doc.meta.observe(refresh)
    doc.ydoc.getMap('authors').observe(refresh)
    doc.ydoc.getMap('people').observe(refresh)
    refresh()
    this._syncTopics(entry.docId)
  }

  _shouldSync (entry) {
    return entry.syncMode !== 'open' || this._open.has(entry.docId)
  }

  _applyActive (docId) {
    const entry = this.files.get(docId)
    if (!entry) return
    const active = this._shouldSync(entry)
    this.engine.setActive(docId, active)
    if (active) this._syncTopics(docId)
    else this._leaveTopics(docId)
    this._changed()
  }

  // Joins the network topic for every key epoch of a file I'm syncing.
  _syncTopics (docId) {
    const entry = this.files.get(docId)
    if (!entry || !this._shouldSync(entry)) return
    const joined = this._joined.get(docId) || new Set()
    this._joined.set(docId, joined)
    for (const topic of this.engine.topicsFor(docId)) {
      const hex = topic.toString('hex')
      this._topicToDoc.set(hex, docId)
      if (joined.has(hex)) continue
      joined.add(hex)
      if (this.transport) this.transport.join(topic).catch((err) => this.emit('error', err))
    }
  }

  async _leaveTopics (docId) {
    const joined = this._joined.get(docId)
    this._joined.delete(docId)
    if (!joined || !this.transport) return
    for (const hex of joined) await this.transport.leave(Buffer.from(hex, 'hex')).catch(() => {})
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
