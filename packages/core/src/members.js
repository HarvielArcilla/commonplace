// Membership: who may read and edit a document, as an append-only log that
// only the current owner can sign.
//
// Every peer holds the same log and checks every entry, so a document's
// membership can't be forged by anyone but the owner. Entries:
//
//   create  - the document's first owner (and, for documents made before
//             membership existed, everyone already working on it)
//   add     - give someone a role; may carry the current key, sealed to them
//   role    - change someone's role (viewer, editor)
//   remove  - take someone out
//   rotate  - start a new key epoch; the new key is sealed to each remaining
//             member, and every invite link issued before it stops working
//   owner   - hand ownership to another member
//   revoke-invites - stop all invite links issued so far
//
// What this can and can't do: once someone is removed, honest peers stop
// sending them anything new and stop accepting their edits. Whatever they
// already had stays on their computer. That is the contract.

import crypto from 'node:crypto'
import { verifySignature } from './identity.js'
import { sealTo } from './seal.js'

export const ROLES = ['viewer', 'editor', 'owner']
export const canEdit = (role) => role === 'editor' || role === 'owner'

export function canonical (value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

const unsigned = (entry) => { const { sig, ...rest } = entry; return rest }
const hashOf = (entry) => crypto.createHash('sha256').update(canonical(entry)).digest('hex')
const signWith = (identity, body) => identity.sign(`commonplace/members/v1|${canonical(body)}`).toString('base64')
const verifyWith = (userId, body, sig) => verifySignature(userId, `commonplace/members/v1|${canonical(body)}`, Buffer.from(String(sig || ''), 'base64'))

function emptyState (docId) {
  return {
    docId,
    owner: null,
    owners: new Set(), // everyone who has ever been owner (their invites stay valid)
    members: new Map(), // userId -> { role, enc }
    removed: new Set(),
    epoch: 0,
    grants: new Map(), // userId -> Map(epoch -> sealed key)
    invitesValidFrom: 0,
    legacyLinks: true // pre-membership invite links (no signature) still work
  }
}

// Replays a log and returns the resulting state, or throws if any entry is invalid.
export function replay (docId, entries) {
  const s = emptyState(docId)
  let prevHash = null
  entries.forEach((entry, i) => {
    if (entry.seq !== i) throw new Error(`entry ${i}: wrong sequence number`)
    if ((entry.prev || null) !== prevHash) throw new Error(`entry ${i}: does not follow the previous entry`)
    if (entry.doc !== docId) throw new Error(`entry ${i}: belongs to another document`)
    const signer = i === 0 ? entry.owner : s.owner
    if (entry.by !== signer) throw new Error(`entry ${i}: not signed by the owner`)
    if (!verifyWith(entry.by, unsigned(entry), entry.sig)) throw new Error(`entry ${i}: bad signature`)
    apply(s, entry, i)
    prevHash = hashOf(entry)
  })
  s.head = { seq: entries.length - 1, hash: prevHash }
  return s
}

function grant (s, userId, epoch, sealed) {
  if (!sealed) return
  if (!s.grants.has(userId)) s.grants.set(userId, new Map())
  s.grants.get(userId).set(epoch, sealed)
}

function apply (s, e, i) {
  switch (e.type) {
    case 'create':
      if (i !== 0) throw new Error('create must come first')
      s.owner = e.owner
      s.owners.add(e.owner)
      for (const m of e.members || []) if (m.userId !== e.owner) s.members.set(m.userId, { role: m.role === 'viewer' ? 'viewer' : 'editor', enc: m.enc || null })
      s.members.set(e.owner, { role: 'owner', enc: e.ownerEnc || null })
      break
    case 'add':
      if (!['viewer', 'editor'].includes(e.role) && !(e.userId === s.owner && e.role === 'owner')) throw new Error('bad role')
      s.members.set(e.userId, { role: e.userId === s.owner ? 'owner' : e.role, enc: e.enc || s.members.get(e.userId)?.enc || null })
      s.removed.delete(e.userId)
      if (e.key) grant(s, e.userId, e.key.epoch, e.key.sealed)
      break
    case 'role':
      if (!s.members.has(e.userId) || e.userId === s.owner || !['viewer', 'editor'].includes(e.role)) throw new Error('bad role change')
      s.members.get(e.userId).role = e.role
      break
    case 'remove':
      if (e.userId === s.owner) throw new Error('the owner cannot be removed')
      s.members.delete(e.userId)
      s.removed.add(e.userId)
      break
    case 'rotate':
      if (e.epoch !== s.epoch + 1) throw new Error('epochs must increase by one')
      s.epoch = e.epoch
      for (const [userId, sealed] of Object.entries(e.keys || {})) grant(s, userId, e.epoch, sealed)
      s.invitesValidFrom = i + 1 // links made before this entry stop working
      s.legacyLinks = false
      break
    case 'owner':
      if (!s.members.has(e.userId) || e.userId === s.owner) throw new Error('new owner must be a member')
      s.members.get(s.owner).role = 'editor'
      s.owner = e.userId
      s.owners.add(e.userId)
      s.members.get(e.userId).role = 'owner'
      break
    case 'revoke-invites':
      s.invitesValidFrom = i + 1
      s.legacyLinks = false
      break
    default:
      throw new Error(`unknown entry type ${e.type}`)
  }
}

export class Membership {
  constructor (docId, entries = []) {
    this.docId = docId
    this.entries = []
    this.state = emptyState(docId)
    this.state.head = { seq: -1, hash: null }
    if (entries.length) this.merge(entries)
  }

  get exists () { return this.entries.length > 0 }
  get owner () { return this.state.owner }
  get epoch () { return this.state.epoch }
  get head () { return this.state.head }

  // Starts a log. `members` lets a document made before membership keep
  // everyone who was already working on it.
  static create (identity, docId, { members = [] } = {}) {
    const m = new Membership(docId)
    const body = { seq: 0, prev: null, doc: docId, type: 'create', by: identity.userId, owner: identity.userId, ownerEnc: identity.encPublic, at: Date.now(), members }
    m.entries = [{ ...body, sig: signWith(identity, body) }]
    m.state = replay(docId, m.entries)
    return m
  }

  // Adopts another copy of the log if it is valid and newer. Returns true if
  // anything changed. Only the owner writes, so copies normally just extend
  // each other; if the owner ever signed two different entries at the same
  // position, every peer keeps the branch with the smaller hash.
  merge (entries) {
    if (!Array.isArray(entries) || !entries.length) return false
    let next
    try { next = replay(this.docId, entries) } catch { return false }
    const mine = this.entries
    let i = 0
    while (i < mine.length && i < entries.length && hashOf(mine[i]) === hashOf(entries[i])) i++
    if (i === entries.length) return false // nothing new
    if (i < mine.length) {
      // A fork: keep the branch whose first differing entry hashes lower.
      if (hashOf(entries[i]) > hashOf(mine[i])) return false
    }
    this.entries = entries.map((e) => ({ ...e }))
    this.state = next
    return true
  }

  // Appends an entry signed by the current owner.
  append (identity, body) {
    if (identity.userId !== this.state.owner) throw new Error('Only the owner can change who has access.')
    const full = { ...body, seq: this.entries.length, prev: this.state.head.hash, doc: this.docId, by: identity.userId, at: Date.now() }
    const entry = { ...full, sig: signWith(identity, full) }
    const next = replay(this.docId, [...this.entries, entry])
    this.entries.push(entry)
    this.state = next
    return entry
  }

  member (userId) {
    return this.state.members.get(userId) || null
  }

  isRemoved (userId) {
    return this.state.removed.has(userId)
  }

  sealedKeyFor (userId, epoch) {
    return this.state.grants.get(userId)?.get(epoch) || null
  }

  // What a peer may do: { role, pending } or null for no access.
  // `invite` is the token they joined with, if any.
  roleOf (userId, invite) {
    if (!this.exists) return { role: 'editor', pending: false } // no membership yet: invite link = editor
    const m = this.member(userId)
    if (m) return { role: m.role, pending: false }
    if (this.isRemoved(userId) && !this.validInvite(invite)) return null
    if (this.validInvite(invite)) return { role: invite.r, pending: true }
    if (!invite && this.state.legacyLinks) return { role: 'editor', pending: true }
    return null
  }

  validInvite (token) {
    if (!token || typeof token !== 'object') return false
    const { sig, ...body } = token
    if (body.d !== this.docId || !['viewer', 'editor'].includes(body.r)) return false
    if (!this.state.owners.has(body.by)) return false
    if (!(body.q >= this.state.invitesValidFrom)) return false
    return verifyWith(body.by, body, sig)
  }

  createInvite (identity, role) {
    if (identity.userId !== this.state.owner) throw new Error('Only the owner can invite people.')
    const body = { d: this.docId, r: role === 'viewer' ? 'viewer' : 'editor', q: this.entries.length, i: crypto.randomBytes(6).toString('hex'), by: identity.userId }
    return { ...body, sig: signWith(identity, body) }
  }

  // ---- owner actions (each returns the entries appended) -----------------

  // Admits someone with a role, sealing the current key to them if needed.
  admit (identity, { userId, role, enc, epochSecret }) {
    const key = this.state.epoch > 0 && enc && epochSecret
      ? { epoch: this.state.epoch, sealed: sealTo(enc, epochSecret) }
      : undefined
    return [this.append(identity, { type: 'add', userId, role: userId === this.state.owner ? 'owner' : role, enc, key })]
  }

  setRole (identity, userId, role) {
    return [this.append(identity, { type: 'role', userId, role })]
  }

  // Removes someone and moves everyone else to a fresh key.
  remove (identity, userId, newEpochSecret) {
    const out = [this.append(identity, { type: 'remove', userId })]
    out.push(this.rotate(identity, newEpochSecret))
    return out
  }

  rotate (identity, newEpochSecret) {
    const keys = {}
    for (const [id, m] of this.state.members) if (m.enc) keys[id] = sealTo(m.enc, newEpochSecret)
    return this.append(identity, { type: 'rotate', epoch: this.state.epoch + 1, keys })
  }

  transfer (identity, userId) {
    return [this.append(identity, { type: 'owner', userId })]
  }

  revokeInvites (identity) {
    return [this.append(identity, { type: 'revoke-invites' })]
  }

  list () {
    return [...this.state.members].map(([userId, m]) => ({ userId, role: m.role }))
  }
}
