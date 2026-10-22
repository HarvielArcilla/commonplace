// Conflicts: edits to the same paragraph made while two computers were
// apart. The engine notices when both sides changed the file; this finds
// which units changed on both, records them in the file, and lets the
// owner decide.

import { findConflicts, conflictId, docFrom } from '@commonplace/core'

export function openConflicts (ydoc) {
  return [...ydoc.getMap('conflicts').values()].filter((c) => c?.status === 'open').sort((a, b) => a.at - b.at)
}

export class Conflicts {
  // Open conflicts with both versions and what the merge currently shows.
  conflicts (docId) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.units) return []
    const now = app.units(doc.ydoc)
    const people = doc.ydoc.getMap('people')
    return openConflicts(doc.ydoc).map((c) => ({
      ...c,
      versions: c.versions.map(({ snapshot, ...v }) => ({ ...v, name: v.userId === this.identity.userId ? this.identity.name : (people.get(v.userId)?.name || v.name || 'Someone') })),
      current: now.get(c.unit) ? { exists: true, text: now.get(c.unit).text } : { exists: false, text: '' }
    }))
  }

  // Only the owner decides conflicts. The decision is an ordinary edit, so it
  // reaches everyone like any other change.
  resolveConflict (docId, id, choice) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.resolve) throw new Error('No such file.')
    if (doc.members.exists && doc.members.owner !== this.identity.userId) throw new Error('Only the owner can decide conflicts.')
    const map = doc.ydoc.getMap('conflicts')
    const rec = map.get(id)
    if (!rec || rec.status !== 'open') return
    doc.ydoc.transact(() => {
      this._signLocalEdits(doc)
      app.resolve(doc.ydoc, rec, choice)
      map.set(id, { ...rec, status: 'resolved', choice, resolvedBy: this.identity.userId, resolvedAt: Date.now() })
    }, 'local')
    this._patch(docId, { lastEditedAt: Date.now(), contributed: true })
    this._changed()
  }

  _recordConflicts ({ docId, peer, base, mine, theirs }) {
    const doc = this.engine.getDoc(docId)
    const entry = this.files.get(docId)
    const app = entry && this.appsByType.get(entry.type)
    if (!doc || !app?.units) return
    let found
    try {
      found = findConflicts({ base: docFrom(base), mine: docFrom(mine), theirs: docFrom(theirs), units: app.units })
    } catch (err) {
      this.emit('error', err)
      return
    }
    if (!found.length) return
    const map = doc.ydoc.getMap('conflicts')
    const version = (u, who) => ({
      userId: who.userId,
      name: who.name,
      exists: Boolean(u),
      text: u ? u.text : '',
      snapshot: !u ? null : app.snapshotUnit ? app.snapshotUnit(u) : (u.el && app.snapshotBlock ? app.snapshotBlock(u.el) : null)
    })
    doc.ydoc.transact(() => {
      for (const c of found) {
        const id = conflictId(c.key, [c.mine?.sig, c.theirs?.sig])
        if (map.has(id)) continue
        const versions = [
          version(c.mine, { userId: this.identity.userId, name: this.identity.name }),
          version(c.theirs, peer)
        ].sort((a, b) => a.userId.localeCompare(b.userId))
        map.set(id, {
          id,
          kind: c.base.kind,
          unit: c.key,
          prev: c.base.prev,
          index: c.base.index ?? null,
          base: { text: c.base.text },
          versions,
          at: Date.now(),
          status: 'open'
        })
      }
    }, 'local')
    this._changed()
  }
}
