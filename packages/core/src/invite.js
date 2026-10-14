// Invite links carry the document's root secret, and (once a document has an
// owner-signed membership) a signed token saying which role it grants.
//
//   commonplace://join/cp2.<base64url secret>.<base64url token>
//   commonplace://join/cp1.<base64url secret>      (older links, no role)
//
// The bare code is accepted too, so people can paste it anywhere.

const SCHEME = 'commonplace://join/'

export function encodeInvite (secret, token = null) {
  const s = Buffer.from(secret).toString('base64url')
  if (!token) return `${SCHEME}cp1.${s}`
  return `${SCHEME}cp2.${s}.${Buffer.from(JSON.stringify(token)).toString('base64url')}`
}

// Returns { secret, token } or null.
export function parseInvite (text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  let m = t.match(/cp2\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]+)/)
  if (m) {
    const secret = Buffer.from(m[1], 'base64url')
    let token = null
    try { token = JSON.parse(Buffer.from(m[2], 'base64url').toString('utf8')) } catch { return null }
    return secret.length === 32 && token && typeof token === 'object' ? { secret, token } : null
  }
  m = t.match(/cp1\.([A-Za-z0-9_-]{43})/)
  if (!m) return null
  const secret = Buffer.from(m[1], 'base64url')
  return secret.length === 32 ? { secret, token: null } : null
}
