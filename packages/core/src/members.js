// Membership: who may read and edit a document, as an append-only log that
// only the current owner can sign.
//
// Every peer holds the same log and checks every entry, so a document's
// membership can't be forged by anyone but the owner. Entries:
//
//   create  - the document's first owner (and, for documents made before
//             membership existed, everyone already working on it)
//   add     - give someone a role; may carry the current key, sealed to them,
//             the shared folder that gave it (folder), and when their access
//             ends (until) and what happens to their copy then (after)
//   role    - change someone's role (viewer, respondent, editor)
//   access  - change when someone's access ends, and what happens then
//   remove  - take someone out (after: what happens to their copy)
//   rotate  - start a new key epoch; the new key is sealed to each remaining
//             member, and every invite link issued before it stops working
//   owner   - hand ownership to another member
//   revoke-invites - stop all invite links issued so far
//   retire-legacy  - stop accepting unsigned links from before roles existed
//
// Invite links carry an owner-signed token: the role, and optionally an
// expiry (x), single use (once: the first person admitted with it uses it
// up) and approval (ask: the owner must say yes to each person). People
// holding a single-use or approval link get nothing until the owner has
// admitted them, so those links only work while the owner is online.
//
// Access that ends: a member's `until` (ms) is signed in the log like
// everything else. From then on every honest computer treats them as having
// no access, by its own clock, and the owner's computer removes them and
// moves everyone else to a new key as soon as it runs. `after` says what
// their own computer does with its copy then: 'keep' it (read-only, the
// default) or 'hide' it (delete it).
//
// What this can and can't do: once someone's access ends, honest peers stop
// sending them anything new and stop accepting their edits. A copy they
// already have can be deleted by commonplace ('hide'), but nothing can stop
// someone who saved it some other way. That is the contract.

import crypto from 'node:crypto'
import { verifySignature } from './identity.js'
import { sealTo } from './seal.js'

export const ROLES = ['viewer', 'commenter', 'respondent', 'editor', 'owner']
// Roles the owner can give someone. A respondent reads the file and may add
// only their own sealed answers to a form (see respond.js).
export const GIVEN_ROLES = ['viewer', 'commenter', 'respondent', 'editor']
export const canEdit = (role) => role === 'editor' || role === 'owner'
export const canRespond = (role) => role === 'respondent'
export const canComment = (role) => role === 'commenter'
// A role a newer app gave (one this app doesn't know) counts as view-only
// here: they still get the file's key, and nothing they send is taken.
const roleHere = (role) => (GIVEN_ROLES.includes(role) ? role : 'viewer')
const isRole = (role) => typeof role === 'string' && /^[a-z-]{1,24}$/.test(role)
export const AFTER = ['keep', 'hide']
const cleanUntil = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : null)
const cleanAfter = (v) => (AFTER.includes(v) ? v : 'keep')

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
    members: new Map(), // userId -> { role, enc, folder, until, after }
    removed: new Map(), // userId -> { after, at }
    epoch: 0,
    grants: new Map(), // userId -> Map(epoch -> sealed key)
    invitesValidFrom: 0,
    usedInvites: new Map(), // single-use invite id -> userId it admitted
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
      if (e.legacy === false) s.legacyLinks = false
      break
    case 'add': {
      if (!isRole(e.role) || (e.role === 'owner' && e.userId !== s.owner)) throw new Error('bad role')
      // Adding someone again (to hand them a new key) keeps when their
      // access ends unless the entry says otherwise.
      const prev = s.members.get(e.userId)
      const owner = e.userId === s.owner
      s.members.set(e.userId, {
        role: owner ? 'owner' : roleHere(e.role),
        enc: e.enc || prev?.enc || null,
        folder: typeof e.folder === 'string' ? e.folder : null,
        until: owner ? null : 'until' in e ? cleanUntil(e.until) : prev?.until ?? null,
        after: 'after' in e ? cleanAfter(e.after) : prev?.after || 'keep'
      })
      s.removed.delete(e.userId)
      if (e.key) grant(s, e.userId, e.key.epoch, e.key.sealed)
      if (typeof e.via === 'string' && !s.usedInvites.has(e.via)) s.usedInvites.set(e.via, e.userId)
      break
    }
    case 'access': {
      const m = s.members.get(e.userId)
      if (!m || e.userId === s.owner) throw new Error('bad access change')
      m.until = cleanUntil(e.until)
      m.after = cleanAfter(e.after)
      break
    }
    case 'role':
      if (!s.members.has(e.userId) || e.userId === s.owner || !isRole(e.role) || e.role === 'owner') throw new Error('bad role change')
      s.members.get(e.userId).role = roleHere(e.role)
      break
    case 'remove':
      if (e.userId === s.owner) throw new Error('the owner cannot be removed')
      s.removed.set(e.userId, { after: cleanAfter(e.after || s.members.get(e.userId)?.after), at: e.at || 0 })
      s.members.delete(e.userId)
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
      Object.assign(s.members.get(e.userId), { role: 'owner', until: null })
      break
    case 'revoke-invites':
      s.invitesValidFrom = i + 1
      s.legacyLinks = false
      break
    case 'retire-legacy':
      s.legacyLinks = false
      break
    default:
      // An entry from a newer app. Ignoring it is safe unless it limits
      // who may do what (the newer app marks those `critical`); then this
      // app stops syncing the file until it's updated, rather than let in
      // someone the owner kept out.
      if (typeof e.type !== 'string') throw new Error('bad entry')
      if (e.critical) s.needsNewer = true
      s.unknown = (s.unknown || 0) + 1
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
  get acceptsLegacyLinks () { return this.state.legacyLinks }
  // The log has an entry only a newer app understands, and it limits access.
  get needsNewer () { return Boolean(this.state.needsNewer) }

  // Starts a log. `members` lets a document made before membership keep
  // everyone who was already working on it.
  static create (identity, docId, { members = [] } = {}) {
    const m = new Membership(docId)
    const body = { seq: 0, prev: null, doc: docId, type: 'create', by: identity.userId, owner: identity.userId, ownerEnc: identity.encPublic, at: Date.now(), members, legacy: false }
    m.entries = [{ ...body, sig: signWith(identity, body) }]
    m.state = replay(docId, m.entries)
    return m
  }

  // Adopts another copy of the log if it is valid and newer. Returns true if
  // anything changed. Only the owner writes, so copies normally just extend
  // each other. If the owner signed two different entries at the same
  // position (from two of their computers at once), every peer keeps the
  // branch with the smaller hash; the entries this copy loses are left in
  // `dropped` so the owner's computer can make those changes again.
  merge (entries) {
    this.dropped = []
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
      this.dropped = mine.slice(i)
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

  // { after, at } for someone taken out, or null.
  removal (userId) {
    return this.state.removed.get(userId) || null
  }

  // Whether someone's access has run out (they're still in the log until
  // the owner's computer removes them).
  hasEnded (userId, now = Date.now()) {
    const m = this.member(userId)
    return Boolean(m?.until) && now >= m.until
  }

  // Members whose access has run out, for the owner to remove.
  lapsed (now = Date.now()) {
    return [...this.state.members].filter(([userId]) => this.hasEnded(userId, now)).map(([userId, m]) => ({ userId, after: m.after }))
  }

  // The soonest end of anyone's access still to come, or null.
  nextEnd (now = Date.now()) {
    let next = null
    for (const m of this.state.members.values()) if (m.until && m.until > now && (next == null || m.until < next)) next = m.until
    return next
  }

  sealedKeyFor (userId, epoch) {
    return this.state.grants.get(userId)?.get(epoch) || null
  }

  // What a peer may do: { role, pending, gated } or null for no access.
  // `invite` is the token they joined with, if any. pending: not in the log
  // yet. gated: they hold a single-use or approval link, so they get nothing
  // until the owner admits them.
  roleOf (userId, invite, now = Date.now()) {
    if (!this.exists) return { role: 'editor', pending: false, gated: false } // no membership yet: invite link = editor
    const m = this.member(userId)
    if (m) return this.hasEnded(userId, now) ? null : { role: m.role, pending: false, gated: false, until: m.until || null }
    if (this.validInvite(invite, { userId, now })) return { role: invite.r, pending: true, gated: Boolean(invite.once || invite.ask) }
    if (this.isRemoved(userId)) return null
    if (!invite && this.state.legacyLinks) return { role: 'editor', pending: true, gated: false }
    return null
  }

  // Why a token can't be used, or null if it can. `userId` is who is using it.
  inviteProblem (token, { userId = null, now = Date.now() } = {}) {
    if (!token || typeof token !== 'object') return 'invalid'
    const { sig, ...body } = token
    if (body.d !== this.docId || !GIVEN_ROLES.includes(body.r)) return 'invalid'
    if (!this.state.owners.has(body.by) || !verifyWith(body.by, body, sig)) return 'invalid'
    if (!(body.q >= this.state.invitesValidFrom)) return 'revoked'
    if (body.x != null && !(now < body.x)) return 'expired'
    if (body.u != null && !(now < body.u)) return 'expired' // the access it gives has ended
    if (body.once) {
      const usedBy = this.state.usedInvites.get(body.i)
      if (usedBy && usedBy !== userId) return 'used'
    }
    return null
  }

  validInvite (token, opts) {
    return this.inviteProblem(token, opts) === null
  }

  // options: { expiresAt (ms), once, ask }. The owner's name rides along so
  // the person joining knows whose file it is before anything arrives.
  // relays: always-on relays the file uses, so a joiner can fetch it from
  // one even when nobody who has it is online.
  // until, after: when the access it gives ends, and what happens then.
  // guest: this is a guest link (see drive/guests.js): access only while
  // the owner is online.
  createInvite (identity, role, { expiresAt = null, once = false, ask = false, relays = [], until = null, after = 'keep', guest = false } = {}) {
    if (identity.userId !== this.state.owner) throw new Error('Only the owner can invite people.')
    const body = {
      d: this.docId,
      r: GIVEN_ROLES.includes(role) ? role : 'editor',
      q: this.entries.length,
      i: crypto.randomBytes(6).toString('hex'),
      by: identity.userId,
      n: identity.name,
      x: expiresAt ? Math.floor(expiresAt) : undefined,
      once: once || undefined,
      ask: ask || undefined,
      h: relays.length ? relays.slice(0, 4) : undefined,
      u: cleanUntil(until) || undefined,
      a: (until || guest) && after === 'hide' ? 'hide' : undefined,
      g: guest ? 1 : undefined
    }
    return { ...body, sig: signWith(identity, body) }
  }

  // ---- owner actions (each returns the entries appended) -----------------

  // Admits someone with a role, sealing the current key to them if needed.
  // `via` is the id of the single-use invite this uses up, if any; `folder`
  // the shared folder whose members get this file, if that's why.
  // `until`, `after`: when their access ends and what happens then
  // (leave both out to keep what they had).
  admit (identity, { userId, role, enc, epochSecret, via, folder, until, after }) {
    if (userId !== this.state.owner && !GIVEN_ROLES.includes(role)) throw new Error('Unknown role.')
    const key = this.state.epoch > 0 && enc && epochSecret
      ? { epoch: this.state.epoch, sealed: sealTo(enc, epochSecret) }
      : undefined
    const ends = until !== undefined ? { until: cleanUntil(until), after: cleanAfter(after) } : {}
    return [this.append(identity, { type: 'add', userId, role: userId === this.state.owner ? 'owner' : role, enc, key, via, folder, ...ends })]
  }

  // Changes when someone's access ends (null: never) and what happens then.
  setAccess (identity, userId, { until = null, after = 'keep' } = {}) {
    return [this.append(identity, { type: 'access', userId, until: cleanUntil(until), after: cleanAfter(after) })]
  }

  setRole (identity, userId, role) {
    if (!GIVEN_ROLES.includes(role)) throw new Error('Unknown role.')
    return [this.append(identity, { type: 'role', userId, role })]
  }

  // Removes someone and moves everyone else to a fresh key.
  // after: what their computer does with its copy ('keep' or 'hide').
  remove (identity, userId, newEpochSecret, { after } = {}) {
    const out = [this.append(identity, { type: 'remove', userId, after: after ? cleanAfter(after) : undefined })]
    out.push(this.rotate(identity, newEpochSecret))
    return out
  }

  // Members whose access has ended don't get the new key.
  rotate (identity, newEpochSecret) {
    const keys = {}
    for (const [id, m] of this.state.members) if (m.enc && !this.hasEnded(id)) keys[id] = sealTo(m.enc, newEpochSecret)
    return this.append(identity, { type: 'rotate', epoch: this.state.epoch + 1, keys })
  }

  transfer (identity, userId) {
    return [this.append(identity, { type: 'owner', userId })]
  }

  revokeInvites (identity) {
    return [this.append(identity, { type: 'revoke-invites' })]
  }

  retireLegacyLinks (identity) {
    return this.state.legacyLinks ? [this.append(identity, { type: 'retire-legacy' })] : []
  }

  list () {
    return [...this.state.members].map(([userId, m]) => ({ userId, role: m.role }))
  }

  // With each member's encryption key and the shared folder that added them.
  detailed () {
    return [...this.state.members].map(([userId, m]) => ({ userId, role: m.role, enc: m.enc, folder: m.folder || null, until: m.until || null, after: m.after || 'keep' }))
  }
}
