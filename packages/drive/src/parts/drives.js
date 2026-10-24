// Servers and team drives, from the Drive's side (docs/TEAM-DRIVES.md): the
// servers I help run, the team drives I'm in, asking a server to do things,
// and moving files in and out of team drives.
//
// Every file belongs to one drive: My Drive, or a team drive. Moving a file
// into a team drive keeps its owner (always a person) and adds the drive's
// server as a manager ("Can edit and share"), so the server hosts it and
// manages who has it; if the drive asks for one, the owner also signs a
// handover. Moving it out undoes all three.

import crypto from 'node:crypto'
import { deriveDocKeys } from '@commonplace/core'
import { readServerDoc, drivePolicy, REQUESTS, POLICY, DEFAULT_DRIVE_POLICY } from '../team-drives.js'

const ASK_TIMEOUT_MS = 60e3

export class TeamDrives {
  _watchTeamDrives () {
    // A server I help run lists a new team drive: join it.
    this.engine.on('update', (docId, update, origin) => {
      if (origin !== 'disk' && this.files.get(docId)?.type === 'server') this._joinServerDrives()
    })
  }

  // ---- what I'm part of ------------------------------------------------------

  // The servers I'm an admin of.
  servers () {
    return [...this.files.values()].filter((e) => e.type === 'server' && !e.trashedAt).map((e) => {
      const doc = this.engine.getDoc(e.docId)
      const host = doc?.members.owner || e.owner?.userId || null
      const info = doc ? readServerDoc(doc.ydoc) : { status: {}, drives: [] }
      return {
        id: e.docId,
        name: e.title,
        host,
        online: this._hostOnline(e.docId, host),
        status: info.status,
        drives: info.drives.map((d) => ({ id: d.id, name: d.name, joined: this.files.has(d.id) }))
      }
    })
  }

  // The team drives I'm in.
  teamDrives () {
    return [...this.files.values()].filter((e) => e.type === 'folder' && this.shared.driveInfo(e.docId)).map((e) => {
      const doc = this.engine.getDoc(e.docId)
      const { host } = this.shared.driveInfo(e.docId)
      const role = this.engine.access(e.docId)?.role || null
      return {
        id: e.docId,
        name: e.title,
        host,
        hostName: doc?.ydoc.getMap('people').get(host)?.name || e.owner?.name || 'its server',
        online: this._hostOnline(e.docId, host),
        role,
        admin: role === 'manager',
        policy: doc ? drivePolicy(doc.ydoc) : { ...DEFAULT_DRIVE_POLICY },
        server: [...this.files.values()].find((s) => s.type === 'server' && this.engine.getDoc(s.docId)?.members.owner === host)?.docId || null
      }
    })
  }

  // Where a file belongs, from the file itself: { id, name, host } for a
  // team drive, or null for My Drive. Everyone who has the file sees it.
  driveOfFile (docId) {
    const d = this.engine.getDoc(docId)?.ydoc.getMap('meta').get('drive')
    return d && /^[0-9a-f]{32}$/.test(String(d.id)) && /^[0-9a-f]{64}$/.test(String(d.host))
      ? { id: d.id, name: typeof d.name === 'string' ? d.name.slice(0, 120) : 'Team drive', host: d.host, online: this._hostOnline(docId, d.host) }
      : null
  }

  _driveSummary (docId, nameOf) {
    const d = this.driveOfFile(docId)
    if (!d) return null
    const catalog = this.files.get(d.id)
    const inDrive = Boolean(catalog && this.shared.driveInfo(d.id))
    const hostName = nameOf(d.host, (catalog?.owner?.userId === d.host && catalog.owner.name) || 'its server')
    // in: I'm in that drive (else I have the file some other way).
    return { ...d, name: catalog?.title || d.name, hostName, in: inDrive }
  }

  _hostOnline (docId, host) {
    if (!host) return false
    if (host === this.identity.userId) return true
    return Boolean(this.engine.status(docId)?.peers.some((p) => p.userId === host))
  }

  // ---- asking a server ----------------------------------------------------------

  // Leaves a request in the server's document and waits for its answer.
  askServer (serverId, kind, args = {}) {
    const doc = this.engine.getDoc(serverId)
    if (!doc || this.files.get(serverId)?.type !== 'server') return Promise.reject(new Error('No such server.'))
    const id = crypto.randomBytes(8).toString('hex')
    const requests = doc.ydoc.getMap(REQUESTS)
    doc.ydoc.transact(() => requests.set(id, { kind, args, by: this.identity.userId, at: Date.now(), state: 'pending' }), 'local')
    return new Promise((resolve, reject) => {
      const check = () => {
        const r = requests.get(id)
        if (r?.state === 'done') { done(); resolve(r.result || {}) } else if (r?.state === 'failed') { done(); reject(new Error(r.error || 'The server couldn’t do that.')) }
      }
      const timer = setTimeout(() => { done(); reject(new Error('The server didn’t answer. Check that it’s running.')) }, ASK_TIMEOUT_MS)
      timer.unref?.()
      const done = () => { clearTimeout(timer); requests.unobserve(check) }
      requests.observe(check)
      check()
    })
  }

  async createTeamDrive (serverId, name) {
    const { driveId } = await this.askServer(serverId, 'createDrive', { name: String(name || '').trim().slice(0, 120) || 'Team drive' })
    this._joinServerDrives()
    // The server is online (it just answered): wait for the drive to arrive.
    for (const end = Date.now() + ASK_TIMEOUT_MS; Date.now() < end && !this.shared.driveInfo(driveId);) await new Promise((resolve) => setTimeout(resolve, 200))
    return driveId
  }

  // A link that makes one more person an admin of the server.
  async serverAdminLink (serverId) {
    const { link } = await this.askServer(serverId, 'adminLink')
    return link
  }

  // Only the server (each drive's owner) can make someone an admin of a drive.
  async makeDriveAdmin (driveId, userId) {
    const drive = this.teamDrives().find((d) => d.id === driveId)
    if (!drive?.server) throw new Error('Only admins of its server can do that.')
    await this.askServer(drive.server, 'driveAdmin', { driveId, userId })
  }

  setDrivePolicy (driveId, patch) {
    const doc = this.engine.getDoc(driveId)
    if (!doc || !this.shared.driveInfo(driveId)) throw new Error('No such team drive.')
    if (this.engine.access(driveId)?.role !== 'manager') throw new Error('Only the drive’s admins can change its rules.')
    const policy = doc.ydoc.getMap(POLICY)
    doc.ydoc.transact(() => { for (const k of Object.keys(DEFAULT_DRIVE_POLICY)) if (typeof patch[k] === 'boolean') policy.set(k, patch[k]) }, 'local')
    this._changed()
    return drivePolicy(doc.ydoc)
  }

  // Team drives my servers list that I'm not in yet (the server made me
  // their admin before listing them).
  _joinServerDrives () {
    for (const s of this.servers()) {
      const doc = this.engine.getDoc(s.id)
      if (!doc) continue
      for (const d of readServerDoc(doc.ydoc).drives) {
        if (this.files.has(d.id) || this.dismissed.has(d.id)) continue
        this._joinBySecret(d.secret, { title: d.name, owner: { userId: s.host, name: s.name } })
      }
    }
  }

  _joinBySecret (secretB64, { title = 'Waiting for a peer…', owner = null } = {}) {
    const secret = Buffer.from(secretB64, 'base64')
    if (secret.length !== 32) return null
    const { docId } = deriveDocKeys(secret)
    if (this.files.has(docId)) return docId
    this.files.set(docId, { docId, secret: secretB64, invite: null, type: null, title, owner, folderId: null, addedAt: Date.now() })
    this._attach(this.files.get(docId))
    this._changed()
    return docId
  }

  // ---- moving in and out -----------------------------------------------------------

  // Before a file of mine goes into a team drive: its server becomes a
  // manager, the handover is signed if the drive asks, and the file says
  // where it belongs. A shared folder brings the files of mine inside it.
  _enterDrive (docId, driveId, seen = new Set()) {
    if (seen.has(docId)) return
    seen.add(docId)
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    if (!doc || !entry) throw new Error('No such file.')
    if (!doc.members.exists && entry.owner?.userId === this.identity.userId) this.engine.ensureMembership(docId)
    if (doc.members.owner !== this.identity.userId) throw new Error(`Only ${entry.owner?.name || 'its owner'} can move this into a team drive. It stays theirs; the drive’s server helps host it.`)
    const catalog = this.engine.getDoc(driveId)
    const info = this.shared.driveInfo(driveId)
    const hostEnc = info && catalog?.members.member(info.host)?.enc
    if (!hostEnc) throw new Error('This team drive hasn’t finished arriving. Try again in a moment.')
    const cur = doc.members.member(info.host)
    if (!cur) this.engine.addMember(docId, { userId: info.host, role: 'manager', enc: hostEnc })
    else if (cur.role !== 'manager') this.engine.setRole(docId, info.host, 'manager')
    if (drivePolicy(catalog.ydoc).handover && doc.members.handover?.to !== info.host) this.engine.setHandover(docId, { to: info.host, drive: driveId })
    doc.ydoc.transact(() => doc.ydoc.getMap('meta').set('drive', { id: driveId, name: this.files.get(driveId)?.title || 'Team drive', host: info.host }), 'local')
    if (entry.type === 'folder') {
      for (const [childId, it] of this.shared.items(docId)) if (it.owner === this.identity.userId) this._enterDrive(childId, driveId, seen)
    }
  }

  // After a file of mine leaves a team drive: the handover is withdrawn,
  // the server is removed (the file moves to a new key; it keeps a
  // read-only copy if the drive keeps copies), and the file is in My Drive.
  _leaveDrive (docId, driveId, seen = new Set()) {
    if (seen.has(docId)) return
    seen.add(docId)
    const doc = this.engine.getDoc(docId)
    if (!doc || doc.members.owner !== this.identity.userId) return
    const info = this.shared.driveInfo(driveId) || this.driveOfFile(docId)
    if (doc.members.handover) this.engine.setHandover(docId, { to: null })
    if (info && doc.members.member(info.host)) {
      const keep = drivePolicy(this.engine.getDoc(driveId)?.ydoc).keepCopies
      this.engine.removeMember(docId, info.host, { after: keep ? 'keep' : 'hide' })
    }
    doc.ydoc.transact(() => doc.ydoc.getMap('meta').delete('drive'), 'local')
    if (this.files.get(docId)?.type === 'folder') for (const childId of this.shared.items(docId).keys()) this._leaveDrive(childId, driveId, seen)
  }
}
