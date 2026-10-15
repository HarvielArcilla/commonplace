// Conflict detection for edits made while people were apart.
//
// The CRDT already merges everything: two people who edit different
// paragraphs while offline get both edits, like a git merge with no
// conflicts. What it can't know is intent when both changed the *same*
// paragraph (it keeps both sets of characters, interleaved), or when one
// deleted a paragraph the other edited (the deletion wins). Those are the
// conflicts we surface, and the document's owner decides each one.
//
// Detection compares three versions, unit by unit (a unit is a paragraph,
// heading, list, table... or the title; the app says what its units are):
//
//   base    the last state both computers had in common
//   mine    my copy just before the other computer's changes arrived
//   theirs  base plus the other computer's changes
//
// A unit is a conflict when it changed on both sides and the results differ.

import crypto from 'node:crypto'
import * as Y from 'yjs'

const sig = (u) => (u ? u.sig : null)

// units(ydoc) -> Map(key -> { sig, text, prev, snapshot? }) supplied by the app.
export function findConflicts ({ base, mine, theirs, units }) {
  const b = units(base)
  const m = units(mine)
  const t = units(theirs)
  const keys = new Set([...b.keys(), ...m.keys(), ...t.keys()])
  const out = []
  for (const key of keys) {
    const bu = b.get(key)
    const mu = m.get(key)
    const tu = t.get(key)
    if (!bu) continue // added on one side only: nothing to decide
    const mineChanged = sig(mu) !== sig(bu)
    const theirsChanged = sig(tu) !== sig(bu)
    if (!mineChanged || !theirsChanged || sig(mu) === sig(tu)) continue
    out.push({ key, base: bu, mine: mu || null, theirs: tu || null })
  }
  return out
}

// Stable id for a conflict, the same on every computer that detects it.
export function conflictId (key, sigs) {
  return crypto.createHash('sha256').update(key).update('\0').update([...sigs].map((s) => s ?? '(deleted)').sort().join('\0')).digest('hex').slice(0, 24)
}

export function stateVectorMap (bytes) {
  try { return Y.decodeStateVector(bytes) } catch { return new Map() }
}

// True if `a` contains any change `b` doesn't have.
export function hasOpsBeyond (a, b) {
  for (const [client, clock] of a) if (clock > (b.get(client) || 0)) return true
  return false
}

export function sameState (a, b) {
  return !hasOpsBeyond(a, b) && !hasOpsBeyond(b, a)
}

export function docFrom (...updates) {
  const d = new Y.Doc({ gc: false })
  for (const u of updates) if (u && u.length) Y.applyUpdate(d, u)
  return d
}
