// Invite codes carry the document secret. Anyone holding one can read and edit.
//
//   commonplace://join/cp1.<base64url secret>
//
// The bare code (cp1....) is accepted too, so people can paste it anywhere.

const PREFIX = 'cp1.'
const SCHEME = 'commonplace://join/'

export function encodeInvite (secret) {
  return SCHEME + PREFIX + Buffer.from(secret).toString('base64url')
}

export function parseInvite (text) {
  if (typeof text !== 'string') return null
  const match = text.trim().match(/cp1\.([A-Za-z0-9_-]{43})/)
  if (!match) return null
  const secret = Buffer.from(match[1], 'base64url')
  return secret.length === 32 ? secret : null
}
