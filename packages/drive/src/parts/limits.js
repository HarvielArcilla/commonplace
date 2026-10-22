// Protecting this computer: pausing files that grow past this computer's
// limits, the policy settings themselves, and blocking people.

export class Limits {
  // A file stops syncing (until I say to keep going) when changes from
  // others would hurt this computer:
  //   'size'  someone else's file grew past my limit for one file;
  //   'own'   my own file grew past my (higher) limit through others' edits;
  //   'total' all the files others made, together, passed my limit;
  //   'space' the disk got down to the free space I keep.
  // Others: 'many' (a shared folder brought too many files today) and
  // 'blocked' (from someone I've blocked).
  _guardSoon (docId) {
    this._guardTimers = this._guardTimers || new Map()
    if (this._guardTimers.has(docId)) return
    this._guardTimers.set(docId, setTimeout(() => { this._guardTimers.delete(docId); this._guard(docId) }, 2000))
  }

  _guard (docId) {
    const entry = this.files.get(docId)
    if (!entry || entry.held) return
    const p = this.policy
    const mine = this._ownerOf(docId) === this.identity.userId
    const bytes = this.store.sizeOf(docId)
    const allowed = entry.allowBytes || 0
    let reason = null
    if (this.uploads.freeBytes() < p.get('keepFreeBytes')) reason = 'space'
    else if (bytes > Math.max(p.get(mine ? 'ownDocGuardBytes' : 'docGuardBytes'), allowed)) reason = mine ? 'own' : 'size'
    else if (!mine && bytes > allowed && this._othersBytes() > p.get('othersDocsBytes')) reason = 'total'
    if (reason) this._hold(docId, reason, bytes)
  }

  _hold (docId, reason, bytes = this.store.sizeOf(docId)) {
    this._patch(docId, { held: true, heldReason: reason, heldBytes: bytes })
    this._applyActive(docId)
    this.emit('held', docId, bytes, reason)
  }

  _ownerOf (docId) {
    return this.engine.access(docId)?.owner || this.files.get(docId)?.owner?.userId || null
  }

  // Bytes of every document others made, together.
  _othersBytes () {
    let n = 0
    for (const entry of this.files.values()) if (this._ownerOf(entry.docId) !== this.identity.userId) n += this.store.sizeOf(entry.docId)
    return n
  }

  // Keep syncing a paused file. A size limit then lets it double before
  // asking again.
  keepSyncing (docId) {
    const entry = this.files.get(docId)
    if (!entry?.held) return
    const owner = this._ownerOf(docId)
    if (owner && this.policy.isBlocked(owner)) throw new Error('You’ve blocked the person who made this file. Unblock them in Settings first.')
    const grows = ['size', 'own', 'total', 'space'].includes(entry.heldReason || 'size')
    this._patch(docId, { held: false, heldReason: null, allowBytes: grows ? Math.max(entry.allowBytes || 0, (entry.heldBytes || 0) * 2) : entry.allowBytes || 0 })
    this._applyActive(docId)
  }

  // Everything a shared folder brought paused today, in one go.
  keepSyncingFolder (folderId) {
    for (const entry of [...this.files.values()]) if (entry.held && entry.heldReason === 'many' && entry.viaFolder === folderId) this.keepSyncing(entry.docId)
  }

  policySettings () { return { values: this.policy.all(), defaults: this.policy.defaults, blocked: this.policy.blocked } }

  setPolicy (patch) {
    this.policy.set(patch || {})
    this._changed()
    return this.policySettings()
  }

  resetPolicy () {
    this.policy.reset()
    this._changed()
    return this.policySettings()
  }

  // Ignore someone everywhere: their files pause, their uploads never
  // download, and this computer stops exchanging anything with them.
  block (userId, name) {
    if (userId === this.identity.userId) throw new Error('You can’t block yourself.')
    this.policy.block({ userId, name })
    for (const entry of [...this.files.values()]) if (!entry.held && this._ownerOf(entry.docId) === userId) this._hold(entry.docId, 'blocked')
    this.engine.recheckUser(userId)
    this.uploads.decideAll()
    this._changed()
  }

  unblock (userId) {
    this.policy.unblock(userId)
    for (const entry of [...this.files.values()]) if (entry.held && entry.heldReason === 'blocked' && this._ownerOf(entry.docId) === userId) this.keepSyncing(entry.docId)
    this.engine.recheckUser(userId)
    this.uploads.decideAll()
    this._changed()
  }
}
