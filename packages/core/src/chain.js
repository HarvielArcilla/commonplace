// Signed chains: the shape every log of who-may-do-what shares (a file's
// membership, a cloud's roster). See docs/MODEL.md.
//
//   { seq, prev, doc, type, by, at, ...fields, sig }
//
// seq counts from 0, prev is the hash of the entry before, doc the
// document's ID, sig `by`'s signature over the rest (canonical JSON, with a
// prefix naming the kind of chain). Each kind says who may sign what
// (maySign) and what an entry does (apply); everything else is here:
// checking, appending, and merging copies.
//
// Copies merge by extension. If two entries were signed at the same seq (two
// computers at once), every peer keeps the branch whose first differing
// entry hashes lower; the entries a copy loses are left in `dropped` so
// their signer can make them again. An entry signed by a computer since
// removed (devices.js) stands only if a good entry follows it.

import crypto from 'node:crypto'
import { signatureStatus } from './devices.js'
import { canonical } from './canonical.js'

const unsigned = (entry) => { const { sig, ...rest } = entry; return rest }
export const hashOf = (entry) => crypto.createHash('sha256').update(canonical(entry)).digest('hex')

export class Chain {
  // kind: { prefix, empty(docId), maySign(state, entry, i), apply(state, entry, i) }
  constructor (kind, docId, entries = []) {
    this.kind = kind
    this.docId = docId
    this.entries = []
    this.state = { ...kind.empty(docId), head: { seq: -1, hash: null } }
    this.dropped = []
    if (entries.length) this.merge(entries)
  }

  get exists () { return this.entries.length > 0 }
  get head () { return this.state.head }

  // The state a list of entries adds up to; throws at the first bad one.
  static replay (kind, docId, entries) {
    const s = kind.empty(docId)
    let prevHash = null
    let lastGood = -1
    let lastRevoked = -1
    entries.forEach((entry, i) => {
      if (entry.seq !== i) throw new Error(`entry ${i}: wrong sequence number`)
      if ((entry.prev || null) !== prevHash) throw new Error(`entry ${i}: does not follow the previous entry`)
      if (entry.doc !== docId) throw new Error(`entry ${i}: belongs to another document`)
      if (!kind.maySign(s, entry, i)) throw new Error(`entry ${i}: not signed by someone who may`)
      const status = signatureStatus(entry.by, `${kind.prefix}|${canonical(unsigned(entry))}`, Buffer.from(String(entry.sig || ''), 'base64'))
      if (!status) throw new Error(`entry ${i}: bad signature`)
      if (status === 'revoked') lastRevoked = i
      else lastGood = i
      kind.apply(s, entry, i)
      prevHash = hashOf(entry)
    })
    if (lastRevoked > lastGood) throw new Error(`entry ${lastRevoked}: signed by a removed computer`)
    s.head = { seq: entries.length - 1, hash: prevHash }
    return s
  }

  // Signs a body as this kind of chain. (Also for things that aren't
  // entries but are signed the same way, like invite links.)
  sign (identity, body) {
    return identity.sign(`${this.kind.prefix}|${canonical(body)}`).toString('base64')
  }

  verify (userId, body, sig) {
    return signatureStatus(userId, `${this.kind.prefix}|${canonical(body)}`, Buffer.from(String(sig || ''), 'base64')) === 'ok'
  }

  // Starts the chain with its first entry.
  start (identity, body) {
    const full = { ...body, seq: 0, prev: null, doc: this.docId, by: identity.userId, at: Date.now() }
    this.entries = [{ ...full, sig: this.sign(identity, full) }]
    this.state = Chain.replay(this.kind, this.docId, this.entries)
    return this.entries[0]
  }

  // Appends an entry; throws if this identity may not sign it.
  append (identity, body) {
    const full = { ...body, seq: this.entries.length, prev: this.state.head.hash, doc: this.docId, by: identity.userId, at: Date.now() }
    const entry = { ...full, sig: this.sign(identity, full) }
    const next = Chain.replay(this.kind, this.docId, [...this.entries, entry])
    this.entries.push(entry)
    this.state = next
    return entry
  }

  // Adopts another copy if it is valid and newer. True if anything changed.
  merge (entries) {
    this.dropped = []
    if (!Array.isArray(entries) || !entries.length) return false
    let next
    try { next = Chain.replay(this.kind, this.docId, entries) } catch { return false }
    const mine = this.entries
    let i = 0
    while (i < mine.length && i < entries.length && hashOf(mine[i]) === hashOf(entries[i])) i++
    if (i === entries.length) return false // nothing new
    if (i < mine.length) {
      if (hashOf(entries[i]) > hashOf(mine[i])) return false // a fork, and mine wins
      this.dropped = mine.slice(i)
    }
    this.entries = entries.map((e) => ({ ...e }))
    this.state = next
    return true
  }

  // After learning that a computer was removed: drop what it signed at the
  // end of the chain that nobody built on. True if anything was dropped.
  revalidate () {
    try { this.state = Chain.replay(this.kind, this.docId, this.entries); return false } catch {}
    for (let n = this.entries.length - 1; n > 0; n--) {
      try {
        const state = Chain.replay(this.kind, this.docId, this.entries.slice(0, n))
        this.entries = this.entries.slice(0, n)
        this.state = state
        return true
      } catch {}
    }
    return false
  }

  // People whose signatures this chain carries, so their lists of
  // computers can travel with it.
  signers () {
    return [...new Set(this.entries.map((e) => e.by))]
  }
}
