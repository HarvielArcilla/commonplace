// The two shapes of identifier used everywhere, checked one way.
//
//   hex64: a user ID (an Ed25519 public key), a computer's ID, an
//          encryption public key, a SHA-256 hash (chunk names)
//   docId: a document's public ID (16 bytes derived from its secret)
//
// No imports, so apps and the renderer can use it too.

export const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
export const isDocId = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/.test(v)
