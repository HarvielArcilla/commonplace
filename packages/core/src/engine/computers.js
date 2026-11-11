// People's computers (devices.js): announcing my list, keys for documents
// only my own computers share, and what changes when someone's list does.
// Mixed into SyncEngine.

import crypto from 'node:crypto'
import { MSG } from '../protocol.js'
import { seal } from '../crypto.js'
import { directory } from '../devices.js'
import { canManage } from '../members.js'

export class Computers {
  // Hellos again to everyone, for every file (after my list of computers
  // changed, so they all hear about it).
  announce () {
    for (const doc of this.docs.values()) if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
  }

  // A new key for a document with no members (the Drive index, shared only
  // by my own computers): content moves to it, and the older keys are kept
  // only to meet computers of mine that haven't heard of it yet.
  setPrivateKey (docId, epoch, secret) {
    const doc = this.docs.get(docId)
    if (!doc || doc.members.exists || !this._addEpoch(doc, epoch, secret)) return false
    for (const [conn, link] of doc.links) if (link.contentEpoch !== doc.contentEpoch) this._stopContent(doc, conn, link)
    this.emit('topics', docId)
    if (doc.active) for (const conn of this.connections) this._sendHellos(doc, conn)
    return true
  }

  // What changes when someone's list of computers does:
  //   - mine: this computer takes up new keys, or learns it was removed
  //     (the Drive acts on 'identity');
  //   - connections to a computer that was removed close;
  //   - membership logs signed by them are checked again (a removed
  //     computer's last unendorsed changes drop out, and logs that were
  //     waiting for this list go in);
  //   - files I manage that they're in move to a new key if they have a
  //     new encryption key, since the old one may be in a thief's hands.
  _directoryChanged (userId) {
    if (userId === this.identity.userId) this.emit('identity', this.identity.adoptState())
    const st = directory.state(userId)
    for (const conn of [...this.connections]) {
      for (const doc of this.docs.values()) {
        const link = doc.links.get(conn)
        if (link?.user?.userId === userId && link.signedBy && st?.revoked.has(link.signedBy)) { conn.destroy(); break }
      }
    }
    for (const doc of this.docs.values()) {
      if (doc.pendingMembers) { const p = doc.pendingMembers; doc.pendingMembers = null; this.mergeMembers(doc.docId, p) }
      if (doc.members.exists && doc.members.signers().includes(userId) && doc.members.revalidate()) this._membersChanged(doc)
      this._refreshEncKey(doc, userId)
    }
  }

  _refreshEncKey (doc, userId) {
    const st = directory.state(userId)
    const m = doc.members.member(userId)
    if (!st?.enc || !m || m.enc === st.enc || !doc.members.mayManage(this.identity.userId)) return
    if (canManage(m.role) && userId !== this.identity.userId && doc.members.owner !== this.identity.userId) return
    try {
      this._admit(doc, { userId, role: m.role, enc: st.enc, folder: m.folder || undefined })
      doc.members.rotate(this.identity, crypto.randomBytes(32))
      this._membersChanged(doc)
    } catch {}
  }

  // Sends what I know of these people's lists of computers (those who
  // have one).
  _sendUsers (doc, conn, epoch, userIds) {
    const users = {}
    for (const u of userIds) { const s = directory.statements(u); if (s.length) users[u] = s }
    if (Object.keys(users).length) conn.send(MSG.USERS, doc.docId, epoch, seal(doc.keyFor(epoch), Buffer.from(JSON.stringify(users))))
  }
}
