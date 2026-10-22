// Uploaded files (any type) and what they cost your disk.
//
// A file is a document of type 'file' whose `versions` list says, for each
// upload, its name, size, SHA-256 and the hashes of its 256 KB chunks. The
// chunks themselves move separately (core/chunks.js) and only when this
// computer decides to fetch them. With the default limits (all of them
// settings, see policy.js):
//
//   - your own uploads are kept, of course;
//   - other people's files download by themselves only if they're small
//     (10 MB or less) and of an ordinary kind, and only within a daily
//     budget per person (200 MB) and in all (1 GB);
//   - anything bigger, over your largest-file limit, or a kind that can run
//     code (.exe, .dmg, .sh, web pages, documents with macros, ...), waits
//     for you to say yes, and then is never opened directly, only saved;
//   - nothing downloads if it would leave less than 2 GB free on the disk;
//   - nothing at all comes from people you've blocked.
//
// Chunks you didn't ask for are refused, so the network can't fill your
// disk. Shared documents are guarded too (see Drive._guard).

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { CHUNK_SIZE, canEdit } from '@commonplace/core'
import { HARD_MAX_FILE_BYTES, DEFAULT_POLICY } from './policy.js'

export const MAX_FILE_BYTES = DEFAULT_POLICY.maxFileBytes
export const GUARD_BYTES = DEFAULT_POLICY.docGuardBytes
const VERSIONS = 'versions'
const HOUR = 3600e3

// Kinds of file that can run code when opened.
const RISKY = new Set('exe msi msp com scr pif bat cmd ps1 psm1 vbs vbe js jse wsf wsh hta cpl msc jar app command sh bash zsh csh ksh fish pkg mpkg dmg apk ipa deb rpm run bin reg lnk url iso img dll so dylib sys drv py pyw rb pl php scpt workflow appimage xpi crx desktop terminal inf cab vb ws application appx appxbundle msix msixbundle html htm xhtml mht mhtml svg docm dotm xlsm xltm xlam pptm potm ppam'.split(' '))
const KINDS = {
  image: 'png jpg jpeg gif webp bmp heic avif tif tiff ico',
  video: 'mp4 m4v mov webm mkv avi',
  audio: 'mp3 m4a wav ogg oga flac aac opus',
  pdf: 'pdf',
  text: 'txt md csv tsv json log xml yaml yml ini toml',
  archive: 'zip tar gz tgz bz2 xz 7z rar',
  document: 'doc docx odt rtf pages',
  spreadsheet: 'xls xlsx ods numbers',
  presentation: 'ppt pptx odp key'
}
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, list]) => list.split(' ').map((e) => [e, k])))

// What a file name says about it (never what the sender says).
export function fileKind (name) {
  const ext = (/\.([a-z0-9]{1,10})$/i.exec(String(name || ''))?.[1] || '').toLowerCase()
  return { ext, kind: RISKY.has(ext) ? 'program' : KIND_OF.get(ext) || 'other', risky: RISKY.has(ext) }
}

// A file name that is safe to save: no folders, no invisible characters that
// disguise the real extension ("photo‮gnp.exe"), nothing Windows refuses.
export function safeFileName (name) {
  let n = String(name || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '') // eslint-disable-line no-control-regex
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/^[.\s]+|[.\s]+$/g, '')
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(n)) n = `_${n}`
  if (n.length > 150) {
    const ext = /\.[^.]{1,10}$/.exec(n)?.[0] || ''
    n = n.slice(0, 150 - ext.length) + ext
  }
  return n || 'file'
}

export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`)

// ---- the app descriptor ------------------------------------------------------------

export const currentVersion = (ydoc) => {
  const list = ydoc.getArray(VERSIONS).toArray().filter(validVersion)
  return list.sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : 1)).pop() || null
}

function validVersion (v) {
  return v && typeof v.id === 'string' && Number.isInteger(v.size) && v.size >= 0 && v.size <= HARD_MAX_FILE_BYTES &&
    Array.isArray(v.chunks) && v.chunks.length === Math.ceil(v.size / CHUNK_SIZE) && v.chunks.every((h) => /^[0-9a-f]{64}$/.test(h)) &&
    /^[0-9a-f]{64}$/.test(v.sha256)
}

export const filesApp = {
  type: 'file',
  kind: 'file',
  name: 'Uploaded file',
  description: 'Any file you upload, up to your largest-file limit (100 MB unless you change it).',
  hidden: true, // made by uploading, not from the New menu
  schemaVersion: 1,
  exports: [],
  initContent () {},
  preview (ydoc) {
    const v = currentVersion(ydoc)
    return v ? `${fileKind(v.name).ext.toUpperCase() || 'File'} · ${formatBytes(v.size)}` : 'Waiting for the file'
  },
  thumbnail (ydoc) {
    const v = currentVersion(ydoc)
    return v ? { name: safeFileName(v.name), ...fileKind(v.name), size: v.size, image: typeof v.thumb === 'string' && v.thumb.startsWith('data:image/jpeg;base64,') && v.thumb.length < 60000 ? v.thumb : null } : null
  },
  history: { roots: [] }
}

// ---- the manager -------------------------------------------------------------------

export class Files extends EventEmitter {
  // makeThumb(path) -> small JPEG data URL or null (the desktop app makes it).
  constructor (drive, { makeThumb = null } = {}) {
    super()
    this.drive = drive
    this.engine = drive.engine
    this.blobs = drive.engine.chunks.blobs
    this.makeThumb = makeThumb
    this.policy = drive.policy
    this.file = path.join(drive.dataDir, 'storage.json')
    this.state = { approved: {}, removed: {}, ...readJson(this.file) }
    // Settings from before limits moved to the policy.
    if (this.state.settings) {
      if (this.policy.fresh && this.state.settings.autoBytes != null) this.policy.set({ autoBytes: this.state.settings.autoBytes })
      delete this.state.settings
    }
    this.watched = new Set()
    // Limits changed, or a new day's budget: look again at what's waiting.
    this.policy.onChange(() => this.decideAll())
    this.timer = setInterval(() => this.decideAll(), HOUR)
    this.timer.unref?.()
    // Only serve chunks that belong to the file being asked about.
    this.engine.allowChunk = (docId, hash) => this._versionsOf(docId).some((v) => v.chunks.includes(hash))
    this.engine.chunks.on('chunk', (docId) => this._progress(docId))
  }

  get settings () { return this.policy.all() }

  setSettings (patch) { this.policy.set(patch) }

  decideAll () { for (const docId of this.watched) this._decide(docId) }

  destroy () { clearInterval(this.timer) }

  // Who answers for a file: its owner, as signed in its membership log.
  ownerOf (docId) {
    return this.engine.access(docId)?.owner || this.drive.files.get(docId)?.owner?.userId || null
  }

  // Called for every file in the Drive; acts only on uploaded files.
  watch (docId) {
    if (this.watched.has(docId)) return
    const doc = this.engine.getDoc(docId)
    if (!doc) return
    this.watched.add(docId)
    doc.ydoc.getArray(VERSIONS).observe(() => { this._decide(docId); this.drive._changed() })
    this._decide(docId)
  }

  unwatch (docId) {
    this.watched.delete(docId)
    this.engine.chunks.cancel(docId)
    this.gc()
  }

  // ---- uploading --------------------------------------------------------------------

  async upload (filePath, { folderId = null, name = null } = {}) {
    const info = await this._read(filePath, name)
    const docId = await this.drive.create('file', info.name, { folderId })
    this._addVersion(docId, info)
    return docId
  }

  async uploadVersion (docId, filePath) {
    if (this.drive.describe(docId)?.kind !== 'file') throw new Error('That isn’t an uploaded file.')
    const access = this.engine.access(docId)
    if (!canEdit(access?.role)) throw new Error('Only people who can edit can upload a new version.')
    const info = await this._read(filePath, null)
    this._addVersion(docId, info)
    this.drive.rename(docId, info.name)
  }

  async _read (filePath, name) {
    const stat = await fs.promises.stat(filePath)
    if (!stat.isFile()) throw new Error('That isn’t a file.')
    const max = this.policy.get('maxFileBytes')
    if (stat.size > max) throw new Error(`That file is ${formatBytes(stat.size)}. Files can be up to ${formatBytes(max)} (your limit in Settings), since everyone who opens it keeps a copy.`)
    this._checkSpace(stat.size)
    const chunks = []
    const whole = crypto.createHash('sha256')
    const handle = await fs.promises.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(CHUNK_SIZE)
      for (let off = 0; off < stat.size; off += CHUNK_SIZE) {
        const { bytesRead } = await handle.read(buf, 0, Math.min(CHUNK_SIZE, stat.size - off), off)
        const piece = Buffer.from(buf.subarray(0, bytesRead))
        const hash = crypto.createHash('sha256').update(piece).digest('hex')
        whole.update(piece)
        this.blobs.write(hash, piece)
        chunks.push(hash)
      }
    } finally { await handle.close() }
    const clean = safeFileName(name || path.basename(filePath))
    let thumb = null
    if (fileKind(clean).kind === 'image' && this.makeThumb) { try { thumb = await this.makeThumb(filePath) } catch {} }
    return { name: clean, size: stat.size, sha256: whole.digest('hex'), chunks, thumb }
  }

  _addVersion (docId, info) {
    const doc = this.engine.getDoc(docId)
    const me = this.drive.identity
    const v = { id: crypto.randomBytes(6).toString('hex'), ...info, chunkSize: CHUNK_SIZE, by: me.userId, byName: me.name, at: Date.now() }
    doc.ydoc.transact(() => doc.ydoc.getArray(VERSIONS).push([v]), 'local')
    this.gc()
  }

  // ---- what to download ---------------------------------------------------------

  _versionsOf (docId) {
    const doc = this.engine.getDoc(docId)
    return doc ? doc.ydoc.getArray(VERSIONS).toArray().filter(validVersion) : []
  }

  _decide (docId) {
    const doc = this.engine.getDoc(docId)
    const v = doc && currentVersion(doc.ydoc)
    if (!v) return
    const missing = v.chunks.filter((h) => !this.blobs.has(h))
    if (!missing.length) { this.engine.chunks.cancel(docId); return }
    const why = this._holdReason(docId, v)
    if (why) { this.engine.chunks.cancel(docId); return }
    // Downloading by itself counts against today's budgets.
    if (this.state.approved[docId] !== v.id) this.policy.spendDownload(`${docId}:${v.id}`, this.ownerOf(docId) || v.by, v.size)
    this.engine.chunks.want(docId, missing)
  }

  // Why a file isn't downloading by itself, or null.
  _holdReason (docId, v) {
    const p = this.policy
    const owner = this.ownerOf(docId)
    if (this.state.removed[docId] === v.id) return 'removed'
    if (owner && p.isBlocked(owner)) return 'blocked'
    if (this.state.approved[docId] === v.id) return this._spaceProblem(v.size) ? 'space' : null
    if (v.size > p.get('maxFileBytes')) return 'limit'
    if (p.get('askRisky') && fileKind(v.name).risky) return 'risky'
    if (v.size > p.get('autoBytes')) return 'large'
    if (this._spaceProblem(v.size)) return 'space'
    if (!p.alreadyCounted(`${docId}:${v.id}`) && !p.fitsDownload(owner || v.by, v.size)) return 'budget'
    return null
  }

  // Says yes to downloading the current version of a file.
  approve (docId) {
    const v = this._current(docId)
    if (!v) return
    const owner = this.ownerOf(docId)
    if (owner && this.policy.isBlocked(owner)) throw new Error('You’ve blocked the person who shared this. Unblock them in Settings first.')
    this.state.approved[docId] = v.id
    delete this.state.removed[docId]
    this._save()
    this._decide(docId)
    this.drive._changed()
  }

  status (docId) {
    const v = this._current(docId)
    if (!v) return { ready: false, waiting: true }
    const have = v.chunks.filter((h) => this.blobs.has(h)).length
    const ready = have === v.chunks.length
    const hold = ready ? null : this._holdReason(docId, v)
    return {
      ready,
      name: safeFileName(v.name),
      size: v.size,
      ...fileKind(v.name),
      progress: v.chunks.length ? have / v.chunks.length : 1,
      downloading: !ready && !hold && this.engine.chunks.pending(docId) > 0,
      hold, // 'large' | 'risky' | 'space' | 'removed' | null
      by: v.by,
      byName: v.byName,
      at: v.at,
      versions: this._versionsOf(docId).length
    }
  }

  _progress (docId) {
    const now = Date.now()
    if (now - (this._lastProgress || 0) > 400 || this.status(docId).ready) { this._lastProgress = now; this.drive._changed() }
  }

  _current (docId) {
    const doc = this.engine.getDoc(docId)
    return doc ? currentVersion(doc.ydoc) : null
  }

  // ---- getting the file out ----------------------------------------------------

  // Writes the current version to `target`, checking every byte.
  async saveTo (docId, target) {
    const v = this._current(docId)
    if (!v) throw new Error('This file hasn’t arrived yet.')
    if (v.chunks.some((h) => !this.blobs.has(h))) throw new Error('This file isn’t on this computer yet.')
    const tmp = `${target}.${process.pid}.part`
    const out = await fs.promises.open(tmp, 'w')
    const whole = crypto.createHash('sha256')
    try {
      for (const h of v.chunks) { const data = this.blobs.read(h); whole.update(data); await out.write(data) }
    } finally { await out.close() }
    if (whole.digest('hex') !== v.sha256) { await fs.promises.rm(tmp, { force: true }); throw new Error('This file is damaged. Download it again.') }
    await fs.promises.rename(tmp, target)
    return target
  }

  // Bytes of a small file, for previews.
  read (docId, max = 25 * 1024 * 1024) {
    const v = this._current(docId)
    if (!v || v.size > max || v.chunks.some((h) => !this.blobs.has(h))) return null
    return Buffer.concat(v.chunks.map((h) => this.blobs.read(h)))
  }

  // Deletes this computer's copy of a file's contents (it can be downloaded
  // again from anyone who has it).
  removeCopy (docId) {
    delete this.state.approved[docId]
    this._save()
    const v = this._current(docId)
    if (v) this.state.removed[docId] = v.id // don't download it straight back
    const keep = this._referenced({ except: docId })
    for (const v of this._versionsOf(docId)) for (const h of v.chunks) if (!keep.has(h)) this.blobs.remove(h)
    this.engine.chunks.cancel(docId)
    this.drive._changed()
  }

  // Chunks still needed: every current version in the Drive.
  _referenced ({ except = null } = {}) {
    const keep = new Set()
    for (const docId of this.watched) {
      if (docId === except) continue
      const v = this._current(docId)
      if (v) for (const h of v.chunks) keep.add(h)
    }
    return keep
  }

  // Deletes chunks nothing in the Drive uses any more (old versions, removed files).
  gc () {
    const keep = this._referenced()
    let freed = 0
    for (const h of this.blobs.all()) {
      if (keep.has(h) || this.blobs.age(h) < 10 * 60e3) continue // recent: maybe an upload still being set up
      freed += this.blobs.size(h)
      this.blobs.remove(h)
    }
    return freed
  }

  // ---- space -----------------------------------------------------------------------

  freeBytes () {
    try { const s = fs.statfsSync(this.drive.dataDir); return s.bavail * s.bsize } catch { return Infinity }
  }

  _spaceProblem (bytes) {
    return this.freeBytes() - bytes < this.policy.get('keepFreeBytes')
  }

  _checkSpace (bytes) {
    if (this._spaceProblem(bytes)) throw new Error(`There isn’t enough free space. commonplace keeps at least ${formatBytes(this.policy.get('keepFreeBytes'))} free on your disk (a setting).`)
  }

  // What commonplace takes on this computer, file by file.
  usage () {
    const files = []
    let docs = 0
    for (const entry of this.drive.files.values()) {
      const docBytes = this.drive.store.sizeOf(entry.docId)
      docs += docBytes
      const v = entry.type === 'file' ? this._current(entry.docId) : null
      const local = v ? v.chunks.filter((h) => this.blobs.has(h)).reduce((n, h) => n + this.blobs.size(h), 0) : 0
      const owner = this.ownerOf(entry.docId) || entry.owner?.userId || null
      files.push({ docId: entry.docId, title: entry.title, type: entry.type, bytes: docBytes + local, contentBytes: local, mine: owner === this.drive.identity.userId, owner, ownerName: entry.owner?.name || null, held: Boolean(entry.held), heldReason: entry.heldReason || null })
    }
    // Who your space goes to: the people whose files take the most here.
    const people = new Map()
    for (const f of files) {
      if (f.mine || !f.owner) continue
      const p = people.get(f.owner) || { userId: f.owner, name: f.ownerName || 'Someone', bytes: 0, files: 0 }
      p.bytes += f.bytes
      p.files++
      people.set(f.owner, p)
    }
    return {
      docs,
      uploads: this.blobs.totalBytes(),
      free: this.freeBytes(),
      settings: this.settings,
      files: files.sort((a, b) => b.bytes - a.bytes),
      people: [...people.values()].sort((a, b) => b.bytes - a.bytes),
      blocked: this.policy.blocked
    }
  }

  _save () {
    try { fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2)) } catch {}
  }
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}
