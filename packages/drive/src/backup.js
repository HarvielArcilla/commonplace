// Recovery: a backup of your whole Drive (identity, folders and every file)
// in one file, locked with a recovery key.
//
// Without it, losing your only computer means losing your identity: you can
// no longer manage files you own, and files nobody else had are gone. With
// it, a new computer becomes you again: it gets your files as they were at
// the last backup, and anything newer arrives from your collaborators.
//
// The recovery key is made for you (25 characters, about 125 bits), not
// chosen, so it can't be guessed. You need both the file and the key, so the
// file can live somewhere ordinary (a USB stick, a cloud folder) while the
// key lives on paper or in a password manager. Once made, the backup is kept
// up to date once a day while commonplace runs. The key that locks it is kept
// on this computer next to your identity, which already lives there, so this
// adds nothing an intruder on this computer couldn't take anyway.
//
// File format: "commonplace-backup 1\n" + JSON header line (scrypt salt and
// parameters, nothing else) + AES-256-GCM sealed, gzipped JSON of the Drive.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { EventEmitter } from 'node:events'
import { seal, open, FileStore, bundleForNewComputer } from '@commonplace/core'
import { installStaged } from './move.js'

const MAGIC = 'commonplace-backup 1\n'
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ' // Crockford base32: no I, L, O, U
const KDF = { N: 1 << 15, r: 8, p: 1 }
const DAY = 24 * 3600e3
const SETTINGS = 'backup.json'

// ---- the recovery key -----------------------------------------------------------

export function newRecoveryKey () {
  const bytes = crypto.randomBytes(25)
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('')
  return chars.match(/.{5}/g).join('-')
}

// Forgiving about how it was typed: case, spaces, dashes, O for 0, I or L for 1.
export function normalizeRecoveryKey (text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return clean.length === 25 && [...clean].every((c) => ALPHABET.includes(c)) ? clean : null
}

function deriveKey (recoveryKey, salt, kdf = KDF) {
  const clean = normalizeRecoveryKey(recoveryKey)
  if (!clean) throw new Error('A recovery key is 25 letters and numbers, like ABCDE-12345-…')
  return crypto.scryptSync(clean, salt, 32, { ...kdf, maxmem: 256 * kdf.N * kdf.r })
}

// ---- writing and reading -------------------------------------------------------

// payload: what Drive.exportForMove returns.
export function writeBackupFile (file, payload, { key, salt, kdf = KDF }) {
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ ...payload, createdAt: Date.now() })))
  const header = JSON.stringify({ salt: salt.toString('hex'), kdf })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from(MAGIC + header + '\n'), seal(key, body)]), { mode: 0o600 })
  fs.renameSync(tmp, file) // never leave a half-written backup in place of a good one
}

export function readBackupFile (file, recoveryKey) {
  const raw = fs.readFileSync(file)
  const nl = raw.indexOf(10, MAGIC.length)
  if (raw.subarray(0, MAGIC.length).toString() !== MAGIC || nl < 0) throw new Error('That isn’t a commonplace backup.')
  const header = JSON.parse(raw.subarray(MAGIC.length, nl).toString())
  const kdf = { N: Number(header.kdf?.N), r: Number(header.kdf?.r), p: Number(header.kdf?.p) }
  if (!(kdf.N >= 1024 && kdf.N <= 1 << 20 && kdf.r >= 1 && kdf.r <= 32 && kdf.p >= 1 && kdf.p <= 16)) throw new Error('That backup is damaged.')
  const salt = Buffer.from(header.salt, 'hex')
  const key = deriveKey(recoveryKey, salt, kdf)
  const plain = open(key, raw.subarray(nl + 1))
  if (!plain) throw new Error('That recovery key doesn’t open this backup. Check it and try again.')
  const payload = JSON.parse(zlib.gunzipSync(plain).toString())
  if (!payload.identity?.userId || !payload.index || !Array.isArray(payload.docs)) throw new Error('That backup is incomplete.')
  return { payload, lock: { key, salt } }
}

// Makes this computer's (empty) data folder into the Drive from a backup.
// With protection on, the recovery key also puts this computer in the list.
export async function restoreBackup ({ payload, dataDir, beforeInstall, recoveryKey = null }) {
  const staging = path.join(dataDir, `.restoring-${Date.now()}`)
  try {
    const store = new FileStore(path.join(staging, 'files'))
    let count = 0
    for (const doc of payload.docs) {
      if (!/^[0-9a-f]{32}$/.test(doc.docId)) continue
      store.importDoc(doc.docId, doc.files)
      count++
    }
    const { bundle, device } = bundleForNewComputer(payload.identity, normalizeRecoveryKey(recoveryKey))
    await installStaged({ staging, dataDir, identity: bundle, index: payload.index, device, beforeInstall })
    return { count, userId: payload.identity.userId, createdAt: payload.createdAt }
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw err
  }
}

// ---- keeping one backup up to date --------------------------------------------

export class Backups extends EventEmitter {
  constructor ({ drive, dataDir }) {
    super()
    this.drive = drive
    this.file = path.join(dataDir, SETTINGS)
    this.settings = readJson(this.file)
    this.timer = setInterval(() => this.refreshIfDue(), 3600e3)
    this.timer.unref?.()
    setTimeout(() => this.refreshIfDue(), 60e3).unref?.()
  }

  status () {
    const s = this.settings
    return s ? { on: true, path: s.path, lastAt: s.lastAt || null, error: s.error || null } : { on: false }
  }

  // Starts backing up to `file` with a new recovery key, which is returned
  // once and never stored: only the key derived from it is.
  create (file) {
    const recoveryKey = newRecoveryKey()
    const salt = crypto.randomBytes(16)
    const key = deriveKey(recoveryKey, salt)
    writeBackupFile(file, this.drive.exportForMove(), { key, salt })
    this._save({ path: file, userId: this.drive.identity.userId, salt: salt.toString('hex'), key: key.toString('hex'), lastAt: Date.now(), error: null })
    return { recoveryKey, path: file }
  }

  // After restoring from a backup: keep that same file up to date, still
  // opened by the same recovery key.
  adopt (file, { key, salt }) {
    this._save({ path: file, userId: this.drive.identity.userId, salt: salt.toString('hex'), key: key.toString('hex'), lastAt: 0, error: null })
  }

  // Whether `recoveryKey` is the one this backup was made with.
  matches (recoveryKey) {
    const s = this.settings
    if (!s) return false
    try { return crypto.timingSafeEqual(deriveKey(recoveryKey, Buffer.from(s.salt, 'hex')), Buffer.from(s.key, 'hex')) } catch { return false }
  }

  // Writes the backup again now (same file, same recovery key).
  refresh () {
    const s = this.settings
    if (!s) return this.status()
    // Never write a different identity over someone's backup (say, after
    // this computer was signed out and started fresh).
    if (s.userId !== this.drive.identity.userId) { this.stop(); return this.status() }
    try {
      writeBackupFile(s.path, this.drive.exportForMove(), { key: Buffer.from(s.key, 'hex'), salt: Buffer.from(s.salt, 'hex') })
      this._save({ ...s, lastAt: Date.now(), error: null })
    } catch (err) {
      this._save({ ...s, error: `Couldn’t write the backup: ${err.message}` })
    }
    return this.status()
  }

  refreshIfDue () {
    if (this.settings && !(Date.now() - (this.settings.lastAt || 0) < DAY)) this.refresh()
  }

  // Stops keeping the backup. The file itself is left where it is.
  stop () {
    this.settings = null
    fs.rmSync(this.file, { force: true })
    this.emit('changed', this.status())
  }

  destroy () { clearInterval(this.timer) }

  _save (s) {
    this.settings = s
    fs.writeFileSync(this.file, JSON.stringify(s, null, 2), { mode: 0o600 })
    this.emit('changed', this.status())
  }
}

function readJson (file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}
