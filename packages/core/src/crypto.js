// Key derivation and authenticated encryption for documents.
//
// Every document has one 32-byte secret. Everything else is derived from it:
//   docId  - public, stable identifier (safe to show, used to route frames)
//   topic  - the 32-byte Hyperswarm/DHT topic peers announce and look up
//   encKey - AES-256-GCM key for every byte that leaves this machine
//
// Knowing the docId or topic does not let anyone read or write the document.
// Only holders of the secret (i.e. people with the invite) can.

import crypto from 'node:crypto'

const NONCE_BYTES = 12
const TAG_BYTES = 16

function derive (label, secret, length = 32) {
  return crypto.createHash('sha256').update(`commonplace/v1/${label}`).update(secret).digest().subarray(0, length)
}

export function newDocSecret () {
  return crypto.randomBytes(32)
}

export function deriveDocKeys (secret) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) throw new Error('doc secret must be 32 bytes')
  return {
    docId: derive('doc-id', secret, 16).toString('hex'),
    topic: derive('topic', secret, 32),
    encKey: derive('enc', secret, 32)
  }
}

export function seal (encKey, plaintext) {
  const nonce = crypto.randomBytes(NONCE_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([nonce, body, cipher.getAuthTag()])
}

// Returns null instead of throwing when the ciphertext is invalid or was made
// with a different key, so callers can quietly drop junk from the network.
export function open (encKey, sealed) {
  if (!sealed || sealed.length < NONCE_BYTES + TAG_BYTES) return null
  try {
    const nonce = sealed.subarray(0, NONCE_BYTES)
    const tag = sealed.subarray(sealed.length - TAG_BYTES)
    const body = sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)
    const decipher = crypto.createDecipheriv('aes-256-gcm', encKey, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()])
  } catch {
    return null
  }
}
