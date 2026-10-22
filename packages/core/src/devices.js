// Per-computer keys. A person is their account key (the user ID); each of
// their computers has a key of its own, and a signed list of statements
// says which computers are theirs. Once a person turns on protection (by
// setting up a recovery key), their computers sign with their own keys and
// no computer keeps the account key. Removing a lost computer then really
// cuts it off: everyone stops accepting what it signs, and the keys it held
// are replaced.
//
// The statements (a set, not a chain: they're merged by union, so it never
// matters in which order they arrive):
//
//   root     signed by the account key: starts generation `gen` with these
//            computers. A later generation (from the recovery key) replaces
//            everything before it.
//   add      a computer of the current generation adds another
//   revoke   a computer (or the account key) removes one. Removals are
//            permanent, and removing a computer also removes the ones it
//            added, unless another computer adds them again.
//   key      the person's encryption key number n (what owners seal file keys
//            to), its private half sealed to each computer allowed to have it.
//            The highest n from a computer still in the list wins.
//   protect  signed by the account key: computers no longer hold it, so
//            signatures straight from the account key prove nothing new.
//
// If a thief and the owner remove each other's computers, both removals
// stand: the recovery key (a new generation) is then the way back. That is
// the price of having no server to ask who was first.

import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { canonical } from './canonical.js'

export const DEVICE_SIG = 0xd1 // first byte of a signature made by a computer's key
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const HEX64 = /^[0-9a-f]{64}$/
const MAX_STATEMENTS = 400
const MAX_STATEMENT_BYTES = 16 * 1024
const TYPES = new Set(['root', 'add', 'revoke', 'key', 'protect'])

const text = (body) => `commonplace/users/v1|${canonical(body)}`
export const hashStatement = (s) => crypto.createHash('sha256').update(canonical(s)).digest('hex')

export function verifyRaw (publicHex, data, signature) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicHex, 'hex')]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(data), key, Buffer.from(signature))
  } catch {
    return false
  }
}

// Signs a statement with a raw Ed25519 signing function.
export function signStatement (sign, body) {
  return { ...body, sig: Buffer.from(sign(text(body))).toString('base64') }
}

// A signature by a computer's key carries the computer's ID with it.
export const deviceSignature = (deviceId, raw) => Buffer.concat([Buffer.from([DEVICE_SIG]), Buffer.from(deviceId, 'hex'), Buffer.from(raw)])

// The computer that made a signature, or null for one made by an account key.
export function signatureDevice (sig) {
  const b = Buffer.from(sig)
  return b.length === 97 && b[0] === DEVICE_SIG ? b.subarray(1, 33).toString('hex') : null
}

const validDevice = (d) => d && HEX64.test(d.id) && HEX64.test(d.enc)

function wellFormed (userId, s) {
  if (!s || typeof s !== 'object' || s.u !== userId || !TYPES.has(s.t) || typeof s.sig !== 'string') return false
  if (Buffer.byteLength(JSON.stringify(s)) > MAX_STATEMENT_BYTES) return false
  if (s.t !== 'protect' && !(Number.isInteger(s.gen) && s.gen >= 1)) return false
  if (s.t === 'root') return Array.isArray(s.devs) && s.devs.length <= 64 && s.devs.every(validDevice)
  if (s.t === 'add') return validDevice(s.dev) && (s.by === 'root' || HEX64.test(s.by))
  if (s.t === 'revoke') return HEX64.test(s.dev) && (s.by === 'root' || HEX64.test(s.by))
  if (s.t === 'key') return Number.isInteger(s.n) && s.n >= 1 && HEX64.test(s.pub) && HEX64.test(s.by) && s.grants && typeof s.grants === 'object'
  return true
}

const bodyOf = (s) => { const { sig, ...rest } = s; return rest }
const signedBy = (publicHex, s) => verifyRaw(publicHex, text(bodyOf(s)), Buffer.from(s.sig, 'base64'))

// What a person's statements add up to. null if there's no valid root
// (someone who has never turned any of this on).
export function userState (userId, statements = []) {
  const all = statements.filter((s) => wellFormed(userId, s))
  const byAccount = (s) => signedBy(userId, s)
  const roots = all.filter((s) => s.t === 'root' && byAccount(s))
  if (!roots.length) return null
  const gen = Math.max(...roots.map((r) => r.gen))
  const devices = new Map() // id -> { id, enc, name }
  const roster = new Set()
  for (const r of roots.filter((x) => x.gen === gen)) for (const d of r.devs) { roster.add(d.id); devices.set(d.id, { id: d.id, enc: d.enc, name: d.name || null }) }
  const ofGen = all.filter((s) => s.gen === gen)
  const okBy = (s) => (s.by === 'root' ? byAccount(s) : devices.has(s.by) && signedBy(s.by, s))

  // Every computer ever added in this generation (removals aside).
  const adds = ofGen.filter((s) => s.t === 'add')
  for (let grew = true; grew;) {
    grew = false
    for (const a of adds) {
      if (devices.has(a.dev.id) || !okBy(a)) continue
      devices.set(a.dev.id, { id: a.dev.id, enc: a.dev.enc, name: typeof a.dev.name === 'string' ? a.dev.name.slice(0, 60) : null })
      grew = true
    }
  }
  const revoked = new Set(ofGen.filter((s) => s.t === 'revoke' && okBy(s)).map((s) => s.dev))
  // Still in: from the root list, or added by a computer that's still in.
  const valid = new Set([...roster].filter((id) => !revoked.has(id)))
  for (const a of adds) if (a.by === 'root' && byAccount(a) && !revoked.has(a.dev.id)) valid.add(a.dev.id)
  for (let grew = true; grew;) {
    grew = false
    for (const a of adds) {
      if (valid.has(a.dev.id) || revoked.has(a.dev.id) || !valid.has(a.by) || !signedBy(a.by, a)) continue
      valid.add(a.dev.id)
      grew = true
    }
  }
  // The newest key (if two computers made one at once, the lower hash);
  // computers that join later get it through more statements for the same
  // key, whose grants add up.
  const keys = ofGen.filter((s) => s.t === 'key' && valid.has(s.by) && signedBy(s.by, s))
  let key = null
  for (const k of keys) if (!key || k.n > key.n || (k.n === key.n && hashStatement(k) < hashStatement(key))) key = k
  if (key) {
    const grants = {}
    for (const k of keys) if (k.n === key.n && k.pub === key.pub) Object.assign(grants, k.grants)
    key = { ...key, grants }
  }
  const enc = roots.find((r) => r.gen === gen && HEX64.test(r.enc || ''))?.enc || null
  return {
    userId,
    gen,
    devices,
    valid,
    revoked,
    key: key ? { n: key.n, pub: key.pub, grants: key.grants } : null,
    // The encryption key owners should seal to: the newest, else the one
    // the account had before any of this.
    enc: key?.pub || enc,
    protected: all.some((s) => s.t === 'protect' && byAccount(s))
  }
}

// Everything this computer knows about people's computers. Statements are
// public (anything secret in them is sealed), so they travel with hellos,
// membership logs and relay boxes, and anyone may pass them on.
export class Directory extends EventEmitter {
  constructor () {
    super()
    this.logs = new Map() // userId -> Map(hash -> statement)
    this.states = new Map()
  }

  statements (userId) {
    return [...(this.logs.get(userId)?.values() || [])]
  }

  // A short fingerprint of what I know about someone, so peers can tell
  // when to send me more.
  digest (userId) {
    const hashes = [...(this.logs.get(userId)?.keys() || [])].sort()
    return hashes.length ? crypto.createHash('sha256').update(hashes.join('')).digest('hex').slice(0, 32) : null
  }

  state (userId) {
    if (!this.states.has(userId)) this.states.set(userId, userState(userId, this.statements(userId)))
    return this.states.get(userId)
  }

  // Adds statements; true if anything new was learned. Statements that
  // can't belong to this person are dropped.
  merge (userId, statements) {
    if (!HEX64.test(String(userId)) || !Array.isArray(statements)) return false
    const log = this.logs.get(userId) || new Map()
    const before = new Set(log.keys())
    let added = false
    for (const s of statements.slice(0, MAX_STATEMENTS)) {
      if (log.size >= MAX_STATEMENTS || !wellFormed(userId, s)) continue
      const h = hashStatement(s)
      if (log.has(h)) continue
      log.set(h, { ...s })
      added = true
    }
    if (!added) return false
    this.logs.set(userId, log)
    this.states.delete(userId)
    // Keep only what the person's own keys signed: their account key, or
    // a computer their statements name. (So nobody can fill someone's list.)
    const st = this.state(userId)
    for (const [h, s] of log) {
      const byAccount = s.t === 'root' || s.t === 'protect' || s.by === 'root'
      const ok = byAccount ? signedBy(userId, s) : st?.devices.has(s.by) && signedBy(s.by, s)
      if (!ok) log.delete(h)
    }
    this.states.delete(userId)
    if (![...log.keys()].some((h) => !before.has(h))) return false
    this.emit('change', userId)
    return true
  }

  // { userId: statements } for everyone known (to save to disk).
  dump () {
    return Object.fromEntries([...this.logs.keys()].map((u) => [u, this.statements(u)]))
  }

  load (saved) {
    for (const [userId, statements] of Object.entries(saved || {})) this.merge(userId, statements)
  }
}

// One directory per process: what's in it is public and checks itself, so
// every Drive in the process can share it.
export const directory = new Directory()
directory.setMaxListeners(0)

// 'ok', 'revoked' (made by a computer since removed), or null (not valid).
// fresh: the signature is new (a hello), so a removed computer's is null,
// and so is one straight from the account key of someone protected.
export function signatureStatus (userId, data, sig, { fresh = false } = {}) {
  const b = Buffer.from(sig || '')
  const device = signatureDevice(b)
  if (!device) {
    if (!verifyRaw(userId, data, b)) return null
    return fresh && directory.state(userId)?.protected ? null : 'ok'
  }
  const st = directory.state(userId)
  if (!st?.devices.has(device) || !verifyRaw(device, data, b.subarray(33))) return null
  if (st.valid.has(device)) return 'ok'
  return fresh ? null : 'revoked'
}
