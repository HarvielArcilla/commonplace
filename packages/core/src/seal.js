// Sealed boxes: encrypt something so that only the holder of one X25519
// private key can open it. Used to hand a document's new key to each
// remaining member when access changes.
//
//   sealed = ephemeralPublic(32) | AES-256-GCM(key = HKDF(ECDH(ephemeral, recipient)))

import crypto from 'node:crypto'
import { seal, open } from './crypto.js'

const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
const X25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b656e04220420', 'hex')

export function x25519PublicFromRaw (raw) {
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' })
}

export function x25519PrivateFromRaw (raw) {
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8_PREFIX, Buffer.from(raw)]), format: 'der', type: 'pkcs8' })
}

export function rawPublic (keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).subarray(-32)
}

export function rawPrivate (keyObject) {
  return keyObject.export({ type: 'pkcs8', format: 'der' }).subarray(-32)
}

export function newEncryptionKeyPair () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519')
  return { publicKey: rawPublic(publicKey), privateKey: rawPrivate(privateKey) }
}

function boxKey (shared, ephPub, recipientPub) {
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.concat([ephPub, recipientPub]), 'commonplace/v1/seal', 32))
}

export function sealTo (recipientPublicHex, plaintext) {
  const recipientPub = Buffer.from(recipientPublicHex, 'hex')
  const eph = crypto.generateKeyPairSync('x25519')
  const ephPub = rawPublic(eph.publicKey)
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: x25519PublicFromRaw(recipientPub) })
  return Buffer.concat([ephPub, seal(boxKey(shared, ephPub, recipientPub), plaintext)]).toString('base64')
}

export function openSealed (privateRaw, publicRaw, sealedB64) {
  try {
    const sealed = Buffer.from(sealedB64, 'base64')
    const ephPub = sealed.subarray(0, 32)
    const shared = crypto.diffieHellman({ privateKey: x25519PrivateFromRaw(privateRaw), publicKey: x25519PublicFromRaw(ephPub) })
    return open(boxKey(shared, ephPub, Buffer.from(publicRaw)), sealed.subarray(32))
  } catch {
    return null
  }
}
