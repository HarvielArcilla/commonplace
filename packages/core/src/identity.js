// Lightweight identity: keypairs generated on first launch.
// The Ed25519 public key is the user ID; it signs membership changes and
// proves who is on the other end of a connection. A separate X25519 key lets
// owners send this person a document's key privately.
// There is no account and no server. Display name and color are self-chosen
// and not unique; the key is what distinguishes two people both called "Alex".
//
// The same identity can live on several of your computers ("Link another
// computer" copies it). They share one Drive index, synced like a document
// whose key only holders of this identity can derive (driveSecret).

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { newEncryptionKeyPair, openSealed } from './seal.js'

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function publicKeyHex (keyObject) {
  // Raw Ed25519 public key = last 32 bytes of the SPKI DER encoding.
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
}

function newIdentityRecord () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const userId = publicKeyHex(publicKey)
  const enc = newEncryptionKeyPair()
  return {
    version: 2,
    userId,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    encPublic: enc.publicKey.toString('hex'),
    encPrivate: enc.privateKey.toString('base64'),
    name: '',
    color: COLORS[parseInt(userId.slice(0, 2), 16) % COLORS.length],
    createdAt: Date.now()
  }
}

export function loadOrCreateIdentity (dir) {
  const file = path.join(dir, 'identity.json')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!saved.encPublic) {
      // Identities from before membership: add an encryption key.
      const enc = newEncryptionKeyPair()
      saved.encPublic = enc.publicKey.toString('hex')
      saved.encPrivate = enc.privateKey.toString('base64')
      saved.version = 2
      fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })
    }
    return new Identity(file, saved)
  }
  const saved = newIdentityRecord()
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })
  return new Identity(file, saved)
}

// Replaces the identity on this computer with one moved from another computer.
export function installIdentity (dir, bundle) {
  if (!bundle?.userId || !bundle.privateKey || !bundle.encPrivate) throw new Error('That identity is incomplete.')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'identity.json'), JSON.stringify({ ...bundle, version: 2 }, null, 2), { mode: 0o600 })
}

export class Identity {
  constructor (file, saved) {
    this._file = file
    this._saved = saved
  }

  get userId () { return this._saved.userId }
  get encPublic () { return this._saved.encPublic }
  get name () { return this._saved.name || `Guest ${this._saved.userId.slice(0, 4)}` }
  get color () { return this._saved.color }
  get hasChosenName () { return Boolean(this._saved.name) }

  sign (data) {
    const key = crypto.createPrivateKey({ key: Buffer.from(this._saved.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    return crypto.sign(null, Buffer.from(data), key)
  }

  // The key for this person's Drive index, the same on each of their computers.
  driveSecret () {
    return crypto.createHash('sha256').update('commonplace/v1/drive-index').update(Buffer.from(this._saved.privateKey, 'base64')).digest()
  }

  // Opens something sealed to this person's encryption key.
  openSealed (sealedB64) {
    return openSealed(Buffer.from(this._saved.encPrivate, 'base64'), Buffer.from(this._saved.encPublic, 'hex'), sealedB64)
  }

  update ({ name, color }) {
    if (typeof name === 'string') this._saved.name = name.trim().slice(0, 40)
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) this._saved.color = color
    fs.writeFileSync(this._file, JSON.stringify(this._saved, null, 2), { mode: 0o600 })
  }

  exportBundle () {
    return { ...this._saved }
  }

  toPublic () {
    return { userId: this.userId, name: this.name, color: this.color, hasChosenName: this.hasChosenName }
  }
}

export function verifySignature (userId, data, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(userId, 'hex')]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature))
  } catch {
    return false
  }
}
