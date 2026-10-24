// A commonplace server (docs/TEAM-DRIVES.md): a Drive with no window, left
// running, that hosts team drives. It has an identity of its own, owns its
// server document and each drive's catalog, and is a manager of every file
// in its drives, so people get in and out of them with nobody else online.
//
// Its admins are managers of its server document. They ask it to do things
// by leaving requests there; it answers in place.

import fs from 'node:fs'
import path from 'node:path'
import { Drive, serverApp, readServerDoc, drivePolicy, STATUS, DRIVES, REQUESTS, POLICY, DEFAULT_DRIVE_POLICY } from '@commonplace/drive'
import { docsApps } from '@commonplace/docs'
import { sheetsApp } from '@commonplace/sheets'
import { slidesApp } from '@commonplace/slides'
import { tasksApp } from '@commonplace/tasks'
import { calendarApp } from '@commonplace/calendar'
import { whiteboardApp } from '@commonplace/whiteboard'
import { formsApp } from '@commonplace/forms'

const APPS = [...docsApps, sheetsApp, slidesApp, tasksApp, calendarApp, whiteboardApp, formsApp]
const GB = 1024 ** 3
const DAY = 24 * 3600e3
const STATUS_EVERY_MS = 60e3
const USAGE_EVERY_MS = 10 * 60e3
const ADMIN_LINK_MS = 7 * DAY
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version

// A server keeps everything its drives hold, so it accepts more than a
// person's computer would. It still keeps space free on its disk.
const SERVER_POLICY = {
  autoBytes: 4 * GB,
  maxFileBytes: 4 * GB,
  askRisky: false,
  personDailyBytes: 1024 * GB,
  dailyBytes: 1024 * GB,
  docGuardBytes: 100 * GB,
  ownDocGuardBytes: 100 * GB,
  othersDocsBytes: 10 * 1024 * GB
}

export class TeamServer {
  // dir: where it keeps everything. name: what people see it called.
  // swarm, lan: as for a Drive (tests use a private network).
  constructor ({ dir, name = 'commonplace server', swarm = {}, lan = true, policy = {}, log = () => {} }) {
    this.dir = dir
    this.name = String(name).slice(0, 40)
    this.log = log
    this.drive = new Drive({ dataDir: dir, apps: APPS, swarm, lan, deviceName: 'server', policy: { ...SERVER_POLICY, ...policy }, appVersion: VERSION, keepEverything: true })
    this.drive.on('error', (err) => this.log(`error: ${err.message}`))
    this._busy = new Set()
    this._timers = []
  }

  get me () { return this.drive.identity.userId }

  // Starts it. Returns { serverId, adminLink }: adminLink (a one-time
  // manager link to the server document) while it has no admins yet.
  async start () {
    await this.drive.start()
    if (this.drive.identity.name !== this.name) this.drive.setProfile({ name: this.name })
    this.serverId = this._findServerDoc() || await this.drive.create('server', this.name)
    const doc = this.drive.getDoc(this.serverId)
    doc.ydoc.getMap(REQUESTS).observe(() => this._handleRequests())
    this.drive.engine.on('members', () => this._handoverSoon())
    this.startedAt = Date.now()
    this._writeStatus(true)
    this._timers.push(setInterval(() => this._writeStatus(), STATUS_EVERY_MS))
    this._timers.push(setInterval(() => this._handovers(), 5 * 60e3))
    for (const t of this._timers) t.unref?.()
    this._handleRequests()
    this._handovers()
    return { serverId: this.serverId, adminLink: this.admins().length ? null : this.adminLink() }
  }

  async stop () {
    for (const t of this._timers) clearInterval(t)
    clearTimeout(this._handoverTimer)
    await this.drive.stop()
  }

  _findServerDoc () {
    for (const e of this.drive.files.values()) if (e.type === 'server' && e.owner?.userId === this.me) return e.docId
    return null
  }

  admins () {
    return this.drive.engine.membersDetailed(this.serverId).filter((m) => m.role === 'manager')
  }

  // A link that makes one person an admin: it works once, for a week.
  adminLink () {
    return this.drive.invite(this.serverId, 'manager', { once: true, expiresIn: ADMIN_LINK_MS })
  }

  teamDrives () {
    return readServerDoc(this.drive.getDoc(this.serverId).ydoc).drives
  }

  // ---- requests --------------------------------------------------------------

  _handleRequests () {
    const ydoc = this.drive.getDoc(this.serverId)?.ydoc
    if (!ydoc) return
    const requests = ydoc.getMap(REQUESTS)
    for (const [id, r] of requests.entries()) {
      if (r?.state !== 'pending' || this._busy.has(id)) continue
      this._busy.add(id)
      this._answer(r)
        .then((result) => ({ state: 'done', result }), (err) => ({ state: 'failed', error: String(err.message || err).slice(0, 300) }))
        .then((answer) => {
          ydoc.transact(() => requests.set(id, { ...r, ...answer, doneAt: Date.now() }), 'local')
          this._busy.delete(id)
          this.log(`${r.kind}: ${answer.state}${answer.error ? ` (${answer.error})` : ''}`)
        })
    }
    // Answers stay a day, so the person asking sees them.
    for (const [id, r] of requests.entries()) if (r?.doneAt && Date.now() - r.doneAt > DAY) ydoc.transact(() => requests.delete(id), 'local')
  }

  async _answer (r) {
    // Only admins write in the server document; still, the person named
    // must be one of them.
    const admin = this.admins().find((m) => m.userId === r.by)
    if (!admin) throw new Error('Only the server’s admins can ask it that.')
    const args = r.args && typeof r.args === 'object' ? r.args : {}
    if (r.kind === 'createDrive') return { driveId: await this.createDrive(String(args.name || 'Team drive'), admin) }
    if (r.kind === 'adminLink') return { link: this.adminLink() }
    if (r.kind === 'driveAdmin') { this.makeDriveAdmin(String(args.driveId), String(args.userId)); return {} }
    throw new Error('This server doesn’t know how to do that. It may need updating.')
  }

  // A new team drive: its catalog, owned by the server, with the admin who
  // asked as one of its admins.
  async createDrive (name, admin) {
    const title = name.replace(/\s+/g, ' ').trim().slice(0, 120) || 'Team drive'
    const id = await this.drive.createSharedFolder(title)
    const catalog = this.drive.getDoc(id)
    catalog.ydoc.transact(() => {
      catalog.ydoc.getMap('meta').set('drive', { host: this.me })
      const policy = catalog.ydoc.getMap(POLICY)
      for (const [k, v] of Object.entries(DEFAULT_DRIVE_POLICY)) policy.set(k, v)
    }, 'local')
    if (admin) this.drive.engine.addMember(id, { userId: admin.userId, role: 'manager', enc: admin.enc })
    const ydoc = this.drive.getDoc(this.serverId).ydoc
    ydoc.transact(() => ydoc.getMap(DRIVES).set(id, { name: title, secret: this.drive.files.get(id).secret, at: Date.now() }), 'local')
    return id
  }

  // Only the catalog's owner gives the manager role, so admins ask.
  makeDriveAdmin (driveId, userId) {
    if (!this.teamDrives().some((d) => d.id === driveId)) throw new Error('No such team drive.')
    const m = this.drive.getDoc(driveId)?.members.member(userId)
    if (!m) throw new Error('Add them to the drive first.')
    if (m.role !== 'manager') this.drive.engine.setRole(driveId, userId, 'manager')
  }

  // ---- handovers -----------------------------------------------------------------

  _handoverSoon () {
    clearTimeout(this._handoverTimer)
    this._handoverTimer = setTimeout(() => this._handovers(), 2000)
    this._handoverTimer.unref?.()
  }

  // Files whose owner promised a handover to me and is no longer in that
  // drive: ownership goes to the drive's first admin, and the former owner
  // is removed as the drive's rules say.
  _handovers () {
    const engine = this.drive.engine
    for (const e of this.drive.files.values()) {
      const doc = engine.getDoc(e.docId)
      const h = doc?.members.handover
      if (!h || h.to !== this.me || !h.drive) continue
      const catalog = engine.getDoc(h.drive)
      if (!catalog?.members.exists || catalog.members.owner !== this.me) continue
      const formerOwner = doc.members.owner
      if (catalog.members.member(formerOwner)) continue
      const admin = engine.membersDetailed(h.drive).find((m) => m.role === 'manager' && m.userId !== this.me && m.enc)
      if (!admin) continue // nobody to give it to yet; the server keeps hosting it
      try {
        if (!doc.members.member(admin.userId)) engine.addMember(e.docId, { userId: admin.userId, role: 'editor', enc: admin.enc })
        engine.transferOwnership(e.docId, admin.userId)
        engine.removeMember(e.docId, formerOwner, { after: drivePolicy(catalog.ydoc).keepCopies ? 'keep' : 'hide' })
        this.log(`handed ${e.title || e.docId} to ${admin.name || admin.userId.slice(0, 8)}`)
      } catch (err) { this.log(`handover failed for ${e.docId}: ${err.message}`) }
    }
  }

  // ---- status -----------------------------------------------------------------------

  _writeStatus (now = false) {
    const ydoc = this.drive.getDoc(this.serverId)?.ydoc
    if (!ydoc) return
    if (now || !this._usageAt || Date.now() - this._usageAt > USAGE_EVERY_MS) { this._used = dirBytes(this.dir); this._usageAt = Date.now() }
    const free = this.drive.uploads.freeBytes()
    ydoc.transact(() => {
      const s = ydoc.getMap(STATUS)
      s.set('version', VERSION)
      s.set('startedAt', this.startedAt)
      s.set('seenAt', Date.now())
      s.set('usedBytes', this._used)
      s.set('freeBytes', Number.isFinite(free) ? free : null)
    }, 'local')
  }
}

function dirBytes (dir) {
  let total = 0
  const walk = (d) => {
    let list = []
    try { list = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const ent of list) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) walk(p)
      else if (ent.isFile()) { try { total += fs.statSync(p).size } catch {} }
    }
  }
  walk(dir)
  return total
}

export { serverApp }
