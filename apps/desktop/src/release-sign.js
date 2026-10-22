// Signed releases. Each release carries release.json (its version, the
// commit it was built from, and the SHA-256 of every installer) and
// release.json.sig, an Ed25519 signature over those exact bytes by the
// project's release key. The app verifies the signature against the public
// keys built into it (release-key.js) before offering or installing
// anything, so a compromised GitHub account alone can't push code to
// people's computers: it would also need the release key, which lives
// only with the maintainer and in CI's secrets.

import crypto from 'node:crypto'

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex') // Ed25519 public key, DER

export function newReleaseKey () {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(SPKI_PREFIX.length).toString('hex'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')
  }
}

// manifest: { version, commit, files: { name: sha256 } } -> { json, sig }
export function signManifest (manifest, privateKeyBase64) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyBase64, 'base64'), format: 'der', type: 'pkcs8' })
  const json = Buffer.from(JSON.stringify({ ...manifest, signedAt: Date.now() }, null, 2))
  return { json, sig: crypto.sign(null, json, key).toString('base64') }
}

// The manifest, if `sig` is a valid signature over `json` by one of
// `keys` (hex public keys); otherwise null.
export function verifyManifest (json, sig, keys) {
  const bytes = Buffer.isBuffer(json) ? json : Buffer.from(String(json))
  let signature
  try { signature = Buffer.from(String(sig).trim(), 'base64') } catch { return null }
  for (const hex of keys || []) {
    if (!/^[0-9a-f]{64}$/i.test(hex)) continue
    const key = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(hex, 'hex')]), format: 'der', type: 'spki' })
    let ok = false
    try { ok = crypto.verify(null, bytes, key, signature) } catch {}
    if (!ok) continue
    try {
      const m = JSON.parse(bytes.toString('utf8'))
      if (typeof m.version === 'string' && m.files && typeof m.files === 'object') return m
    } catch {}
  }
  return null
}

export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
