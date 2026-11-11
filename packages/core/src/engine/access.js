// The engine's side of membership (members.js): changing who has access,
// adopting copies of the log, opening the keys it seals to me, and letting
// people in when they arrive with an invite. Mixed into SyncEngine.

import crypto from 'node:crypto'
import { Membership, canManage } from '../members.js'
import { MSG } from '../protocol.js'
import { seal } from '../crypto.js'

// The end of access an invite link gives (u) and what happens then (a).
const accessFromInvite = (invite) => (invite?.u ? { until: invite.u, after: invite.a === 'hide' ? 'hide' : 'keep' } : {})

export class Access {
  membership (docId) {
    return this.docs.get(docId)?.members || null
  }

  access (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return null
    const a = doc.myAccess
    const removed = doc.members.isRemoved(this.identity.userId) && !doc.members.member(this.identity.userId)
    return {
      role: a?.role || null,
      pending: Boolean(a?.pending),
      removed,
      // Waiting for the owner to hand over the current key.
      waitingForKey: Boolean(a) && !a.gated && doc.myEpoch < doc.members.epoch,
      // Holding a single-use or approval link the owner hasn't acted on yet.
      waitingForApproval: Boolean(a?.gated),
      // Why my invite link doesn't work, if it doesn't: expired, used, revoked.
      inviteProblem: !a && doc.invite && doc.members.exists ? doc.members.inviteProblem(doc.invite, { userId: this.identity.userId }) : null,
      hasMembership: doc.members.exists,
      owner: doc.members.owner,
      // May change who has access (the owner, or a manager).
      manage: doc.members.exists && doc.members.mayManage(this.identity.userId)
    }
  }

  // Starts a membership log for a document I own. `members` keeps people who
  // were already working on a document made before membership existed.
  ensureMembership (docId, { members = [] } = {}) {
    const doc = this.docs.get(docId)
    if (!doc || doc.members.exists) return false
    doc.members = Membership.create(this.identity, docId, { members })
    this._membersChanged(doc)
    return true
  }

  createInvite (docId, role, options) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    return doc.members.createInvite(this.identity, role, options)
  }

  // People holding an approval link who are waiting for the owner.
  requests (docId) {
    const doc = this.docs.get(docId)
    if (!doc) return []
    return [...doc.requests.values()]
      .filter((r) => !doc.members.member(r.userId) && !doc.declined.has(r.userId))
      .map(({ userId, name, color, role, at }) => ({ userId, name, color, role, at }))
  }

  approveRequest (docId, userId, role) {
    this._ownerAction(docId, (doc) => {
      const r = doc.requests.get(userId)
      if (!r) throw new Error('That person is no longer asking to join.')
      doc.requests.delete(userId)
      this._admit(doc, { userId, role: role || r.role, enc: r.enc, invite: r.invite })
    })
  }

  declineRequest (docId, userId) {
    const doc = this.docs.get(docId)
    if (!doc) return
    doc.requests.delete(userId)
    doc.declined.add(userId)
    this.store.writeJSON(docId, 'declined', [...doc.declined])
    this._scheduleStatus(doc)
  }

  // Unsigned links from before roles existed stop working for this file.
  retireLegacyLinks (docId) {
    const doc = this.docs.get(docId)
    if (!doc || doc.members.owner !== this.identity.userId || !doc.members.acceptsLegacyLinks) return
    doc.members.retireLegacyLinks(this.identity)
    this._membersChanged(doc)
  }

  setRole (docId, userId, role) {
    this._ownerAction(docId, (doc) => doc.members.setRole(this.identity, userId, role))
  }

  // Adds someone directly, as owner (shared folders use this: the person's
  // encryption key comes from the folder's own log). `folder` records why.
  addMember (docId, { userId, role, enc, folder = undefined }) {
    this._ownerAction(docId, (doc) => this._admit(doc, { userId, role, enc, folder }))
  }

  membersDetailed (docId) {
    return this.docs.get(docId)?.members.detailed() || []
  }

  // Removes someone: they get nothing new. after: 'keep' (their copy stays,
  // read-only) or 'hide' (their computer deletes it).
  removeMember (docId, userId, { after } = {}) {
    this._ownerAction(docId, (doc) => doc.members.remove(this.identity, userId, crypto.randomBytes(32), { after }))
  }

  // When someone's access ends (null: never), and what happens to their copy.
  setMemberAccess (docId, userId, { until = null, after = 'keep' } = {}) {
    this._ownerAction(docId, (doc) => doc.members.setAccess(this.identity, userId, { until, after }))
  }

  // Every few seconds: access that has just ended stops on every computer
  // (by its own clock), and the owner's computer removes those people and
  // moves everyone else to a new key. Emits 'access-ended' once when my own
  // access to a file ends.
  checkEnds (now = Date.now()) {
    for (const doc of this.docs.values()) {
      if (!doc.members.exists) continue
      if (doc.members.mayManage(this.identity.userId)) {
        const lapsed = doc.members.lapsed(now).filter((x) => doc.members.member(x.userId)?.role !== 'manager' || doc.members.owner === this.identity.userId)
        if (lapsed.length) {
          this._ownerAction(doc.docId, (d) => { for (const x of lapsed) d.members.remove(this.identity, x.userId, crypto.randomBytes(32), { after: x.after }) })
          continue
        }
      }
      const mine = doc.members.member(this.identity.userId)
      const ended = doc.members.hasEnded(this.identity.userId, now)
      if (ended && !doc.endedNoticed) { doc.endedNoticed = true; this.emit('access-ended', doc.docId, { after: mine?.after || 'keep' }) }
      if (!doc.members.nextEnd(now - 60e3) && !doc.members.lapsed(now).length) continue
      for (const [conn, link] of doc.links) {
        this._checkAccess(doc, link)
        if (!this._mayExchange(doc, link) || link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
      }
    }
  }

  // The owner's handover to a team drive's server (see members.js).
  setHandover (docId, { to = null, drive = null } = {}) {
    this._ownerAction(docId, (doc) => doc.members.setHandover(this.identity, { to, drive }))
  }

  transferOwnership (docId, userId) {
    this._ownerAction(docId, (doc) => doc.members.transfer(this.identity, userId))
  }

  // Stops every invite link issued so far and moves everyone to a new key.
  resetInvites (docId) {
    this._ownerAction(docId, (doc) => [doc.members.rotate(this.identity, crypto.randomBytes(32))])
  }

  // Adopts a copy of a file's membership log from anywhere (a peer, a
  // relay). The log checks its own signatures.
  mergeMembers (docId, entries) {
    const doc = this.docs.get(docId)
    if (!doc) return false
    if (!doc.members.merge(entries)) {
      // It may be signed by a computer whose owner's list hasn't reached
      // me yet: try again when it does.
      if (Array.isArray(entries) && entries.length > doc.members.entries.length) doc.pendingMembers = entries
      return false
    }
    doc.pendingMembers = null
    this._membersChanged(doc)
    this._redoDropped(doc, doc.members.dropped)
    return true
  }

  // Two of my computers changed who has access at the same moment and the
  // other one's change won: make mine again on top of it, if it still applies.
  _redoDropped (doc, dropped = []) {
    const mineNow = () => doc.members.mayManage(this.identity.userId)
    for (const e of dropped) {
      if (e.by !== this.identity.userId || !mineNow()) continue
      const m = doc.members
      try {
        if (e.type === 'add' && !m.member(e.userId)) this._admit(doc, { userId: e.userId, role: e.role, enc: e.enc, invite: e.via ? { once: true, i: e.via } : null, folder: e.folder, ...('until' in e ? { until: e.until, after: e.after } : {}) })
        else if (e.type === 'access' && m.member(e.userId)) m.setAccess(this.identity, e.userId, { until: e.until, after: e.after })
        else if (e.type === 'role' && m.member(e.userId) && m.member(e.userId).role !== e.role) m.setRole(this.identity, e.userId, e.role)
        else if (e.type === 'remove' && m.member(e.userId)) m.remove(this.identity, e.userId, crypto.randomBytes(32), { after: e.after })
        else if (e.type === 'rotate' && !dropped.some((x) => x.type === 'remove')) m.rotate(this.identity, crypto.randomBytes(32))
        else if (e.type === 'owner' && m.member(e.userId)) m.transfer(this.identity, e.userId)
        else if (e.type === 'handover' && m.owner === this.identity.userId && (m.handover?.to || null) !== (e.to || null)) m.setHandover(this.identity, { to: e.to, drive: e.drive })
        else if (e.type === 'revoke-invites') m.revokeInvites(this.identity)
        else if (e.type === 'retire-legacy') m.retireLegacyLinks(this.identity)
        else continue
      } catch { continue }
      this._membersChanged(doc)
    }
  }

  _ownerAction (docId, fn) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('No such file.')
    if (!doc.members.mayManage(this.identity.userId)) throw new Error('Only the owner and people who can share can change who has access.')
    fn(doc)
    this._membersChanged(doc)
  }

  // Opens any keys the membership log has sealed to me. The log decides:
  // if I hold a different key for an epoch (from a branch of the log that
  // lost when two of the owner's computers changed access at once), the
  // log's key replaces it, or I'd be locked out of the file from then on.
  _collectGrants (doc) {
    let added = false
    for (let e = 1; e <= doc.members.epoch; e++) {
      const sealed = doc.members.sealedKeyFor(this.identity.userId, e)
      if (!sealed && doc.epochs.has(e)) continue
      const secret = sealed && this.identity.openSealed(sealed)
      if (secret?.length !== 32) continue
      const held = doc.epochs.get(e)
      if (held && held.secret.equals(secret)) continue
      if (held) doc.epochs.delete(e)
      added = this._addEpoch(doc, e, secret) || added
    }
    return added
  }

  _membersChanged (doc) {
    this.store.writeJSON(doc.docId, 'members', doc.members.entries)
    const newKeys = this._collectGrants(doc)
    const log = Buffer.from(JSON.stringify(doc.members.entries))
    for (const [conn, link] of doc.links) {
      // Tell everyone, on the newest epoch we share.
      const shared = Math.max(...[...link.epochs].filter((e) => doc.epochs.has(e)))
      if (Number.isFinite(shared)) {
        this._sendUsers(doc, conn, shared, doc.members.signers())
        conn.send(MSG.MEMBERS, doc.docId, shared, seal(doc.keyFor(shared), log))
      }
      // Re-check what each peer may do now, and start or stop content.
      this._checkAccess(doc, link)
      if (!this._mayExchange(doc, link) || link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
      if (this._mayExchange(doc, link)) this._startContent(doc, conn, link)
    }
    if (newKeys) {
      this.emit('topics', doc.docId)
      if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
    }
    this.emit('members', doc.docId)
    this._scheduleStatus(doc)
  }

  // As owner or manager: let in people holding a valid invite (or note their request,
  // for approval links), and hand the current key to members without it.
  _ownerGreets (doc, link, access) {
    const { userId } = link.user
    if (!link.enc) return
    if (access.pending) {
      if (link.invite?.ask) {
        if (!doc.declined.has(userId) && !doc.requests.has(userId)) {
          doc.requests.set(userId, { ...link.user, role: access.role, enc: link.enc, invite: link.invite, at: Date.now() })
          this.emit('request', doc.docId, userId)
        }
        return
      }
      this._admit(doc, { userId, role: access.role, enc: link.enc, invite: link.invite, ...accessFromInvite(link.invite) })
      this._membersChanged(doc)
      return
    }
    const m = doc.members.member(userId)
    // (Managers can't change the owner or other managers, so they leave
    // those to the owner, who seals every key to them anyway.)
    if (canManage(m?.role) && doc.members.owner !== this.identity.userId) return
    const needsKey = doc.members.epoch > 0 && !doc.members.sealedKeyFor(userId, doc.members.epoch)
    if (!m?.enc || needsKey) {
      this._admit(doc, { userId, role: access.role, enc: link.enc, folder: m?.folder || undefined })
      this._membersChanged(doc)
    }
  }

  _admit (doc, { userId, role, enc, invite = null, folder = undefined, until = undefined, after = undefined }) {
    doc.members.admit(this.identity, {
      userId,
      role,
      enc,
      epochSecret: doc.epochs.get(doc.members.epoch)?.secret,
      via: invite?.once ? invite.i : undefined,
      folder,
      until,
      after
    })
  }
}
