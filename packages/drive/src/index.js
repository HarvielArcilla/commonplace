// commonDrive: the list of files you own or collaborate on, and the glue that
// keeps every one of them syncing in the background.
//
// Drive only ever reads a file's container metadata (type, title, owner,
// contributors). Content belongs to the app registered for that type, so new
// apps (commonSheets, commonSlides) plug in without changes here.

import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import {
  FileStore, SyncEngine, SwarmTransport, LanTransport, RelayClient, formatRelayAddress, loadOrCreateIdentity, canEdit,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta, updatePerson,
  History, restoreContent, BlobStore
} from '@commonplace/core'
import { Files, filesApp } from './files.js'
import { Policy } from './policy.js'
import { Guests } from './guests.js'
import { SharedFolders, folderApp, ITEMS } from './shared-folders.js'
import { openThreadCount } from '@commonplace/core/threads'
import { Activity } from './activity.js'
import { Templates } from './templates.js'
import { NetworkSettings } from './network.js'
import { Access } from './parts/access.js'
import { Conflicts, openConflicts } from './parts/conflicts.js'
import { Folders } from './parts/folders.js'
import { Limits } from './parts/limits.js'
import { Relays, RELAYS_MAP } from './parts/relays.js'
import { VersionHistory } from './parts/history.js'

// How long a guest waits for the owner before treating them as offline.
const GUEST_GRACE_MS = 60e3
const guestOf = (token) => (token?.g ? { after: token.a === 'hide' ? 'hide' : 'keep' } : null)

export { sendDrive, receiveDrive, newMoveCode, parseMoveCode } from './move.js'
export { Backups, readBackupFile, restoreBackup, newRecoveryKey, normalizeRecoveryKey } from './backup.js'
export { MAX_FILE_BYTES, GUARD_BYTES, fileKind, safeFileName, formatBytes, filesApp } from './files.js'
export { POLICY_FIELDS, POLICY_GROUPS, DEFAULT_POLICY, normalizePolicy } from './policy.js'
export { NetworkSettings, parseNodes } from './network.js'

// Where the index lived before it synced between computers (still used to
// hand an index over when moving or linking a Drive).
export const INDEX_ID = 'drive-index'

// A checkpoint is saved once edits pause for a minute, and at least every
// ten minutes while someone keeps typing.
const HISTORY = { idleMs: 60e3, maxMs: 10 * 60e3 }

export class Drive extends EventEmitter {
  // transport: sync over the internet (Hyperswarm). lan: also find computers
  // on the same network directly, with or without internet (options for tests).
  // makeThumb(path): a small JPEG data URL for an uploaded image (optional).
  // policy: values that replace the default limits (see policy.js);
  // guardBytes is the old name for policy.docGuardBytes.
  // appVersion: this app's version, shown to the people you sync with.
  constructor ({ dataDir, apps = [], swarm = {}, transport = true, lan = true, history = {}, deviceName = defaultDeviceName(), makeThumb = null, guardBytes = null, policy = {}, guestGraceMs = GUEST_GRACE_MS, appVersion = null }) {
    super()
    this.dataDir = dataDir
    this.policy = new Policy(dataDir, { ...(guardBytes ? { docGuardBytes: guardBytes } : {}), ...policy })
    this.network = new NetworkSettings(dataDir)
    // Options passed in (tests, or COMMONPLACE_BOOTSTRAP) win over the settings.
    this.swarmOpts = { ...this.network.swarmOptions(), ...swarm }
    this.networkOverridden = Boolean(swarm.dht || swarm.bootstrap)
    this.appsByType = new Map([...apps, filesApp, folderApp].map((a) => [a.type, a]))
    this.identity = loadOrCreateIdentity(dataDir)
    this.device = { id: loadDeviceId(dataDir), name: String(deviceName).slice(0, 60) }
    this.store = new FileStore(path.join(dataDir, 'files'))
    this.engine = new SyncEngine({ identity: this.identity, store: this.store, device: this.device, blobs: new BlobStore(path.join(dataDir, 'blobs')), appVersion })
    // Each computer protects itself: it ignores people you've blocked and
    // takes a limited number of answers to a form from any one person.
    this.engine.isBlocked = (userId) => this.policy.isBlocked(userId)
    this.engine.answerLimit = () => this.policy.get('answersPerPerson')
    this.uploads = new Files(this, { makeThumb })
    this.shared = new SharedFolders(this)
    this.activity = new Activity(this)
    this.templates = new Templates(this)
    this.history = new History(this.store)
    this.historyTiming = { ...HISTORY, ...history }
    this._checkpoints = new Map() // docId -> { first, timer } for unsaved changes
    this._topicToDoc = new Map()
    this._joined = new Map() // docId -> Set(topicHex)
    this._open = new Set() // files open in a window right now
    this.transport = transport
      ? new SwarmTransport(this.engine, {
        ...this.swarmOpts,
        isLonely: (topicHex) => {
          const status = this.engine.status(this._topicToDoc.get(topicHex))
          return !status || (status.peers.length === 0 && status.devices.length === 0)
        },
        // Connections to always-on relays go to the relay client.
        route: (socket, remote) => {
          if (!this.relays?.isRelay(remote)) return false
          this.relays.addConnection(socket, remote)
          return true
        }
      })
      : null
    this.relays = this.transport
      ? new RelayClient(this.engine, { connect: (key) => this._connectRelay(key), disconnect: (key) => this._disconnectRelay(key) })
      : null
    this.relays?.on('status', () => this._changed())
    if (this.relays) {
      // Relays keep uploaded files' chunks too.
      this.relays.chunksOf = (docId) => this.uploads._current(docId)?.chunks || []
      this.engine.chunkSources = (docId) => this.relays.chunkSources(docId)
    }
    this.lan = lan
      ? new LanTransport(this.engine, {
        ...(typeof lan === 'object' ? lan : {}),
        ...(this.transport ? { keyPair: this.transport.swarm.keyPair } : {}),
        topics: () => [...this._joined.values()].flatMap((set) => [...set].map((hex) => Buffer.from(hex, 'hex')))
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
    // Files I removed that a shared folder would otherwise bring back:
    // docId -> { at, folderId }. Kept in the index, so none of my computers
    // brings them back either.
    this.dismissed = this.index.getMap('dismissed')
    // My computers: deviceId -> { name, platform, linkedAt, lastSeenAt, unlinked }
    this.devicesMap = this.index.getMap('devices')
    // My always-on relays: key -> { addedAt }. They keep my Drive index (so
    // my computers sync through them) and new files I make.
    this.myRelaysMap = this.index.getMap(RELAYS_MAP)
    this.myRelaysMap.observe(() => { this._applyRelays(this.indexId); this._changed() })
    this._attached = new Set()
    // Files added or removed on my other computers.
    this.files.observe((event, tr) => {
      if (!(tr.origin && typeof tr.origin === 'object')) return // only changes that came from my other computers
      for (const [docId, change] of event.changes.keys) {
        const entry = this.files.get(docId)
        if (change.action === 'add' && entry?.secret) this._attach(entry)
        else if (change.action === 'delete') this._forget(docId)
        else if (change.action === 'update' && entry?.ended?.after === 'hide' && this._attached.has(docId)) this._wipe(docId)
      }
    })
    // Guests (people who can open a file only while I'm online), and what
    // happens here when my own access to something ends.
    this.guests = new Guests(this)
    this.engine.on('access-ended', (docId, { after }) => this._accessEnded(docId, after))
    this.engine.on('members', (docId) => this._checkMyAccess(docId))
    this.engine.on('status', (status) => this._watchGuestHost(status))
    this.guestGraceMs = guestGraceMs
    this._hostSeen = new Map() // guest file -> when its owner was last connected
    this._guestTimer = setInterval(() => this._checkGuestHosts(), Math.min(15e3, guestGraceMs / 2))
    this._guestTimer.unref?.()
    this.devicesMap.observe(() => { this._checkUnlinked(); this._changed() })

    this.engine.on('status', (status) => { this._rememberNames(status); this._changed() })
    this.engine.on('members', () => { this.shared.soon(); this._changed() })
    this.engine.on('request', () => this._changed())
    this.engine.on('topics', (docId) => this._syncTopics(docId))
    this.engine.on('diverged', (info) => this._recordConflicts(info))
    this._recent = new Map() // docId -> { at, by } for changes made by others
    this._persistTimers = new Map()
    this.engine.on('update', (docId, update, origin) => {
      if (docId === this.indexId) { if (origin !== 'disk') this._changed(); return }
      if (origin === 'renderer') this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
      else if (origin !== 'disk' && origin !== 'local' && origin !== 'local-meta') { this._remoteChange(docId, update); this._guardSoon(docId) }
      if (origin !== 'disk' && origin !== 'local-meta' && this.files.has(docId)) this._scheduleCheckpoint(docId)
    })
  }

  async start () {
    this._joinTopics(this.indexId)
    this._applyRelays(this.indexId)
    if (this.lan) await this.lan.start().catch((err) => { this.lan = null; this.emit('error', err) })
    for (const entry of this.files.values()) this._attach(entry)
    this.guests.reconcile()
    this.shared.soon()
    this._seen()
    this._checkUnlinked()
    this._seenTimer = setInterval(() => { this._seen(); this._emptyOldTrash() }, 3600e3)
    this._emptyOldTrash()
    this._seenTimer.unref?.()
    this._changed()
  }

  async stop () {
    clearInterval(this._seenTimer)
    clearInterval(this._guestTimer)
    this.guests.destroy()
    this.uploads.destroy()
    this.shared.destroy()
    this.activity.destroy()
    if (!this.signedOut) this._seen()
    for (const docId of [...this._checkpoints.keys()]) this.checkpoint(docId)
    for (const [docId, t] of this._persistTimers) {
      clearTimeout(t)
      const r = this._recent.get(docId)
      if (r) this._patch(docId, { lastChangedAt: r.at, lastChangedBy: r.by })
    }
    this._persistTimers.clear()
    this.engine.destroy()
    if (this.lan) await this.lan.destroy()
    if (this.transport) await this.transport.destroy()
  }

  get isEmpty () {
    return this.files.size === 0 && this.folders.size === 0
  }

  // ---- queries -------------------------------------------------------------

  me () {
    return this.identity.toPublic()
  }

  // Everything in my Drive, shared folders included (kind 'folder').
  list () {
    const containers = this.shared.containers()
    return [...this.files.values()]
      .map((e) => this.describe(e.docId, containers))
      .sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  }

  // My own folders, and the shared folders I'm in (shared: true, id = the
  // folder's docId).
  listFolders () {
    const containers = this.shared.containers()
    const mine = [...this.folders.values()]
      .map((f) => ({ ...f, parentId: this.folders.has(f.parentId) ? f.parentId : null }))
    const shared = this.shared.folders().map((e) => {
      const access = this.engine.access(e.docId) || {}
      return {
        id: e.docId,
        name: e.title || 'Shared folder',
        parentId: this.shared.placeOf(e.docId, containers),
        shared: true,
        role: access.role || null,
        owner: e.owner || null,
        people: this.engine.membersDetailed(e.docId).length,
        removed: this.removedFrom(e.docId).length,
        createdAt: e.addedAt
      }
    })
    return [...mine, ...shared]
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }))
  }

  apps () {
    return [...this.appsByType.values()]
      .filter((a) => !a.hidden)
      .map((a) => ({ type: a.type, kind: a.kind, name: a.name, description: a.description, exports: a.exports || [] }))
  }

  describe (docId, containers = null) {
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
      ? doc.members.detailed().map(({ userId, role, folder, until, after }) => ({
        userId,
        role,
        until,
        after,
        name: userId === this.identity.userId ? this.identity.name : nameOf(userId),
        online: userId === this.identity.userId || status.peers.some((p) => p.userId === userId),
        // Has it through this shared folder (its name, if I'm in it).
        via: folder ? { folderId: folder, name: this.files.get(folder)?.title || null } : null
      }))
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
        managed: Boolean(access.hasMembership),
        manage: Boolean(access.manage)
      },
      members: [...members, ...waiting],
      // People who can open it only while I'm online (I own it).
      guests: isOwner ? this.guests.list(docId) : [],
      // People with an approval link asking the owner to let them in.
      requests: access.manage ? this.engine.requests(docId).map((r) => ({ ...r, name: nameOf(r.userId, r.name) })) : [],
      contributed: Boolean(entry.contributed),
      contributors: entry.contributors || [],
      starred: Boolean(entry.starred),
      trashedAt: entry.trashedAt || null,
      addedAt: entry.addedAt,
      lastOpenedAt: entry.lastOpenedAt || null,
      lastEditedAt: entry.lastEditedAt || null,
      // Most recent change by anyone, and who made it if it wasn't me.
      lastChangeAt: changeAt || null,
      lastChangedBy: changeAt > (entry.lastEditedAt || 0) ? changeBy : null,
      lastActivityAt: Math.max(changeAt || 0, entry.lastOpenedAt || 0, entry.addedAt || 0),
      waitingForPeer: !entry.type, // joined by invite, nothing received yet
      // Openable by this app; newerFormat: a newer app wrote it, so it opens
      // read-only here (editing could damage what this app doesn't know).
      supported: !entry.type || Boolean(app),
      newerFormat: Boolean(app && (entry.schemaVersion || 1) > app.schemaVersion) || Boolean(doc?.members.needsNewer),
      appName: app?.name || null,
      kind: app?.kind || null,
      exports: app?.exports || [],
      folderId: this.shared.placeOf(docId, containers || this.shared.containers()),
      // In a shared folder for me only: its owner isn't in the folder.
      localOnly: Boolean(entry.folderId && this.shared.isFolder(entry.folderId) && !(containers || this.shared.containers()).get(docId)?.includes(entry.folderId)),
      preview: app && doc ? safePreview(app, doc.ydoc) : '',
      // A small picture of the start of the file, for the icon view.
      thumb: app?.thumbnail && doc ? safeCall(() => app.thumbnail(doc.ydoc), null) : null,
      // Open comments and pending suggestions.
      review: !doc ? { comments: 0, suggestions: 0 } : app?.review ? safeCall(() => app.review(doc.ydoc), { comments: 0, suggestions: 0 }) : { comments: safeCall(() => openThreadCount(doc.ydoc), 0), suggestions: 0 },
      syncMode: entry.syncMode === 'open' ? 'open' : 'always',
      // My access ended ({ at, after }), or ends at `until`.
      ended: entry.ended || null,
      accessUntil: doc?.members.member(this.identity.userId)?.until || null,
      // A guest: only while the owner is online. away: they aren't now.
      guest: entry.guest ? { after: entry.guest.after, away: Boolean(entry.guestAway) } : null,
      // Paused to protect this computer (see _guard), and why.
      held: entry.held ? { bytes: entry.heldBytes || 0, reason: entry.heldReason || 'size', folderId: entry.viaFolder || null } : null,
      // Uploaded files: whether the contents are here, and why not.
      upload: entry.type === 'file' ? this.uploads.status(docId) : null,
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
        // Always-on relays keeping a copy: [{ key, online, lastSyncedAt }].
        relays: (this.relays?.status(docId) || []).map((h) => ({ ...h, address: formatRelayAddress(h.key) })),
        pending: status.pending,
        // People who can't sync with me until one of us updates.
        outdated: (status.outdated || []).map((p) => ({ ...p, name: nameOf(p.userId, p.name) }))
      }
    }
  }

  // ---- commands ------------------------------------------------------------

  // build(ydoc), if given, fills the new file instead of the app's blank start
  // (templates and copies use it).
  async create (type, title = 'Untitled', { folderId = null, build = null } = {}) {
    const app = this.appsByType.get(type)
    if (!app) throw new Error(`no app installed for type "${type}"`)
    const secret = newDocSecret()
    const { docId } = deriveDocKeys(secret)
    const doc = this.engine.openDoc(secret)
    initContainer(doc.ydoc, { type, title, owner: this.identity, schemaVersion: app.schemaVersion })
    if (build) doc.ydoc.transact(() => build(doc.ydoc), 'local')
    else app.initContent?.(doc.ydoc)
    doc.ydoc.transact(() => { for (const key of this.myRelaysMap.keys()) doc.ydoc.getMap(RELAYS_MAP).set(key, { addedBy: this.identity.userId, at: Date.now() }) }, 'local')
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
    // Made inside a shared folder: it's shared with the folder's people.
    if (folderId && this.shared.isFolder(folderId)) { try { this.moveFile(docId, folderId) } catch (err) { this.emit('error', err) } }
    this._changed()
    return docId
  }

  async join (inviteText, { folderId = null } = {}) {
    const parsed = parseInvite(inviteText)
    if (!parsed) throw new Error('That invite code is not valid.')
    if (!parsed.token) throw new Error('This invite link is from an older version of commonplace. Ask for a new one.')
    if (parsed.token.x != null && !(Date.now() < parsed.token.x)) throw new Error('This invite link has expired. Ask for a new one.')
    const { docId } = deriveDocKeys(parsed.secret)
    this.dismissed.delete(docId) // asked for it again
    const existing = this.files.get(docId)
    if (existing) {
      // A newer invite (say, with edit rights) replaces the one I had, and
      // gives back access that had ended.
      if (parsed.token) {
        this._patch(docId, { invite: parsed.token, ended: null, guest: guestOf(parsed.token) })
        if (!this._attached.has(docId)) this._attach(this.files.get(docId))
        const doc = this.engine.getDoc(docId)
        if (doc) { doc.invite = parsed.token; this.engine.setActive(docId, false); this._applyActive(docId) }
      }
      return docId
    }
    this.files.set(docId, {
      docId,
      secret: parsed.secret.toString('base64'),
      invite: parsed.token,
      inviteRelays: Array.isArray(parsed.token.h) ? parsed.token.h.filter((k) => /^[0-9a-f]{64}$/.test(k)).slice(0, 4) : [],
      type: null,
      title: 'Waiting for a peer…',
      owner: { userId: parsed.token.by, name: typeof parsed.token.n === 'string' ? parsed.token.n.slice(0, 40) : null },
      folderId: this.folders.has(folderId) ? folderId : null,
      guest: guestOf(parsed.token),
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
  // access: 'always' (default), 'until' (with `until`, ms) or 'online'
  // (a guest link: see guests.js). after: what the person's computer does
  // with its copy when their access ends: 'keep' (read-only) or 'hide'.
  invite (docId, role = 'editor', { expiresIn = null, once = false, ask = false, access = 'always', until = null, after = 'keep' } = {}) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc) return null
    if (!doc.members.exists && readMeta(doc.ydoc)?.owner?.userId === this.identity.userId) this.engine.ensureMembership(docId)
    if (!doc.members.mayManage(this.identity.userId)) throw new Error('Only the owner and people who can share can invite people to this file.')
    if (access === 'online') return this.guests.createInvite(docId, role, { after, expiresIn })
    if (access === 'until' && !(until > Date.now())) throw new Error('Choose when their access ends, later than now.')
    const expiresAt = expiresIn ? Date.now() + expiresIn : null
    const relays = [...doc.ydoc.getMap(RELAYS_MAP).keys()]
    const ends = access === 'until' ? { until, after } : {}
    return encodeInvite(Buffer.from(entry.secret, 'base64'), this.engine.createInvite(docId, role, { expiresAt, once, ask, relays, ...ends }))
  }

  // 'always': sync whenever commonplace is running (default).
  // 'open': sync only while the file is open in a window.
  setSyncMode (docId, mode) {
    this._patch(docId, { syncMode: mode === 'open' ? 'open' : 'always' })
    this._applyActive(docId)
  }

  setOpen (docId, open) {
    if (open) this._open.add(docId)
    else this._open.delete(docId)
    this._applyActive(docId)
    if (open) this.migrate(docId)
  }

  // Brings an older file up to this app's format, when someone who may edit
  // it opens it. Each app lists its steps (app.migrations: { [version]:
  // fn(ydoc) }); they run in order, in one change, and must be safe to run
  // on two computers at once (the CRDT merges both runs).
  migrate (docId) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app || !canEdit(this.engine.access(docId)?.role)) return false
    const from = doc.meta.get('schemaVersion') || 1
    if (from >= app.schemaVersion) return false
    doc.ydoc.transact(() => {
      for (let v = from + 1; v <= app.schemaVersion; v++) app.migrations?.[v]?.(doc.ydoc)
      doc.meta.set('schemaVersion', app.schemaVersion)
    }, 'local')
    this._patch(docId, { schemaVersion: app.schemaVersion })
    return true
  }

  rename (docId, title) {
    const doc = this.engine.getDoc(docId)
    if (doc) doc.ydoc.transact(() => doc.meta.set('title', String(title).slice(0, 200)), 'local')
  }

  markOpened (docId) {
    this._patch(docId, { lastOpenedAt: Date.now() })
  }

  // A new file of mine with the same content (not the people, comments or
  // history), next to the original.
  async copy (docId) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.history?.roots?.length || entry.type === 'folder' || entry.type === 'file') throw new Error('This file can’t be copied.')
    const roots = app.history.roots.filter((r) => r.name !== 'responses')
    const where = this.shared.placeOf(docId)
    const copyId = await this.create(entry.type, `Copy of ${entry.title || 'Untitled'}`.slice(0, 200), {
      folderId: where && this.shared.isFolder(where) && canEdit(this.engine.access(where)?.role) ? where : this.folders.has(entry.folderId) ? entry.folderId : null,
      build: (ydoc) => { restoreContent(ydoc, doc.ydoc, roots); ydoc.getMap('meta').set('title', `Copy of ${entry.title || 'Untitled'}`.slice(0, 200)) }
    })
    return copyId
  }

  // Removes the file from my Drive, on each of my computers. Other
  // collaborators keep theirs.
  // Removing is always possible, whatever my access: it only deletes this
  // Drive's copy. A file a shared folder brought stays gone until I ask
  // for it back.
  // dismiss: false when the Drive itself takes a file out (it left the
  // folder that brought it), so it can come back if it's put back.
  async remove (docId, { dismiss = true } = {}) {
    const entry = this.files.get(docId)
    if (this.shared.isFolder(docId)) this._leaveFolder(docId)
    this.guests.endAllFor(docId)
    if (dismiss && (entry?.viaFolder || this._inMyFolders(docId))) this.dismissed.set(docId, { at: Date.now(), folderId: entry?.viaFolder || this._inMyFolders(docId) })
    this.files.delete(docId)
    await this._forget(docId)
    this.shared.soon()
  }

  // ---- trash and stars --------------------------------------------------------
  // Both are part of each file's entry in the Drive index, so they follow
  // you to your other computers. A file in the trash keeps syncing (so it can
  // come back as it was) until it's deleted, by hand or after the number of
  // days in this computer's settings.

  trash (docId) { this._patch(docId, { trashedAt: Date.now() }) }
  untrash (docId) { this._patch(docId, { trashedAt: null }) }
  star (docId, on = true) { this._patch(docId, { starred: Boolean(on) }) }

  async emptyTrash ({ olderThan = 0 } = {}) {
    const cutoff = Date.now() - olderThan
    for (const e of [...this.files.values()]) if (e.trashedAt && e.trashedAt <= cutoff) await this.remove(e.docId)
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

  _emptyOldTrash () {
    this.emptyTrash({ olderThan: this.policy.get('trashDays') * 86400e3 }).catch(() => {})
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
    this.relays?.setRelays(docId, [])
    clearTimeout(this._checkpoints.get(docId)?.timer)
    this._checkpoints.delete(docId)
    this._attached.delete(docId)
    this._open.delete(docId)
    this.uploads.unwatch(docId)
    this.activity.unwatch(docId)
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

  // Edits Drive makes itself (restores, conflict decisions) are mine too.
  _signLocalEdits (doc) {
    const authors = doc.ydoc.getMap('authors')
    if (!authors.has(String(doc.ydoc.clientID))) authors.set(String(doc.ydoc.clientID), { userId: this.identity.userId })
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
    if (entry.ended?.after === 'hide') return // deleted when access ended
    // A guest copy that's deleted while the owner is away starts empty.
    if (entry.guest?.after === 'hide' && !this.engine.getDoc(entry.docId)) this.store.remove(entry.docId)
    if (entry.guest && !this._hostSeen.has(entry.docId)) this._hostSeen.set(entry.docId, Date.now()) // a moment to find the owner
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
    doc.ydoc.getMap(RELAYS_MAP).observe(() => this._applyRelays(entry.docId))
    // A shared folder's contents decide who gets what.
    let watching = false
    const watchItems = () => {
      if (watching || readMeta(doc.ydoc)?.type !== 'folder') return
      watching = true
      doc.ydoc.getMap(ITEMS).observe(() => { this.shared.soon(); this._changed() })
      this.shared.soon()
    }
    doc.meta.observe(watchItems)
    watchItems()
    this.uploads.watch(entry.docId)
    this.activity.watch(entry.docId)
    refresh()
    this._syncTopics(entry.docId)
    this._applyRelays(entry.docId)
  }

  _shouldSync (entry) {
    if (entry.held) return false
    return entry.syncMode !== 'open' || this._open.has(entry.docId)
  }

  // ---- uploads ---------------------------------------------------------------------

  upload (filePath, options) { return this.uploads.upload(filePath, options) }
  uploadVersion (docId, filePath) { return this.uploads.uploadVersion(docId, filePath) }
  approveDownload (docId) { this.uploads.approve(docId) }
  removeDownloadedCopy (docId) { this.uploads.removeCopy(docId) }
  storageUsage () { return this.uploads.usage() }

  // ---- network (Settings → Network) ---------------------------------------------

  // What the settings show: the saved values, whether something passed in
  // at start (COMMONPLACE_BOOTSTRAP) overrides them, and what's connected.
  networkInfo () {
    const t = this.transport
    return {
      ...this.network.get(),
      overridden: this.networkOverridden,
      remembered: t?.remembered || 0,
      connections: t?.peerCount || 0,
      lan: this.lan ? true : false
    }
  }

  setNetwork (patch) { return this.network.set(patch) }

  forgetNetworkNodes () { this.transport?.forgetNodes() }
  setStorageSettings (patch) { this.uploads.setSettings(patch); this._changed() }

  _applyActive (docId) {
    const entry = this.files.get(docId)
    if (!entry) return
    const active = this._shouldSync(entry)
    this.engine.setActive(docId, active)
    this._applyRelays(docId)
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

// The Drive's methods are grouped by subject in ./parts. Each part is a class
// whose methods become the Drive's own, so callers see one object.
for (const part of [Access, Conflicts, Folders, Limits, Relays, VersionHistory]) {
  for (const name of Object.getOwnPropertyNames(part.prototype)) {
    if (name === 'constructor') continue
    if (name in Drive.prototype) throw new Error(`Drive.${name} is defined twice`)
    Object.defineProperty(Drive.prototype, name, Object.getOwnPropertyDescriptor(part.prototype, name))
  }
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

