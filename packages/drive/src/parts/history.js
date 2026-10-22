// Version history: checkpoints saved on this computer as edits pause, and
// putting a file back to one (an ordinary edit, so it reaches everyone).

import { canEdit, docFrom, restoreContent } from '@commonplace/core'

export class VersionHistory {
  versions (docId) {
    const doc = this.engine.getDoc(docId)
    if (!doc) return []
    const people = doc.ydoc.getMap('people')
    const nameOf = (userId) => (userId === this.identity.userId ? this.identity.name : people.get(userId)?.name || this.files.get(docId)?.names?.[userId] || 'Someone')
    return this.history.list(docId).reverse().map((v) => ({ ...v, names: v.by.map(nameOf) }))
  }

  // The file as it was at a version (a Yjs update the window can show).
  version (docId, id) {
    return this.history.load(docId, id)
  }

  nameVersion (docId, id, label) {
    this.history.name(docId, id, label)
    this._changed()
  }

  // Saves a checkpoint now if anything changed since the last one.
  checkpoint (docId, opts = {}) {
    const pending = this._checkpoints.get(docId)
    if (pending) { clearTimeout(pending.timer); this._checkpoints.delete(docId) }
    const doc = this.engine.getDoc(docId)
    if (!doc || !this.files.get(docId)?.type) return null
    const authors = doc.ydoc.getMap('authors')
    return this.history.record(docId, doc.ydoc, { ...opts, authorOf: (client) => authors.get(String(client))?.userId || null })
  }

  // Puts the file back to an earlier version. That is an ordinary edit, so it
  // reaches everyone, and the version it replaced stays in the history.
  restoreVersion (docId, id) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.history) throw new Error('This file can\u2019t be restored.')
    if (!canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can restore a version.')
    const target = this.history.list(docId).find((v) => v.id === id)
    const past = this.history.load(docId, id)
    if (!target || !past) throw new Error('That version is no longer here.')
    this.checkpoint(docId)
    doc.ydoc.transact(() => {
      this._signLocalEdits(doc)
      restoreContent(doc.ydoc, docFrom(past), app.history.roots)
    }, 'local')
    this._patch(docId, { contributed: true, lastEditedAt: Date.now() })
    this.checkpoint(docId, { kind: 'restore', restoredFrom: target.at })
    this._changed()
  }

  _scheduleCheckpoint (docId) {
    const t = this._checkpoints.get(docId) || { first: Date.now(), timer: null }
    clearTimeout(t.timer)
    const { idleMs, maxMs } = this.historyTiming
    t.timer = setTimeout(() => this.checkpoint(docId), Math.max(0, Math.min(idleMs, t.first + maxMs - Date.now())))
    t.timer.unref?.()
    this._checkpoints.set(docId, t)
  }
}
