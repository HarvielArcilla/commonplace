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
  FileStore, SyncEngine, SwarmTransport, LanTransport, RelayClient, formatRelayAddress, parseRelayAddress, loadOrCreateIdentity, canEdit,
  newDocSecret, deriveDocKeys, encodeInvite, parseInvite, initContainer, readMeta, updatePerson,
  findConflicts, conflictId, docFrom, History, restoreContent, BlobStore
} from '@commonplace/core'
import { Files, filesApp } from './files.js'
import { Policy } from './policy.js'
import { Guests } from './guests.js'
import { SharedFolders, folderApp, ITEMS } from './shared-folders.js'
import { openThreadCount } from '@commonplace/core/threads'
import { Activity } from './activity.js'
import { Templates } from './templates.js'
import { NetworkSettings } from './network.js'

// How long a guest waits for the owner before treating them as offline.
const GUEST_GRACE_MS = 60e3
const guestOf = (token) => (token?.g ? { after: token.a === 'hide' ? 'hide' : 'keep' } : null)

// Relays used to be called helpers; files and Drives made then keep their
// relay list under this name, so it stays.
const RELAYS_MAP = 'helpers'

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
      ? new RelayClient(this.engine, { connect: (key) => this.transport.joinPeer(key), disconnect: (key) => this.transport.leavePeer(key) })
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
        managed: Boolean(access.hasMembership)
      },
      members: [...members, ...waiting],
      // People who can open it only while I'm online (I own it).
      guests: isOwner ? this.guests.list(docId) : [],
      // People with an approval link asking the owner to let them in.
      requests: isOwner ? this.engine.requests(docId).map((r) => ({ ...r, name: nameOf(r.userId, r.name) })) : [],
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
    if (doc.members.owner !== this.identity.userId) throw new Error('Only the owner can invite people to this file.')
    if (access === 'online') return this.guests.createInvite(docId, role, { after, expiresIn })
    if (access === 'until' && !(until > Date.now())) throw new Error('Choose when their access ends, later than now.')
    const expiresAt = expiresIn ? Date.now() + expiresIn : null
    const relays = [...doc.ydoc.getMap(RELAYS_MAP).keys()]
    const ends = access === 'until' ? { until, after } : {}
    return encodeInvite(Buffer.from(entry.secret, 'base64'), this.engine.createInvite(docId, role, { expiresAt, once, ask, relays, ...ends }))
  }

  // ---- always-on relays ------------------------------------------------------

  myRelays () {
    return [...this.myRelaysMap.keys()].map((key) => ({ key, address: formatRelayAddress(key), ...(this.relays?.status(this.indexId).find((h) => h.key === key) || {}) }))
  }

  // Adds a relay for my computers' Drive and for new files. `everywhere`
  // also adds it to every file I own now.
  addMyRelay (address, { everywhere = false } = {}) {
    const key = parseRelayAddress(address)
    if (!key) throw new Error('That isn\u2019t a relay address. It starts with cpr1.')
    this.myRelaysMap.set(key, { addedAt: Date.now() })
    if (everywhere) for (const f of this.list()) if (f.role === 'owner') this.addRelay(f.docId, address)
    return key
  }

  removeMyRelay (key) {
    this.myRelaysMap.delete(key)
  }

  // Relays for one file are part of the file, so everyone working on it
  // uses them.
  addRelay (docId, address) {
    const key = parseRelayAddress(address)
    if (!key) throw new Error('That isn\u2019t a relay address. It starts with cpr1.')
    const doc = this.engine.getDoc(docId)
    if (!doc || !canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can add a relay.')
    doc.ydoc.transact(() => doc.ydoc.getMap(RELAYS_MAP).set(key, { addedBy: this.identity.userId, at: Date.now() }), 'local')
    return key
  }

  removeRelay (docId, key) {
    const doc = this.engine.getDoc(docId)
    if (!doc || !canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can remove a relay.')
    doc.ydoc.transact(() => doc.ydoc.getMap(RELAYS_MAP).delete(key), 'local')
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

  // Someone who had a file through a shared folder and is given a role by
  // hand keeps it directly, whatever happens to the folder.
  setMemberRole (docId, userId, role) {
    const m = this.engine.membersDetailed(docId).find((x) => x.userId === userId)
    if (m?.folder) this.engine.addMember(docId, { userId, role, enc: m.enc })
    else this.engine.setRole(docId, userId, role)
  }

  // Someone who has a file through a shared folder they're still in would
  // only get it back: say so instead.
  // after: 'keep' (their copy stays, read-only) or 'hide' (their computer deletes it).
  removeMember (docId, userId, { after } = {}) {
    this._refuseIfFromFolder(docId, userId)
    this.engine.removeMember(docId, userId, { after })
  }

  _refuseIfFromFolder (docId, userId) {
    const m = this.engine.membersDetailed(docId).find((x) => x.userId === userId)
    const folder = m?.folder && this.shared.containers().get(docId)?.includes(m.folder) ? this.files.get(m.folder) : null
    if (folder && this.engine.membersDetailed(folder.docId).some((x) => x.userId === userId)) {
      throw new Error(`They have this through the shared folder “${folder.title}”. Remove them from the folder, or move the file out of it.`)
    }
  }

  // ---- when my own access ends ------------------------------------------------------

  // The owner took me out, or my time ran out: stop, and keep a read-only
  // copy or delete it, as the owner chose.
  _checkMyAccess (docId) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc?.members.exists) return
    const removal = doc.members.removal(this.identity.userId)
    if (removal && !doc.members.member(this.identity.userId)) this._accessEnded(docId, removal.after)
    else if (entry.ended && doc.myAccess) this._patch(docId, { ended: null }) // given back
  }

  _accessEnded (docId, after = 'keep') {
    const entry = this.files.get(docId)
    if (!entry || entry.ended) return
    if (this._ownerOf(docId) === this.identity.userId) return
    this._patch(docId, { ended: { at: Date.now(), after: after === 'hide' ? 'hide' : 'keep' } })
    if (after === 'hide') this._wipe(docId)
    this.emit('access-ended', docId, after)
    this._changed()
  }

  // Deletes this computer's copy of a file's contents, keeping its place in
  // the Drive (so it can say what happened, and be removed).
  _wipe (docId) {
    this.relays?.setRelays(docId, [])
    this.uploads.unwatch(docId)
    this.engine.closeDoc(docId, { deleteLocalData: true })
    this._attached.delete(docId)
    this._leaveTopics(docId)
    this._changed()
  }

  // ---- as a guest: only while the owner is online -------------------------------------

  _watchGuestHost (status) {
    const entry = status && this.files.get(status.docId)
    if (!entry?.guest) return
    const ownerId = this._ownerOf(status.docId)
    if (status.peers.some((p) => p.userId === ownerId)) {
      this._hostSeen.set(status.docId, Date.now())
      if (entry.guestAway) this._patch(status.docId, { guestAway: false })
    }
  }

  // A guest's copy with 'hide' is deleted once the owner has been gone a
  // minute (it comes back when they are online again); with 'keep' it just
  // can't be edited meanwhile.
  _checkGuestHosts (now = Date.now()) {
    for (const entry of this.files.values()) {
      if (!entry.guest || entry.ended) continue
      const ownerId = this._ownerOf(entry.docId)
      if ((this.engine.status(entry.docId)?.peers || []).some((p) => p.userId === ownerId)) {
        this._hostSeen.set(entry.docId, now)
        if (entry.guestAway) this._patch(entry.docId, { guestAway: false })
        continue
      }
      const seen = this._hostSeen.get(entry.docId) || 0
      if (now - seen < this.guestGraceMs) continue
      if (!entry.guestAway) this._patch(entry.docId, { guestAway: true })
      const doc = this.engine.getDoc(entry.docId)
      const hasContent = doc && doc.ydoc.store.clients.size > 0
      if (entry.guest.after === 'hide' && hasContent) {
        this._wipe(entry.docId)
        this._attach(this.files.get(entry.docId))
      }
    }
  }

  // Guests are served by the owner, so they end when ownership moves.
  transferOwnership (docId, userId) {
    this.engine.transferOwnership(docId, userId)
    this.guests.endAllFor(docId)
  }

  // When someone's access ends (until: ms, or null for never) and what their
  // computer does with its copy then. Not for access a shared folder gives:
  // the folder would only give it back.
  setMemberAccess (docId, userId, { until = null, after = 'keep' } = {}) {
    this._refuseIfFromFolder(docId, userId)
    if (until != null && !(until > Date.now())) throw new Error('Choose a time later than now, or remove them instead.')
    this.engine.setMemberAccess(docId, userId, { until, after })
  }

  resetInvites (docId) { this.engine.resetInvites(docId) }

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
      folderId: where && this.shared.isFolder(where) && ['owner', 'editor'].includes(this.engine.access(where)?.role) ? where : this.folders.has(entry.folderId) ? entry.folderId : null,
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

  // The shared folder of mine that lists a file, if any.
  _inMyFolders (docId) {
    for (const f of this.shared.folders()) if (this.shared.items(f.docId).has(docId)) return f.docId
    return null
  }

  // Files I removed from a shared folder, and bringing them back.
  removedFrom (folderId) {
    return [...this.dismissed.entries()].filter(([, d]) => d?.folderId === folderId).map(([docId]) => docId)
  }

  restoreRemoved (folderId) {
    for (const docId of this.removedFrom(folderId)) this.dismissed.delete(docId)
    this.shared.soon()
  }

  // Before a shared folder leaves my Drive: what I own comes out of it (to
  // where the folder was), so it stops being shared through a folder I can
  // no longer see.
  _leaveFolder (folderId) {
    const where = this.files.get(folderId)?.folderId
    const canChange = ['owner', 'editor'].includes(this.engine.access(folderId)?.role)
    for (const [childId] of this.shared.items(folderId)) {
      const child = this.files.get(childId)
      if (!child) continue
      if (canChange && this.engine.access(childId)?.owner === this.identity.userId) this.shared.remove(folderId, childId)
      this._patch(childId, { folderId: this.folders.has(where) ? where : null, viaFolder: child.viaFolder === folderId ? null : child.viaFolder })
    }
    for (const e of this.files.values()) if (e.folderId === folderId) this._patch(e.docId, { folderId: this.folders.has(where) ? where : null })
  }

  // Someone else's file, found in a shared folder of mine: join it with its
  // secret alone. Its owner adds me to it; until then nothing arrives.
  _joinFromFolder (docId, item, folderId) {
    // Files from people you've blocked, and more files in a day than your
    // limit, arrive paused: listed, but nothing syncs until you say so.
    const mine = item.owner === this.identity.userId
    const blocked = !mine && this.policy.isBlocked(item.owner)
    const many = !mine && !blocked && !this.policy.allowJoin(folderId)
    this.files.set(docId, {
      ...(blocked || many ? { held: true, heldReason: blocked ? 'blocked' : 'many', heldBytes: 0 } : {}),
      docId,
      secret: item.secret,
      invite: null,
      type: null,
      title: item.title || 'Waiting for a peer…',
      owner: { userId: item.owner, name: item.ownerName },
      folderId: null,
      viaFolder: folderId,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    if (item.owner !== this.identity.userId) this.activity.shared(docId, folderId, { userId: item.owner, name: item.ownerName })
  }

  // ---- folders -------------------------------------------------------------

  createFolder (name, parentId = null) {
    const id = randomBytes(8).toString('hex')
    this.folders.set(id, { id, name: cleanName(name) || 'Untitled folder', parentId: this.folders.has(parentId) ? parentId : null, createdAt: Date.now() })
    this._changed()
    return id
  }

  renameFolder (id, name) {
    if (this.shared.isFolder(id)) { if (cleanName(name)) this.rename(id, cleanName(name)); return }
    const f = this.folders.get(id)
    if (f && cleanName(name)) { this.folders.set(id, { ...f, name: cleanName(name) }); this._changed() }
  }

  // Deleting a folder never deletes files: its contents move up one level.
  deleteFolder (id) {
    if (this.shared.isFolder(id)) return this.remove(id)
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

  // Moves a file (or a shared folder) into one of my folders, a shared
  // folder, or the top. Into a shared folder means sharing it with everyone
  // there; out of one means they lose what they had only through it.
  // Returns { localOnly } when it's in a shared folder for me only.
  moveFile (docId, folderId) {
    const entry = this.files.get(docId)
    if (!entry) return {}
    const containers = this.shared.containers()
    const from = this.shared.placeOf(docId, containers)
    if (from === folderId) return {}
    const toShared = folderId && this.shared.isFolder(folderId)
    if (from && this.shared.isFolder(from) && (containers.get(docId) || []).includes(from)) this.shared.remove(from, docId)
    if (toShared) {
      try {
        this.shared.add(folderId, docId)
        this._patch(docId, { folderId: null })
      } catch (err) {
        if (!err.localOnly) throw err
        this._patch(docId, { folderId })
        return { localOnly: true, message: err.message }
      }
    } else {
      this._patch(docId, { folderId: this.folders.has(folderId) ? folderId : null })
    }
    this._changed()
    return {}
  }

  // A new shared folder, empty, with me as its owner.
  async createSharedFolder (name, parentId = null) {
    return this.create('folder', cleanName(name) || 'Shared folder', { folderId: parentId })
  }

  // Turns one of my folders into a shared folder, with its subfolders.
  // What I own goes in it for everyone; files others own stay in it for me.
  async shareFolder (id) {
    const f = this.folders.get(id)
    if (!f) throw new Error('No such folder.')
    const docId = await this.create('folder', f.name, { folderId: this.folders.has(f.parentId) ? f.parentId : null })
    for (const sub of [...this.folders.values()].filter((x) => x.parentId === id)) {
      const subId = await this.shareFolder(sub.id)
      this.moveFile(subId, docId)
    }
    for (const entry of [...this.files.values()].filter((e) => e.folderId === id)) this.moveFile(entry.docId, docId)
    this.folders.delete(id)
    this._changed()
    return docId
  }

  moveFolder (id, parentId) {
    if (this.shared.isFolder(id)) {
      for (let p = parentId; p; p = this.shared.isFolder(p) ? this.shared.placeOf(p) : this.folders.get(p)?.parentId) if (p === id) return false
      this.moveFile(id, parentId)
      return true
    }
    if (parentId && this.shared.isFolder(parentId)) throw new Error('Share this folder first: only shared folders go inside a shared folder.')
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
      snapshot: !u ? null : app.snapshotUnit ? app.snapshotUnit(u) : (u.el && app.snapshotBlock ? app.snapshotBlock(u.el) : null)
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

  // Tells the relay client which relays a file (or my index) uses.
  _applyRelays (docId) {
    if (this.files.get(docId)?.guest) { this.relays?.setRelays(docId, []); return } // guests sync only with the owner
    if (!this.relays) return
    if (docId === this.indexId) { this.relays.setRelays(docId, [...this.myRelaysMap.keys()]); return }
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc) return
    const keys = new Set([...doc.ydoc.getMap(RELAYS_MAP).keys(), ...(entry.inviteRelays || entry.inviteHelpers || [])])
    this.relays.setRelays(docId, this._shouldSync(entry) ? [...keys] : [])
  }

  _shouldSync (entry) {
    if (entry.held) return false
    return entry.syncMode !== 'open' || this._open.has(entry.docId)
  }

  // ---- protecting the disk ----------------------------------------------------------

  // A file stops syncing (until I say to keep going) when changes from
  // others would hurt this computer:
  //   'size'  someone else's file grew past my limit for one file;
  //   'own'   my own file grew past my (higher) limit through others' edits;
  //   'total' all the files others made, together, passed my limit;
  //   'space' the disk got down to the free space I keep.
  // Others: 'many' (a shared folder brought too many files today) and
  // 'blocked' (from someone I've blocked).
  _guardSoon (docId) {
    this._guardTimers = this._guardTimers || new Map()
    if (this._guardTimers.has(docId)) return
    this._guardTimers.set(docId, setTimeout(() => { this._guardTimers.delete(docId); this._guard(docId) }, 2000))
  }

  _guard (docId) {
    const entry = this.files.get(docId)
    if (!entry || entry.held) return
    const p = this.policy
    const mine = this._ownerOf(docId) === this.identity.userId
    const bytes = this.store.sizeOf(docId)
    const allowed = entry.allowBytes || 0
    let reason = null
    if (this.uploads.freeBytes() < p.get('keepFreeBytes')) reason = 'space'
    else if (bytes > Math.max(p.get(mine ? 'ownDocGuardBytes' : 'docGuardBytes'), allowed)) reason = mine ? 'own' : 'size'
    else if (!mine && bytes > allowed && this._othersBytes() > p.get('othersDocsBytes')) reason = 'total'
    if (reason) this._hold(docId, reason, bytes)
  }

  _hold (docId, reason, bytes = this.store.sizeOf(docId)) {
    this._patch(docId, { held: true, heldReason: reason, heldBytes: bytes })
    this._applyActive(docId)
    this.emit('held', docId, bytes, reason)
  }

  _ownerOf (docId) {
    return this.engine.access(docId)?.owner || this.files.get(docId)?.owner?.userId || null
  }

  // Bytes of every document others made, together.
  _othersBytes () {
    let n = 0
    for (const entry of this.files.values()) if (this._ownerOf(entry.docId) !== this.identity.userId) n += this.store.sizeOf(entry.docId)
    return n
  }

  // Keep syncing a paused file. A size limit then lets it double before
  // asking again.
  keepSyncing (docId) {
    const entry = this.files.get(docId)
    if (!entry?.held) return
    const owner = this._ownerOf(docId)
    if (owner && this.policy.isBlocked(owner)) throw new Error('You’ve blocked the person who made this file. Unblock them in Settings first.')
    const grows = ['size', 'own', 'total', 'space'].includes(entry.heldReason || 'size')
    this._patch(docId, { held: false, heldReason: null, allowBytes: grows ? Math.max(entry.allowBytes || 0, (entry.heldBytes || 0) * 2) : entry.allowBytes || 0 })
    this._applyActive(docId)
  }

  // Everything a shared folder brought paused today, in one go.
  keepSyncingFolder (folderId) {
    for (const entry of [...this.files.values()]) if (entry.held && entry.heldReason === 'many' && entry.viaFolder === folderId) this.keepSyncing(entry.docId)
  }

  // ---- limits and blocking ------------------------------------------------------------

  policySettings () { return { values: this.policy.all(), defaults: this.policy.defaults, blocked: this.policy.blocked } }

  setPolicy (patch) {
    this.policy.set(patch || {})
    this._changed()
    return this.policySettings()
  }

  resetPolicy () {
    this.policy.reset()
    this._changed()
    return this.policySettings()
  }

  // Ignore someone everywhere: their files pause, their uploads never
  // download, and this computer stops exchanging anything with them.
  block (userId, name) {
    if (userId === this.identity.userId) throw new Error('You can’t block yourself.')
    this.policy.block({ userId, name })
    for (const entry of [...this.files.values()]) if (!entry.held && this._ownerOf(entry.docId) === userId) this._hold(entry.docId, 'blocked')
    this.engine.recheckUser(userId)
    this.uploads.decideAll()
    this._changed()
  }

  unblock (userId) {
    this.policy.unblock(userId)
    for (const entry of [...this.files.values()]) if (entry.held && entry.heldReason === 'blocked' && this._ownerOf(entry.docId) === userId) this.keepSyncing(entry.docId)
    this.engine.recheckUser(userId)
    this.uploads.decideAll()
    this._changed()
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
