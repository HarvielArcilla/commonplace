// CommonDrive: the list of files you own or collaborate on, and the glue that
// keeps every one of them syncing in the background.
//
// Drive only ever reads a file's container metadata (type, title, owner,
// contributors). Content belongs to the app registered for that type, so new
// apps (CommonSheets, CommonSlides) plug in without changes here.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import {
  FileStore, SyncEngine, SwarmTransport, loadOrCreateIdentity, canEdit,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta, updatePerson,
  findConflicts, conflictId, docFrom, History, restoreContent
} from '@commonplace/core'

export { sendDrive, receiveDrive, newMoveCode, parseMoveCode } from './move.js'

// Where the index lived before it synced between computers (still used to
// hand an index over when moving or linking a Drive).
export const INDEX_ID = 'drive-index'

// A checkpoint is saved once edits pause for a minute, and at least every
// ten minutes while someone keeps typing.
const HISTORY = { idleMs: 60e3, maxMs: 10 * 60e3 }

export class Drive extends EventEmitter {
  constructor ({ dataDir, apps = [], swarm = {}, transport = true, history = {}, deviceName = defaultDeviceName() }) {
    super()
    this.dataDir = dataDir
    this.swarmOpts = swarm
    this.appsByType = new Map(apps.map((a) => [a.type, a]))
    this.identity = loadOrCreateIdentity(dataDir)
    this.device = { id: loadDeviceId(dataDir), name: String(deviceName).slice(0, 60) }
    this.store = new FileStore(path.join(dataDir, 'files'))
    this.engine = new SyncEngine({ identity: this.identity, store: this.store, device: this.device })
    this.history = new History(this.store)
    this.historyTiming = { ...HISTORY, ...history }
    this._checkpoints = new Map() // docId -> { first, timer } for unsaved changes
    this._topicToDoc = new Map()
    this._joined = new Map() // docId -> Set(topicHex)
    this._open = new Set() // files open in a window right now
    this.transport = transport
      ? new SwarmTransport(this.engine, {
        ...swarm,
        isLonely: (topicHex) => {
          const status = this.engine.status(this._topicToDoc.get(topicHex))
          return !status || (status.peers.length === 0 && status.devices.length === 0)
        }
      })
      : null

    // The index (my files, folders and computers) is itself a document,
    // synced between my own computers with the same machinery as a shared
    // file. Only my identity can derive its key, and it has no members.
    const indexDoc = this.engine.openDoc(this.identity.driveSecret())
    this.indexId = indexDoc.docId
    this.index = indexDoc.ydoc
    this._adoptOldIndex()
    this.files = this.index.getMap('files')
    // Personal folders: they organize your Drive only and are never shared.
    this.folders = this.index.getMap('folders')
    // My computers: deviceId -> { name, platform, linkedAt, lastSeenAt, unlinked }
    this.devicesMap = this.index.getMap('devices')
    this._attached = new Set()
    // Files added or removed on my other computers.
    this.files.observe((event, tr) => {
      if (!(tr.origin && typeof tr.origin === 'object')) return // only changes that came from my other computers
      for (const [docId, change] of event.changes.keys) {
        if (change.action === 'add' && this.files.get(docId)?.secret) this._attach(this.files.get(docId))
        else if (change.action === 'delete') this._forget(docId)
      }
    })
    this.devicesMap.observe(() => { this._checkUnlinked(); this._changed() })

    this.engine.on('status', (status) => { this._rememberNames(status); this._changed() })
    this.engine.on('members', () => this._changed())
    this.engine.on('request', () => this._changed())
    this.engine.on('topics', (docId) => this._syncTopics(docId))
    this.engine.on('diverged', (info) => this._recordConflicts(info))
    this._recent = new Map() // docId -> { at, by } for changes made by others
    this._persistTimers = new Map()
    this.engine.on('update', (docId, update, origin) => {
      if (docId === this.indexId) { if (origin !== 'disk') this._changed(); return }
      if (origin === 'renderer') this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
      else if (origin !== 'disk' && origin !== 'local' && origin !== 'local-meta') this._remoteChange(docId, update)
      if (origin !== 'disk' && origin !== 'local-meta' && this.files.has(docId)) this._scheduleCheckpoint(docId)
    })
  }

  async start () {
    this._joinTopics(this.indexId)
    for (const entry of this.files.values()) this._attach(entry)
    this._seen()
    this._checkUnlinked()
    this._seenTimer = setInterval(() => this._seen(), 3600e3)
    this._seenTimer.unref?.()
    this._changed()
  }

  async stop () {
    clearInterval(this._seenTimer)
    if (!this.signedOut) this._seen()
    for (const docId of [...this._checkpoints.keys()]) this.checkpoint(docId)
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
        waitingForApproval: Boolean(access.waitingForApproval),
        inviteProblem: access.inviteProblem || null,
        managed: Boolean(access.hasMembership)
      },
      members: [...members, ...waiting],
      // People with an approval link asking the owner to let them in.
      requests: isOwner ? this.engine.requests(docId).map((r) => ({ ...r, name: nameOf(r.userId, r.name) })) : [],
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
      // Open comments and pending suggestions.
      review: app?.review && doc ? safeCall(() => app.review(doc.ydoc), { comments: 0, suggestions: 0 }) : { comments: 0, suggestions: 0 },
      syncMode: entry.syncMode === 'open' ? 'open' : 'always',
      conflicts: doc ? openConflicts(doc.ydoc).map((c) => ({ id: c.id, kind: c.kind, unit: c.unit, names: c.versions.map((v) => nameOf(v.userId, v.name)) })) : [],
      sync: {
        active: Boolean(status.active),
        // Show peers by the name they currently use in this document.
        peers: status.peers.map((p) => ({ ...p, name: nameOf(p.userId, p.name) })),
        here: (status.here || []).map((p) => ({ ...p, name: nameOf(p.userId, p.name) })),
        live: status.peers.length > 0,
        ownerOnline,
        lastSyncedAt: status.lastSyncedAt || null,
        lastSyncedWith: status.lastSyncedWith || null,
        lastSyncedDevice: status.lastSyncedDevice || null,
        // My own other computers connected for this file.
        devices: status.devices || [],
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
    if (!parsed.token) throw new Error('This invite link is from an older version of Commonplace. Ask for a new one.')
    if (parsed.token.x != null && !(Date.now() < parsed.token.x)) throw new Error('This invite link has expired. Ask for a new one.')
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
      owner: { userId: parsed.token.by, name: typeof parsed.token.n === 'string' ? parsed.token.n.slice(0, 40) : null },
      folderId: this.folders.has(folderId) ? folderId : null,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    this._changed()
    return docId
  }

  // An invite link for a role, signed by the owner. options:
  //   expiresIn  milliseconds until the link stops working (null: never)
  //   once       the first person admitted uses it up
  //   ask        the owner approves each person who uses it
  invite (docId, role = 'editor', { expiresIn = null, once = false, ask = false } = {}) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc) return null
    if (!doc.members.exists && readMeta(doc.ydoc)?.owner?.userId === this.identity.userId) this.engine.ensureMembership(docId)
    if (doc.members.owner !== this.identity.userId) throw new Error('Only the owner can invite people to this file.')
    const expiresAt = expiresIn ? Date.now() + expiresIn : null
    return encodeInvite(Buffer.from(entry.secret, 'base64'), this.engine.createInvite(docId, role, { expiresAt, once, ask }))
  }

  approveRequest (docId, userId, role) { this.engine.approveRequest(docId, userId, role) }
  declineRequest (docId, userId) { this.engine.declineRequest(docId, userId) }

  // ---- conflicts -------------------------------------------------------------

  // Open conflicts with both versions and what the merge currently shows.
  conflicts (docId) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.units) return []
    const now = app.units(doc.ydoc)
    const people = doc.ydoc.getMap('people')
    return openConflicts(doc.ydoc).map((c) => ({
      ...c,
      versions: c.versions.map(({ snapshot, ...v }) => ({ ...v, name: v.userId === this.identity.userId ? this.identity.name : (people.get(v.userId)?.name || v.name || 'Someone') })),
      current: now.get(c.unit) ? { exists: true, text: now.get(c.unit).text } : { exists: false, text: '' }
    }))
  }

  // Only the owner decides conflicts. The decision is an ordinary edit, so it
  // reaches everyone like any other change.
  resolveConflict (docId, id, choice) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.resolve) throw new Error('No such file.')
    if (doc.members.exists && doc.members.owner !== this.identity.userId) throw new Error('Only the owner can decide conflicts.')
    const map = doc.ydoc.getMap('conflicts')
    const rec = map.get(id)
    if (!rec || rec.status !== 'open') return
    doc.ydoc.transact(() => {
      this._signLocalEdits(doc)
      app.resolve(doc.ydoc, rec, choice)
      map.set(id, { ...rec, status: 'resolved', choice, resolvedBy: this.identity.userId, resolvedAt: Date.now() })
    }, 'local')
    this._patch(docId, { lastEditedAt: Date.now(), contributed: true })
    this._changed()
  }

  // ---- version history -------------------------------------------------------

  versions (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return []
    const people = doc.ydoc.getMap('people')
    const nameOf = (userId) => (userId === this.identity.userId ? this.identity.name : people.get(userId)?.name || this.files.get(docId)?.names?.[userId] || 'Someone')
    return this.history.list(docId).reverse().map((v) => ({ ...v, names: v.by.map(nameOf) }))
  }

  // The file as it was at a version (a Yjs update the window can show).
  version (docId, id) {
    return this.history.load(docId, id)
  }

  nameVersion (docId, id, label) {
    this.history.name(docId, id, label)
    this._changed()
  }

  // Saves a checkpoint now if anything changed since the last one.
  checkpoint (docId, opts = {}) {
    const pending = this._checkpoints.get(docId)
    if (pending) { clearTimeout(pending.timer); this._checkpoints.delete(docId) }
    const doc = this.engine.getDoc(docId)
    if (!doc || !this.files.get(docId)?.type) return null
    const authors = doc.ydoc.getMap('authors')
    return this.history.record(docId, doc.ydoc, { ...opts, authorOf: (client) => authors.get(String(client))?.userId || null })
  }

  // Puts the file back to an earlier version. That is an ordinary edit, so it
  // reaches everyone, and the version it replaced stays in the history.
  restoreVersion (docId, id) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.history) throw new Error('This file can\u2019t be restored.')
    if (!canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can restore a version.')
    const target = this.history.list(docId).find((v) => v.id === id)
    const past = this.history.load(docId, id)
    if (!target || !past) throw new Error('That version is no longer here.')
    this.checkpoint(docId)
    doc.ydoc.transact(() => {
      this._signLocalEdits(doc)
      restoreContent(doc.ydoc, docFrom(past), app.history.roots)
    }, 'local')
    this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
    this.checkpoint(docId, { kind: 'restore', restoredFrom: target.at })
    this._changed()
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

  // Removes the file from my Drive, on each of my computers. Other
  // collaborators keep theirs.
  async remove (docId) {
    this.files.delete(docId)
    await this._forget(docId)
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

  // ---- my computers ----------------------------------------------------------

  // The computers this Drive is linked on, this one first.
  devices () {
    const online = new Set((this.engine.status(this.indexId)?.devices || []).map((d) => d.id))
    return [...this.devicesMap.entries()]
      .filter(([, d]) => d && !d.unlinked)
      .map(([id, d]) => ({ id, name: d.name, platform: d.platform, lastSeenAt: d.lastSeenAt, thisComputer: id === this.device.id, online: id === this.device.id || online.has(id) }))
      .sort((a, b) => (b.thisComputer - a.thisComputer) || (b.lastSeenAt || 0) - (a.lastSeenAt || 0))
  }

  // Asks another of my computers to sign out and delete its copy the next
  // time it connects. It shares my identity, so this relies on it doing so.
  unlinkDevice (id) {
    if (id === this.device.id) throw new Error('To stop using this computer, unlink it from another one, or move your Drive.')
    const d = this.devicesMap.get(id)
    if (d) this.devicesMap.set(id, { ...d, unlinked: true, unlinkedAt: Date.now() })
  }

  // Everything needed to recreate this Drive on another computer. `leaving`:
  // this computer is moving away, so the copy doesn't list it any more.
  exportForMove ({ leaving = false } = {}) {
    let index = this.index
    if (leaving) {
      index = new Y.Doc()
      Y.applyUpdate(index, Y.encodeStateAsUpdate(this.index))
      index.getMap('devices').delete(this.device.id)
    }
    return {
      identity: this.identity.exportBundle(),
      index: Buffer.from(Y.encodeStateAsUpdate(index)).toString('base64'),
      docs: [...this.files.keys()].map((docId) => ({ docId, files: this.store.exportDoc(docId) }))
    }
  }

  // ---- internals -----------------------------------------------------------

  // The index from before it synced between computers: adopt it once.
  _adoptOldIndex () {
    if (!this.store.has(INDEX_ID)) return
    const old = new Y.Doc()
    this.store.load(INDEX_ID, old)
    Y.applyUpdate(this.index, Y.encodeStateAsUpdate(old), 'adopt')
    this.store.remove(INDEX_ID)
  }

  _seen () {
    const cur = this.devicesMap.get(this.device.id)
    if (cur?.unlinked) return
    this.devicesMap.set(this.device.id, { ...cur, name: this.device.name, platform: process.platform, linkedAt: cur?.linkedAt || Date.now(), lastSeenAt: Date.now() })
  }

  _checkUnlinked () {
    if (this.devicesMap.get(this.device.id)?.unlinked && !this.signedOut) {
      this.signedOut = true
      this.emit('unlinked')
    }
  }

  // A file was removed on another of my computers: remove it here too.
  async _forget (docId) {
    clearTimeout(this._checkpoints.get(docId)?.timer)
    this._checkpoints.delete(docId)
    this._attached.delete(docId)
    this._open.delete(docId)
    this.engine.closeDoc(docId, { deleteLocalData: true })
    this._changed()
    await this._leaveTopics(docId)
  }

  _rememberNames (status) {
    const entry = status && this.files.get(status.docId)
    if (!entry) return
    const names = { ...(entry.names || {}) }
    let changed = false
    for (const p of status.peers) if (p.name && names[p.userId] !== p.name) { names[p.userId] = p.name; changed = true }
    if (changed) this._patch(status.docId, { names })
  }

  _recordConflicts ({ docId, peer, base, mine, theirs }) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.units) return
    let found
    try {
      found = findConflicts({ base: docFrom(base), mine: docFrom(mine), theirs: docFrom(theirs), units: app.units })
    } catch (err) {
      this.emit('error', err)
      return
    }
    if (!found.length) return
    const map = doc.ydoc.getMap('conflicts')
    const version = (u, who) => ({
      userId: who.userId,
      name: who.name,
      exists: Boolean(u),
      text: u ? u.text : '',
      snapshot: u?.el && app.snapshotBlock ? app.snapshotBlock(u.el) : null
    })
    doc.ydoc.transact(() => {
      for (const c of found) {
        const id = conflictId(c.key, [c.mine?.sig, c.theirs?.sig])
        if (map.has(id)) continue
        const versions = [
          version(c.mine, { userId: this.identity.userId, name: this.identity.name }),
          version(c.theirs, peer)
        ].sort((a, b) => a.userId.localeCompare(b.userId))
        map.set(id, {
          id,
          kind: c.base.kind,
          unit: c.key,
          prev: c.base.prev,
          index: c.base.index ?? null,
          base: { text: c.base.text },
          versions,
          at: Date.now(),
          status: 'open'
        })
      }
    }, 'local')
    this._changed()
  }

  // Edits Drive makes itself (restores, conflict decisions) are mine too.
  _signLocalEdits (doc) {
    const authors = doc.ydoc.getMap('authors')
    if (!authors.has(String(doc.ydoc.clientID))) authors.set(String(doc.ydoc.clientID), { userId: this.identity.userId })
  }

  _scheduleCheckpoint (docId) {
    const t = this._checkpoints.get(docId) || { first: Date.now(), timer: null }
    clearTimeout(t.timer)
    const { idleMs, maxMs } = this.historyTiming
    t.timer = setTimeout(() => this.checkpoint(docId), Math.max(0, Math.min(idleMs, t.first + maxMs - Date.now())))
    t.timer.unref?.()
    this._checkpoints.set(docId, t)
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
    if (this._attached.has(entry.docId)) return
    this._attached.add(entry.docId)
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
      this.engine.retireLegacyLinks(entry.docId)
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
    if (entry && this._shouldSync(entry)) this._joinTopics(docId)
  }

  _joinTopics (docId) {
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

function openConflicts (ydoc) {
  return [...ydoc.getMap('conflicts').values()].filter((c) => c?.status === 'open').sort((a, b) => a.at - b.at)
}

// A stable id for this computer, kept outside the identity so linking or
// moving a Drive never copies it.
function loadDeviceId (dataDir) {
  const file = path.join(dataDir, 'device.json')
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).id } catch {}
  const id = randomBytes(8).toString('hex')
  fs.writeFileSync(file, JSON.stringify({ id }))
  return id
}

function defaultDeviceName () {
  const host = os.hostname().replace(/\.(local|lan|home)$/i, '').replace(/[-_]+/g, ' ').trim()
  return host || { darwin: 'Mac', win32: 'Windows PC' }[process.platform] || 'Computer'
}

function safeCall (fn, fallback) {
  try { return fn() } catch { return fallback }
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
