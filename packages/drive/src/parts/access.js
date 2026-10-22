// Who has a file: roles, removing people, transferring ownership, when
// access ends (mine and others'), and guests who can open it only while
// the owner is online.

export class Access {
  // Someone who had a file through a shared folder and is given a role by
  // hand keeps it directly, whatever happens to the folder.
  setMemberRole (docId, userId, role) {
    const m = this.engine.membersDetailed(docId).find((x) => x.userId === userId)
    if (m?.folder) this.engine.addMember(docId, { userId, role, enc: m.enc })
    else this.engine.setRole(docId, userId, role)
  }

  // Someone who has a file through a shared folder they're still in would
  // only get it back: say so instead.
  // after: 'keep' (their copy stays, read-only) or 'hide' (their computer deletes it).
  removeMember (docId, userId, { after } = {}) {
    this._refuseIfFromFolder(docId, userId)
    this.engine.removeMember(docId, userId, { after })
  }

  _refuseIfFromFolder (docId, userId) {
    const m = this.engine.membersDetailed(docId).find((x) => x.userId === userId)
    const folder = m?.folder && this.shared.containers().get(docId)?.includes(m.folder) ? this.files.get(m.folder) : null
    if (folder && this.engine.membersDetailed(folder.docId).some((x) => x.userId === userId)) {
      throw new Error(`They have this through the shared folder “${folder.title}”. Remove them from the folder, or move the file out of it.`)
    }
  }

  // The owner took me out, or my time ran out: stop, and keep a read-only
  // copy or delete it, as the owner chose.
  _checkMyAccess (docId) {
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc?.members.exists) return
    const removal = doc.members.removal(this.identity.userId)
    if (removal && !doc.members.member(this.identity.userId)) this._accessEnded(docId, removal.after)
    else if (entry.ended && doc.myAccess) this._patch(docId, { ended: null }) // given back
  }

  _accessEnded (docId, after = 'keep') {
    const entry = this.files.get(docId)
    if (!entry || entry.ended) return
    if (this._ownerOf(docId) === this.identity.userId) return
    this._patch(docId, { ended: { at: Date.now(), after: after === 'hide' ? 'hide' : 'keep' } })
    if (after === 'hide') this._wipe(docId)
    this.emit('access-ended', docId, after)
    this._changed()
  }

  // Deletes this computer's copy of a file's contents, keeping its place in
  // the Drive (so it can say what happened, and be removed).
  _wipe (docId) {
    this.relays?.setRelays(docId, [])
    this.uploads.unwatch(docId)
    this.engine.closeDoc(docId, { deleteLocalData: true })
    this._attached.delete(docId)
    this._leaveTopics(docId)
    this._changed()
  }

  _watchGuestHost (status) {
    const entry = status && this.files.get(status.docId)
    if (!entry?.guest) return
    const ownerId = this._ownerOf(status.docId)
    if (status.peers.some((p) => p.userId === ownerId)) {
      this._hostSeen.set(status.docId, Date.now())
      if (entry.guestAway) this._patch(status.docId, { guestAway: false })
    }
  }

  // A guest's copy with 'hide' is deleted once the owner has been gone a
  // minute (it comes back when they are online again); with 'keep' it just
  // can't be edited meanwhile.
  _checkGuestHosts (now = Date.now()) {
    for (const entry of this.files.values()) {
      if (!entry.guest || entry.ended) continue
      const ownerId = this._ownerOf(entry.docId)
      if ((this.engine.status(entry.docId)?.peers || []).some((p) => p.userId === ownerId)) {
        this._hostSeen.set(entry.docId, now)
        if (entry.guestAway) this._patch(entry.docId, { guestAway: false })
        continue
      }
      const seen = this._hostSeen.get(entry.docId) || 0
      if (now - seen < this.guestGraceMs) continue
      if (!entry.guestAway) this._patch(entry.docId, { guestAway: true })
      const doc = this.engine.getDoc(entry.docId)
      const hasContent = doc && doc.ydoc.store.clients.size > 0
      if (entry.guest.after === 'hide' && hasContent) {
        this._wipe(entry.docId)
        this._attach(this.files.get(entry.docId))
      }
    }
  }

  // Guests are served by the owner, so they end when ownership moves.
  transferOwnership (docId, userId) {
    this.engine.transferOwnership(docId, userId)
    this.guests.endAllFor(docId)
  }

  // When someone's access ends (until: ms, or null for never) and what their
  // computer does with its copy then. Not for access a shared folder gives:
  // the folder would only give it back.
  setMemberAccess (docId, userId, { until = null, after = 'keep' } = {}) {
    this._refuseIfFromFolder(docId, userId)
    if (until != null && !(until > Date.now())) throw new Error('Choose a time later than now, or remove them instead.')
    this.engine.setMemberAccess(docId, userId, { until, after })
  }

  resetInvites (docId) { this.engine.resetInvites(docId) }

  approveRequest (docId, userId, role) { this.engine.approveRequest(docId, userId, role) }

  declineRequest (docId, userId) { this.engine.declineRequest(docId, userId) }
}
