// This computer's safety limits: how much the people you share with can
// make it download and store, and who it ignores. Everything here is a
// setting (Settings → Limits and safety), kept in policy.json, because
// each computer protects itself: no server decides for it.
//
// The daily budgets are counted in ledger.json and start again each day.

import fs from 'node:fs'
import path from 'node:path'

const KB = 1024
const MB = 1024 * KB
const GB = 1024 * MB

// Never more than this, whatever the settings say (chunk lists, memory).
export const HARD_MAX_FILE_BYTES = 2 * GB

// kind: 'bytes' | 'count' | 'bool'. group orders the settings screen.
export const POLICY_FIELDS = {
  // Uploaded files from other people
  autoBytes: { group: 'files', kind: 'bytes', default: 10 * MB, min: 0, max: HARD_MAX_FILE_BYTES, label: 'Download others’ files by themselves up to', hint: '0 means always ask.' },
  maxFileBytes: { group: 'files', kind: 'bytes', default: 100 * MB, min: 1 * MB, max: HARD_MAX_FILE_BYTES, label: 'Largest file to accept or upload', hint: 'Bigger files wait, and say why.' },
  askRisky: { group: 'files', kind: 'bool', default: true, label: 'Always ask before downloading files that can run programs', hint: 'They are only ever saved, never opened from commonplace.' },
  personDailyBytes: { group: 'files', kind: 'bytes', default: 200 * MB, min: 0, max: 1024 * GB, label: 'Automatic downloads from one person, per day', hint: 'After that, their files wait for a yes until tomorrow.' },
  dailyBytes: { group: 'files', kind: 'bytes', default: 1 * GB, min: 0, max: 1024 * GB, label: 'Automatic downloads from everyone, per day' },
  // Shared folders
  folderFilesPerDay: { group: 'folders', kind: 'count', default: 25, min: 0, max: 1000, label: 'Files a shared folder can bring each day before asking', hint: 'More than that arrive paused, so a folder can’t flood your Drive.' },
  // Shared documents
  docGuardBytes: { group: 'docs', kind: 'bytes', default: 100 * MB, min: 100 * KB, max: 100 * GB, label: 'Pause a file someone else made when it passes' },
  ownDocGuardBytes: { group: 'docs', kind: 'bytes', default: 500 * MB, min: 100 * KB, max: 100 * GB, label: 'Pause your own file when others’ edits make it pass' },
  othersDocsBytes: { group: 'docs', kind: 'bytes', default: 5 * GB, min: 10 * MB, max: 10 * 1024 * GB, label: 'All files others made, together, up to' },
  keepFreeBytes: { group: 'docs', kind: 'bytes', default: 2 * GB, min: 100 * MB, max: 1024 * GB, label: 'Always leave this much free on the disk', hint: 'Nothing from others downloads or grows below it.' },
  // Forms
  answersPerPerson: { group: 'forms', kind: 'count', default: 20, min: 1, max: 100000, label: 'Answers one person can send to a form' },
  // Your Drive
  trashDays: { group: 'drive', kind: 'count', default: 30, min: 1, max: 3650, label: 'Delete files from the trash after this many days', hint: 'Until then they keep syncing, so they come back as they were.' },
  // Updates
  updateCheck: { group: 'app', kind: 'bool', default: true, label: 'Check GitHub for new versions', hint: 'Only asks GitHub which versions are out; nothing about you is sent.' },
  followMain: { group: 'app', kind: 'bool', default: false, label: 'Follow every change on main (installed from source)', hint: 'For testing the newest work: updates to each new commit instead of each signed release, without a signature check.' }
}

export const POLICY_GROUPS = { files: 'Files others share', folders: 'Shared folders', docs: 'Shared documents', forms: 'Forms', drive: 'Your Drive', app: 'Updates' }

export const DEFAULT_POLICY = Object.fromEntries(Object.entries(POLICY_FIELDS).map(([k, f]) => [k, f.default]))

// A policy with every value present and within its range.
export function normalizePolicy (p = {}) {
  const out = {}
  for (const [k, f] of Object.entries(POLICY_FIELDS)) {
    const v = p[k]
    if (f.kind === 'bool') out[k] = typeof v === 'boolean' ? v : f.default
    else {
      const n = Number(v)
      out[k] = Number.isFinite(n) ? Math.round(Math.max(f.min, Math.min(f.max, n))) : f.default
    }
  }
  return out
}

const today = () => new Date().toISOString().slice(0, 10)
const USER = /^[0-9a-f]{64}$/

export class Policy {
  // overrides: values that replace the defaults (tests, or a packaged build).
  constructor (dataDir, overrides = {}) {
    this.file = path.join(dataDir, 'policy.json')
    this.ledgerFile = path.join(dataDir, 'ledger.json')
    const saved = readJson(this.file)
    this.fresh = !saved.values // nothing saved yet on this computer
    this.defaults = normalizePolicy({ ...DEFAULT_POLICY, ...overrides })
    this.values = normalizePolicy({ ...this.defaults, ...(saved.values || {}) })
    this.blocked = Array.isArray(saved.blocked) ? saved.blocked.filter((b) => USER.test(b?.userId)) : []
    this.ledger = readJson(this.ledgerFile)
    this.listeners = new Set()
  }

  get (key) { return this.values[key] }
  all () { return { ...this.values } }

  set (patch) {
    this.values = normalizePolicy({ ...this.values, ...patch })
    this._save()
    return this.all()
  }

  reset () {
    this.values = { ...this.defaults }
    this._save()
    return this.all()
  }

  onChange (fn) { this.listeners.add(fn); return () => this.listeners.delete(fn) }

  // ---- people you've blocked ----------------------------------------------------

  isBlocked (userId) { return this.blocked.some((b) => b.userId === userId) }

  block ({ userId, name }) {
    if (!USER.test(userId) || this.isBlocked(userId)) return
    this.blocked.push({ userId, name: String(name || 'Someone').slice(0, 80), at: Date.now() })
    this._save()
  }

  unblock (userId) {
    this.blocked = this.blocked.filter((b) => b.userId !== userId)
    this._save()
  }

  // ---- daily budgets -------------------------------------------------------------

  _day () {
    if (this.ledger.day !== today()) this.ledger = { day: today(), bytes: {}, total: 0, joins: {}, counted: {} }
    return this.ledger
  }

  // Whether an automatic download of `bytes` from `userId` fits today's budgets.
  fitsDownload (userId, bytes) {
    const l = this._day()
    return (l.bytes[userId] || 0) + bytes <= this.values.personDailyBytes && l.total + bytes <= this.values.dailyBytes
  }

  // Counts a download once (key: the file and version).
  spendDownload (key, userId, bytes) {
    const l = this._day()
    if (l.counted[key]) return
    l.counted[key] = true
    l.bytes[userId] = (l.bytes[userId] || 0) + bytes
    l.total += bytes
    this._saveLedger()
  }

  alreadyCounted (key) { return Boolean(this._day().counted[key]) }

  // Files a shared folder has brought today; true while under the limit.
  allowJoin (folderId) {
    const l = this._day()
    const n = l.joins[folderId] || 0
    l.joins[folderId] = n + 1
    this._saveLedger()
    return n < this.values.folderFilesPerDay
  }

  _save () {
    writeJson(this.file, { values: this.values, blocked: this.blocked })
    for (const fn of this.listeners) { try { fn(this.all()) } catch {} }
  }

  _saveLedger () { writeJson(this.ledgerFile, this.ledger) }
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {} } catch { return {} }
}

function writeJson (file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value, null, 2)) } catch {}
}
