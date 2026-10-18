// The always-on relay's wire format and keys, shared by the relay itself
// (packages/relay) and the computers that use one (relay-client.js).
//
// A relay is a dumb, blind mailbox store. Each mailbox ("box") is named by
// an Ed25519 public key derived from one key epoch of one file, so:
//   - only people holding that epoch's key can find the box or write to it
//     (every put is signed with the matching private key),
//   - what's inside is sealed with the file's key, so the relay can't read
//     it, and every blob is also signed by the person who wrote it, so the
//     relay can't forge edits,
//   - people removed from a file never learn the next epoch's box.
//
// Messages: u32 length | u32 headLength | JSON head | binary payload
//   client -> relay  { t: 'get', box, after }          stream blobs after seq, then keep sending new ones
//                     { t: 'put', box, sig, id }        payload = blob; sig = writer's signature
//                     { t: 'compact', box, upTo, sig }  payload replaces every blob up to seq upTo
//                     { t: 'drop', box, sig }           delete the box (an old epoch)
//   relay -> client  { t: 'blob', box, seq }           payload = blob
//                     { t: 'end', box, last, count }    caught up
//                     { t: 'ok', box, seq, id }  /  { t: 'error', box, id, reason }

import crypto from 'node:crypto'

const MAX_MESSAGE = 96 * 1024 * 1024
const ED25519_PKCS8_SEED = Buffer.from('302e020100300506032b657004220420', 'hex')
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const EMPTY = Buffer.alloc(0)

export const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex')

export function encodeMsg (head, payload = EMPTY) {
  const json = Buffer.from(JSON.stringify(head))
  const out = Buffer.alloc(8 + json.length + payload.length)
  out.writeUInt32BE(4 + json.length + payload.length, 0)
  out.writeUInt32BE(json.length, 4)
  json.copy(out, 8)
  Buffer.from(payload).copy(out, 8 + json.length)
  return out
}

// Collects chunks and calls onMessage(head, payload) for each whole message,
// concatenating only once a message has fully arrived.
export class MsgReader {
  constructor (onMessage) {
    this.onMessage = onMessage
    this.chunks = []
    this.size = 0
    this.need = null
  }

  push (chunk) {
    this.chunks.push(chunk)
    this.size += chunk.length
    for (;;) {
      if (this.need == null) {
        if (this.size < 4) return
        if (this.chunks[0].length < 4) this.chunks = [Buffer.concat(this.chunks)]
        const len = this.chunks[0].readUInt32BE(0)
        if (len < 4 || len > MAX_MESSAGE) throw new Error('invalid relay message')
        this.need = 4 + len
      }
      if (this.size < this.need) return
      const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
      const msg = buf.subarray(0, this.need)
      const rest = buf.subarray(this.need)
      this.chunks = rest.length ? [rest] : []
      this.size = rest.length
      this.need = null
      const jsonLen = msg.readUInt32BE(4)
      if (jsonLen > msg.length - 8) throw new Error('invalid relay message')
      this.onMessage(JSON.parse(msg.subarray(8, 8 + jsonLen).toString('utf8')), msg.subarray(8 + jsonLen))
    }
  }
}

// The box for one key epoch of a file: a key pair derived from its secret.
export function boxKeys (epochSecret) {
  const seed = crypto.createHash('sha256').update('commonplace/v1/relay-box').update(epochSecret).digest()
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_SEED, seed]), format: 'der', type: 'pkcs8' })
  const box = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex')
  return { box, sign: (text) => crypto.sign(null, Buffer.from(text), privateKey).toString('base64') }
}

export function verifyBox (box, text, sig) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(box, 'hex')]), format: 'der', type: 'spki' })
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(String(sig || ''), 'base64'))
  } catch {
    return false
  }
}

// What each signature covers.
export const putProof = (box, payload) => `commonplace/relay/v1/put|${box}|${sha256hex(payload)}`
export const compactProof = (box, upTo, payload) => `commonplace/relay/v1/compact|${box}|${upTo}|${sha256hex(payload)}`
export const dropProof = (box) => `commonplace/relay/v1/drop|${box}`

// Relay addresses are the relay's public key: cpr1.<base64url>. Addresses
// from when relays were called helpers (cph1.) still work.
const PREFIX = 'cpr1.'
export const formatRelayAddress = (keyHex) => PREFIX + Buffer.from(keyHex, 'hex').toString('base64url')
export function parseRelayAddress (text) {
  const m = String(text || '').trim().match(/cp[hr]1\.([A-Za-z0-9_-]{43})/)
  if (m) return Buffer.from(m[1], 'base64url').toString('hex')
  return /^[0-9a-f]{64}$/i.test(String(text || '').trim()) ? String(text).trim().toLowerCase() : null
}
