// Lightweight identity: a keypair generated on first launch.
// The public key is the user ID. There is no account and no server.
// Display name and color are self-chosen and not unique; the key is what
// distinguishes two people who both call themselves "Alex".

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']

function publicKeyHex (keyObject) {
  // Raw Ed25519 public key = last 32 bytes of the SPKI DER encoding.
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
}

export function loadOrCreateIdentity (dir) {
  const file = path.join(dir, 'identity.json')
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return new Identity(file, saved)
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const userId = publicKeyHex(publicKey)
  const saved = {
    version: 1,
    userId,
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    name: '',
    color: COLORS[parseInt(userId.slice(0, 2), 16) % COLORS.length],
    createdAt: Date.now()
  }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 })
  return new Identity(file, saved)
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

  // Signing is used for document ownership (phase 3: signed member lists).
  sign (data) {
    const key = crypto.createPrivateKey({ key: Buffer.from(this._saved.privateKey, 'base64'), format: 'der', type: 'pkcs8' })
    return crypto.sign(null, data, key)
  }

  update ({ name, color }) {
    if (typeof name === 'string') this._saved.name = name.trim().slice(0, 40)
    if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) this._saved.color = color
    fs.writeFileSync(this._file, JSON.stringify(this._saved, null, 2), { mode: 0o600 })
  }

  toPublic () {
    return { userId: this.userId, name: this.name, color: this.color, hasChosenName: this.hasChosenName }
  }
}

export function verifySignature (userId, data, signature) {
  const der = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(userId, 'hex')])
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' })
  return crypto.verify(null, data, key, signature)
}
