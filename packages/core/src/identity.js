// Who you are, on this computer.
//
// You are your account key: its Ed25519 public key is your user ID, and an
// X25519 key (your encryption key, number 0) lets owners send you a file's
// key privately. There is no account and no server. Display name and color
// are self-chosen and not unique; the key is what tells two Alexes apart.
//
// Each computer also has a key of its own (`device`). Until you turn on
// protection, every computer of yours keeps the account key and signs with
// it, as commonplace always has. Protection (set up with your recovery key)
// seals the account key with the recovery key and deletes it from every
// computer; from then on each computer signs with its own key, vouched for
// by your signed list of computers (devices.js), so a lost one can be cut
// off for real. Your encryption key is replaced whenever a computer is
// removed (numbers 1, 2, ...), handed to the computers still in the list.
//
// Your computers share one Drive index, synced like a document whose key
// only they hold: derived from the account key at first, and from your
// newest encryption key once protection replaces it.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { newEncryptionKeyPair, openSealed, sealTo } from './seal.js'
import { seal, open } from './crypto.js'
import { directory, signatureStatus, signStatement, deviceSignature } from './devices.js'

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']
const KDF = { N: 1 << 15, r: 8, p: 1 }

function publicKeyHex (keyObject) {
  // Raw Ed25519 public key = last 32 bytes of the SPKI DER encoding.
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
}

function newSigningKey () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return { id: publicKeyHex(publicKey), privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64') }
}

// A computer's own keys: one to sign with, one to receive sealed keys.
export function newDeviceKeys () {
  const { id, privateKey } = newSigningKey()
  const enc = newEncryptionKeyPair()
  return { id, privateKey, encPublic: enc.publicKey.toString('hex'), encPrivate: enc.privateKey.toString('base64') }
}

const signRaw = (privateKeyB64, data) => crypto.sign(null, Buffer.from(data), crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' }))
const indexSecretFrom = (secretB64, n = 0) => crypto.createHash('sha256').update(n ? `commonplace/v1/drive-index/${n}` : 'commonplace/v1/drive-index').update(Buffer.from(secretB64, 'base64')).digest()

function newIdentityRecord () {
  const { id: userId, privateKey } = newSigningKey()
  const enc = newEncryptionKeyPair()
  return {
    version: 3,
    userId,
    privateKey,
    encPublic: enc.publicKey.toString('hex'),
    encPrivate: enc.privateKey.toString('base64'),
    device: newDeviceKeys(),
    userKeys: {},
    name: '',
    color: COLORS[parseInt(userId.slice(0, 2), 16) % COLORS.length],
    createdAt: Date.now()
  }
}

// Older identity files: add what they lack.
function upgrade (saved) {
  let changed = false
  if (!saved.encPublic) {
    const enc = newEncryptionKeyPair()
    saved.encPublic = enc.publicKey.toString('hex')
    saved.encPrivate = enc.privateKey.toString('base64')
    changed = true
  }
  if (!saved.device) { saved.device = newDeviceKeys(); changed = true }
  if (!saved.userKeys) { saved.userKeys = {}; changed = true }
  if (saved.version !== 3) { saved.version = 3; changed = true }
  return changed
}

const write = (file, saved) => fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })

export function loadOrCreateIdentity (dir) {
  const file = path.join(dir, 'identity.json')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (upgrade(saved)) write(file, saved)
    return new Identity(file, saved)
  }
  const saved = newIdentityRecord()
  write(file, saved)
  return new Identity(file, saved)
}

// Replaces the identity on this computer with one brought from another
// computer or a backup (Identity.exportBundle), with this computer's own
// keys (made fresh unless given).
export function installIdentity (dir, bundle, device = null) {
  if (!bundle?.userId || !bundle.encPrivate || !(bundle.privateKey || bundle.indexSecret)) throw new Error('That identity is incomplete.')
  fs.mkdirSync(dir, { recursive: true })
  const { statements, ...rest } = bundle
  if (Array.isArray(statements)) directory.merge(bundle.userId, statements)
  write(path.join(dir, 'identity.json'), { ...rest, version: 3, device: device || newDeviceKeys(), userKeys: rest.userKeys || {} })
}

// The key that seals the account key, from the recovery key.
function recoveryLock (recoveryKey, salt) {
  return crypto.scryptSync(`commonplace/v1/account|${recoveryKey}`, salt, 32, { ...KDF, maxmem: 256 * KDF.N * KDF.r })
}

function unsealWith (recoveryKey, sealed) {
  const raw = sealed && open(recoveryLock(recoveryKey, Buffer.from(sealed.salt, 'hex')), Buffer.from(sealed.box, 'base64'))
  if (!raw) throw new Error('That recovery key doesn’t match.')
  return raw.toString('base64')
}

// A protected identity brought to a new computer from a backup: the
// recovery key unseals the account key just long enough to add this
// computer to the list. Returns the bundle and this computer's keys, for
// installIdentity.
export function bundleForNewComputer (bundle, recoveryKey) {
  if (bundle.privateKey || !bundle.accountSealed) return { bundle, device: newDeviceKeys() }
  const accountKey = unsealWith(recoveryKey, bundle.accountSealed)
  const device = newDeviceKeys()
  directory.merge(bundle.userId, bundle.statements || [])
  const gen = directory.state(bundle.userId)?.gen || 1
  const add = signStatement((text) => signRaw(accountKey, text), { t: 'add', u: bundle.userId, gen, dev: { id: device.id, enc: device.encPublic, name: 'Restored from a backup' }, by: 'root', at: Date.now() })
  return { bundle: { ...bundle, statements: [...(bundle.statements || []), add] }, device }
}

export class Identity {
  constructor (file, saved) {
    this._file = file
    this._saved = saved
  }

  get userId () { return this._saved.userId }
  get name () { return this._saved.name || `Guest ${this._saved.userId.slice(0, 4)}` }
  get color () { return this._saved.color }
  get hasChosenName () { return Boolean(this._saved.name) }
  get deviceId () { return this._saved.device.id }
  get deviceEnc () { return this._saved.device.encPublic }
  // Whether this computer still holds the account key.
  get hasAccountKey () { return Boolean(this._saved.privateKey) }
  get isProtected () { return Boolean(this._saved.accountSealed) || Boolean(directory.state(this.userId)?.protected) }
  get accountSealed () { return this._saved.accountSealed || null }

  // My newest encryption key: what owners should seal file keys to.
  get encKeyNumber () { return Math.max(0, ...Object.keys(this._saved.userKeys).map(Number)) }
  get encPublic () {
    const n = this.encKeyNumber
    return n ? this._saved.userKeys[n].pub : this._saved.encPublic
  }

  // With the account key while this computer has it, else with its own.
  sign (data) {
    if (this._saved.privateKey) return signRaw(this._saved.privateKey, data)
    return deviceSignature(this.deviceId, signRaw(this._saved.device.privateKey, data))
  }

  // The key for this person's Drive index, the same on each of their
  // computers: from the newest encryption key once there is one.
  driveSecret (n = this.encKeyNumber) {
    if (n) return indexSecretFrom(this._saved.userKeys[n].priv, n)
    if (this._saved.indexSecret) return Buffer.from(this._saved.indexSecret, 'base64')
    return indexSecretFrom(this._saved.privateKey)
  }

  // Opens something sealed to any of my encryption keys, newest first.
  openSealed (sealedB64) {
    const keys = Object.entries(this._saved.userKeys).sort((a, b) => b[0] - a[0]).map(([, k]) => [k.priv, k.pub])
    keys.push([this._saved.encPrivate, this._saved.encPublic])
    for (const [priv, pub] of keys) {
      const out = openSealed(Buffer.from(priv, 'base64'), Buffer.from(pub, 'hex'), sealedB64)
      if (out) return out
    }
    return null
  }

  update ({ name, color }) {
    if (typeof name === 'string') this._saved.name = name.trim().slice(0, 40)
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) this._saved.color = color
    this._save()
  }

  // ---- my list of computers ----------------------------------------------------

  // Signs a statement about my computers, as this computer.
  statement (body) {
    return signStatement((text) => signRaw(this._saved.device.privateKey, text), { ...body, u: this.userId, by: this.deviceId, at: Date.now() })
  }

  // Signs a statement with the account key (this computer's, or one
  // unsealed with the recovery key).
  accountStatement (body, accountKey = this._saved.privateKey) {
    if (!accountKey) throw new Error('This needs your recovery key.')
    return signStatement((text) => signRaw(accountKey, text), { ...body, u: this.userId, at: Date.now() })
  }

  get myDevice () { return { id: this.deviceId, enc: this.deviceEnc } }

  // Takes up what my list of computers now says: keys handed to this
  // computer, and protection (then this computer stops keeping the account
  // key). Returns { removed, newKey } so the Drive can act.
  adoptState () {
    let st = directory.state(this.userId)
    if (!st) return { removed: false, newKey: false }
    // A computer of mine from before protection was turned on: it still
    // holds the account key, which can list it, so it lists itself.
    if (st.protected && this._saved.privateKey && !st.valid.has(this.deviceId) && !st.revoked.has(this.deviceId)) {
      directory.merge(this.userId, [this.accountStatement({ t: 'add', gen: st.gen, dev: this.myDevice, by: 'root' })])
      st = directory.state(this.userId)
    }
    let newKey = false
    if (st.key && !this._saved.userKeys[st.key.n] && st.key.grants[this.deviceId]) {
      const priv = openSealed(Buffer.from(this._saved.device.encPrivate, 'base64'), Buffer.from(this.deviceEnc, 'hex'), st.key.grants[this.deviceId])
      if (priv?.length === 32) {
        this._saved.userKeys[st.key.n] = { pub: st.key.pub, priv: priv.toString('base64') }
        newKey = true
      }
    }
    if (st.protected && this._saved.privateKey && st.valid.has(this.deviceId)) {
      this._saved.indexSecret = this.driveSecret(0).toString('base64')
      delete this._saved.privateKey
      newKey = true // (the Drive re-reads everything either way)
    }
    if (newKey) this._save()
    return { removed: st.revoked.has(this.deviceId), newKey, valid: st.valid.has(this.deviceId) }
  }

  // Turns on protection: lists `devices` (my computers that have keys) as
  // generation 1, seals the account key with the recovery key and deletes
  // it here. Returns the statements to publish.
  protect (recoveryKey, devices = [this.myDevice]) {
    if (!this._saved.privateKey) throw new Error('Protection is already on.')
    const salt = crypto.randomBytes(16)
    const box = seal(recoveryLock(recoveryKey, salt), Buffer.from(this._saved.privateKey, 'base64'))
    const list = [...new Map([this.myDevice, ...devices].map((d) => [d.id, d])).values()]
    const statements = [
      this.accountStatement({ t: 'root', gen: 1, devs: list, enc: this._saved.encPublic }),
      this.accountStatement({ t: 'protect' })
    ]
    directory.merge(this.userId, statements)
    this._saved.accountSealed = { salt: salt.toString('hex'), box: box.toString('base64') }
    this.adoptState()
    this._save()
    return statements
  }

  // The account key, from the recovery key; it isn't kept.
  unsealAccount (recoveryKey, sealed = this._saved.accountSealed) {
    if (!sealed) throw new Error('Protection isn’t on.')
    return unsealWith(recoveryKey, sealed)
  }

  // Keeps the sealed account key (from my Drive index) on this computer too.
  rememberSealedAccount (sealed) {
    if (!sealed?.salt || !sealed?.box || this._saved.accountSealed) return
    this._saved.accountSealed = { salt: String(sealed.salt), box: String(sealed.box) }
    this._save()
  }

  // Removes one of my computers (and with it any it added that I don't add
  // again), and replaces my encryption key for the computers still in. Run
  // on one of those, or with the account key from the recovery key.
  removeDevice (deviceId, { keep = [], accountKey = null } = {}) {
    const st = directory.state(this.userId)
    if (!st) throw new Error('Turn on protection first.')
    const out = [accountKey ? this.accountStatement({ t: 'revoke', gen: st.gen, dev: deviceId, by: 'root' }, accountKey) : this.statement({ t: 'revoke', gen: st.gen, dev: deviceId })]
    for (const id of keep) {
      const d = st.devices.get(id)
      if (d && id !== deviceId) out.push(accountKey ? this.accountStatement({ t: 'add', gen: st.gen, dev: d, by: 'root' }, accountKey) : this.statement({ t: 'add', gen: st.gen, dev: d }))
    }
    directory.merge(this.userId, out)
    out.push(...this.newEncryptionKey())
    return out
  }

  // A new encryption key for every computer still in my list.
  newEncryptionKey () {
    const st = directory.state(this.userId)
    if (!st?.valid.has(this.deviceId)) throw new Error('This computer was removed from your account.')
    const n = Math.max(this.encKeyNumber, st.key?.n || 0) + 1
    const pair = newEncryptionKeyPair()
    const grants = {}
    for (const id of st.valid) grants[id] = sealTo(st.devices.get(id).enc, pair.privateKey)
    const statement = this.statement({ t: 'key', gen: st.gen, n, pub: pair.publicKey.toString('hex'), grants })
    directory.merge(this.userId, [statement])
    this.adoptState()
    return [statement]
  }

  // Hands my current encryption key to computers of mine in the list that
  // don't have it yet (one restored from a backup, say). Returns the new
  // statement, or null if none was needed.
  shareEncryptionKey () {
    const st = directory.state(this.userId)
    const mine = st?.key && this._saved.userKeys[st.key.n]
    if (!mine || !st.valid.has(this.deviceId)) return null
    const missing = [...st.valid].filter((id) => !st.key.grants[id])
    if (!missing.length) return null
    const grants = {}
    for (const id of missing) grants[id] = sealTo(st.devices.get(id).enc, Buffer.from(mine.priv, 'base64'))
    const k = this.statement({ t: 'key', gen: st.gen, n: st.key.n, pub: st.key.pub, grants })
    directory.merge(this.userId, [k])
    return k
  }

  // Lets a new computer of mine in (linking, or moving there).
  addDevice (device, { accountKey = null } = {}) {
    const st = directory.state(this.userId)
    if (!st) return []
    const dev = { id: device.id, enc: device.enc, name: device.name || undefined }
    const s = accountKey ? this.accountStatement({ t: 'add', gen: st.gen, dev, by: 'root' }, accountKey) : this.statement({ t: 'add', gen: st.gen, dev })
    directory.merge(this.userId, [s])
    const k = this.shareEncryptionKey() // hand it the current encryption key too
    return k ? [s, k] : [s]
  }

  // Starts over with the recovery key, when every computer of mine has been
  // removed: a new generation listing only this computer.
  resetWithRecovery (recoveryKey) {
    const accountKey = this.unsealAccount(recoveryKey)
    const gen = (directory.state(this.userId)?.gen || 0) + 1
    const statements = [this.accountStatement({ t: 'root', gen, devs: [this.myDevice], enc: this._saved.encPublic }, accountKey)]
    directory.merge(this.userId, statements)
    statements.push(...this.newEncryptionKey())
    return statements
  }

  // ---- carrying it to another computer ----------------------------------------

  // Everything another computer of mine needs, except its own keys. Once
  // protection is on, the account key stays out (only its sealed copy goes).
  exportBundle ({ withAccountKey = true } = {}) {
    const { device, privateKey, ...rest } = this._saved
    return {
      ...rest,
      ...(withAccountKey && privateKey ? { privateKey } : {}),
      indexSecret: rest.indexSecret || (privateKey ? indexSecretFrom(privateKey).toString('base64') : undefined),
      statements: directory.statements(this.userId)
    }
  }

  toPublic () {
    return { userId: this.userId, name: this.name, color: this.color, hasChosenName: this.hasChosenName }
  }

  _save () { write(this._file, this._saved) }
}

// Whether `signature` is a valid signature by this person: by their account
// key, or by one of their computers that hasn't been removed. fresh: it's
// a new proof (a hello), so only what the person's computers sign today
// counts (see devices.js).
export function verifySignature (userId, data, signature, { fresh = false } = {}) {
  return signatureStatus(userId, data, signature, { fresh }) === 'ok'
}
