// Folders: my own (in the Drive index) and shared folders (documents of
// their own, see shared-folders.js), and moving files between them.

import { randomBytes } from 'node:crypto'
import { canEdit } from '@commonplace/core'

const cleanName = (name) => String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 120)

export class Folders {
  // The shared folder of mine that lists a file, if any.
  _inMyFolders (docId) {
    for (const f of this.shared.folders()) if (this.shared.items(f.docId).has(docId)) return f.docId
    return null
  }

  // Files I removed from a shared folder, and bringing them back.
  removedFrom (folderId) {
    return [...this.dismissed.entries()].filter(([, d]) => d?.folderId === folderId).map(([docId]) => docId)
  }

  restoreRemoved (folderId) {
    for (const docId of this.removedFrom(folderId)) this.dismissed.delete(docId)
    this.shared.soon()
  }

  // Before a shared folder leaves my Drive: what I own comes out of it (to
  // where the folder was), so it stops being shared through a folder I can
  // no longer see.
  _leaveFolder (folderId) {
    const where = this.files.get(folderId)?.folderId
    // A team drive keeps what's in it: my files there stay the drive's.
    const canChange = canEdit(this.engine.access(folderId)?.role) && !this.shared.driveInfo(folderId)
    for (const [childId] of this.shared.items(folderId)) {
      const child = this.files.get(childId)
      if (!child) continue
      if (canChange && this.engine.access(childId)?.owner === this.identity.userId) this.shared.remove(folderId, childId)
      this._patch(childId, { folderId: this.folders.has(where) ? where : null, viaFolder: child.viaFolder === folderId ? null : child.viaFolder })
    }
    for (const e of this.files.values()) if (e.folderId === folderId) this._patch(e.docId, { folderId: this.folders.has(where) ? where : null })
  }

  // Someone else's file, found in a shared folder of mine: join it with its
  // secret alone. Its owner adds me to it; until then nothing arrives.
  _joinFromFolder (docId, item, folderId) {
    // Files from people you've blocked, and more files in a day than your
    // limit, arrive paused: listed, but nothing syncs until you say so.
    const mine = item.owner === this.identity.userId
    const blocked = !mine && this.policy.isBlocked(item.owner)
    const many = !mine && !blocked && !this.policy.allowJoin(folderId)
    this.files.set(docId, {
      ...(blocked || many ? { held: true, heldReason: blocked ? 'blocked' : 'many', heldBytes: 0 } : {}),
      docId,
      secret: item.secret,
      invite: null,
      type: null,
      title: item.title || 'Waiting for a peer…',
      owner: { userId: item.owner, name: item.ownerName },
      folderId: null,
      viaFolder: folderId,
      addedAt: Date.now()
    })
    this._attach(this.files.get(docId))
    if (item.owner !== this.identity.userId) this.activity.shared(docId, folderId, { userId: item.owner, name: item.ownerName })
  }

  createFolder (name, parentId = null) {
    const id = randomBytes(8).toString('hex')
    this.folders.set(id, { id, name: cleanName(name) || 'Untitled folder', parentId: this.folders.has(parentId) ? parentId : null, createdAt: Date.now() })
    this._changed()
    return id
  }

  renameFolder (id, name) {
    if (this.shared.isFolder(id)) { if (cleanName(name)) this.rename(id, cleanName(name)); return }
    const f = this.folders.get(id)
    if (f && cleanName(name)) { this.folders.set(id, { ...f, name: cleanName(name) }); this._changed() }
  }

  // Deleting a folder never deletes files: its contents move up one level.
  deleteFolder (id) {
    if (this.shared.isFolder(id)) return this.remove(id)
    const f = this.folders.get(id)
    if (!f) return
    const parent = this.folders.has(f.parentId) ? f.parentId : null
    this.index.transact(() => {
      for (const entry of this.files.values()) if (entry.folderId === id) this.files.set(entry.docId, { ...entry, folderId: parent })
      for (const sub of this.folders.values()) if (sub.parentId === id) this.folders.set(sub.id, { ...sub, parentId: parent })
      this.folders.delete(id)
    })
    this._changed()
  }

  // Moves a file (or a shared folder) into one of my folders, a shared
  // folder, or the top. Into a shared folder means sharing it with everyone
  // there; out of one means they lose what they had only through it. Into
  // a team drive means its server hosts it too; out of one, it no longer does.
  // Returns { localOnly } when it's in a shared folder for me only.
  moveFile (docId, folderId) {
    const entry = this.files.get(docId)
    if (!entry) return {}
    const containers = this.shared.containers()
    const from = this.shared.placeOf(docId, containers)
    if (from === folderId) return {}
    const toShared = folderId && this.shared.isFolder(folderId)
    // Into or out of a team drive (docs/TEAM-DRIVES.md): only the owner
    // moves a file between drives, and the file learns its new host first.
    const isCatalog = Boolean(this.shared.driveInfo(docId))
    const fromDrive = isCatalog ? null : this.shared.driveOf(docId, containers)
    const toDrive = isCatalog || !toShared ? null : this.shared.driveOf(folderId, containers)
    if (toDrive && toDrive !== fromDrive) this._enterDrive(docId, toDrive)
    if (from && this.shared.isFolder(from) && (containers.get(docId) || []).includes(from)) this.shared.remove(from, docId)
    if (fromDrive && fromDrive !== toDrive) this._leaveDrive(docId, fromDrive)
    if (toShared) {
      try {
        this.shared.add(folderId, docId)
        this._patch(docId, { folderId: null })
      } catch (err) {
        if (!err.localOnly) throw err
        this._patch(docId, { folderId })
        return { localOnly: true, message: err.message }
      }
    } else {
      this._patch(docId, { folderId: this.folders.has(folderId) ? folderId : null })
    }
    this._changed()
    return {}
  }

  // A new shared folder, empty, with me as its owner.
  async createSharedFolder (name, parentId = null) {
    return this.create('folder', cleanName(name) || 'Shared folder', { folderId: parentId })
  }

  // Turns one of my folders into a shared folder, with its subfolders.
  // What I own goes in it for everyone; files others own stay in it for me.
  async shareFolder (id) {
    const f = this.folders.get(id)
    if (!f) throw new Error('No such folder.')
    const docId = await this.create('folder', f.name, { folderId: this.folders.has(f.parentId) ? f.parentId : null })
    for (const sub of [...this.folders.values()].filter((x) => x.parentId === id)) {
      const subId = await this.shareFolder(sub.id)
      this.moveFile(subId, docId)
    }
    for (const entry of [...this.files.values()].filter((e) => e.folderId === id)) this.moveFile(entry.docId, docId)
    this.folders.delete(id)
    this._changed()
    return docId
  }

  moveFolder (id, parentId) {
    if (this.shared.isFolder(id)) {
      for (let p = parentId; p; p = this.shared.isFolder(p) ? this.shared.placeOf(p) : this.folders.get(p)?.parentId) if (p === id) return false
      this.moveFile(id, parentId)
      return true
    }
    if (parentId && this.shared.isFolder(parentId)) throw new Error('Share this folder first: only shared folders go inside a shared folder.')
    const f = this.folders.get(id)
    if (!f) return false
    const target = this.folders.has(parentId) ? parentId : null
    // Refuse to move a folder into itself or one of its own subfolders.
    for (let p = target; p; p = this.folders.get(p)?.parentId) if (p === id) return false
    this.folders.set(id, { ...f, parentId: target })
    this._changed()
    return true
  }
}
