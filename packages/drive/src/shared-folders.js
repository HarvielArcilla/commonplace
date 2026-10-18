// Shared folders. A shared folder is a document like any other (type
// 'folder', with its own members, invite links and key), whose `items` map
// lists what's in it: for each file, its id and root secret.
//
//   - Everyone in the folder gets each file in it: their Drive joins it from
//     the secret, and the file's owner adds them to the file's own log (an
//     ordinary signed `add`, marked with the folder's id). Folder editors can
//     edit the files; folder viewers can view them (and answer forms).
//   - Only the file's owner can do that, so a file goes in a shared folder
//     only if you own it, or its owner is in the folder too. Their app does
//     the adding whenever it runs; nobody needs to be online at once, and
//     the add entries reach people through anyone who has the file.
//   - When someone leaves the folder, or a file is taken out of it, the
//     file's owner removes the people who had it only through the folder,
//     which moves the file to a new key, as any removal does. People given
//     access directly keep it.
//   - Shared folders can hold shared folders; access flows down the same way.
//
// For the person receiving, what arrives is bounded like everything else:
// at most MAX_ITEMS files per folder, the size guard on each document, and
// the download rules for uploaded files (drive/files.js). A file you never
// opened that leaves the folder leaves your Drive too.

import { deriveDocKeys } from '@commonplace/core'

export const ITEMS = 'items'
export const MAX_ITEMS = 1000
const HEX32 = /^[0-9a-f]{32}$/

export const folderApp = {
  type: 'folder',
  kind: 'folder',
  name: 'Shared folder',
  description: 'A folder everyone in it can see.',
  hidden: true, // made from the Drive, not opened like a file
  schemaVersion: 1,
  exports: [],
  initContent () {},
  preview (ydoc) {
    const n = folderItems(ydoc).size
    return n === 1 ? '1 item' : `${n} items`
  },
  thumbnail () { return null },
  history: { roots: [{ name: ITEMS, type: 'map' }] }
}

// What a folder holds, checked: the secret must really be that file's.
export function folderItems (ydoc) {
  const out = new Map()
  for (const [docId, it] of ydoc.getMap(ITEMS).entries()) {
    if (out.size >= MAX_ITEMS) break
    if (!HEX32.test(docId) || !it || typeof it.secret !== 'string') continue
    let secret
    try { secret = Buffer.from(it.secret, 'base64') } catch { continue }
    if (secret.length !== 32 || deriveDocKeys(secret).docId !== docId) continue
    out.set(docId, {
      secret: it.secret,
      type: typeof it.type === 'string' ? it.type.slice(0, 40) : null,
      title: typeof it.title === 'string' ? it.title.slice(0, 200) : null,
      owner: typeof it.owner === 'string' && /^[0-9a-f]{64}$/.test(it.owner) ? it.owner : null,
      ownerName: typeof it.ownerName === 'string' ? it.ownerName.slice(0, 40) : null,
      by: typeof it.by === 'string' ? it.by : null,
      at: Number(it.at) || 0
    })
  }
  return out
}

const RANK = { viewer: 0, respondent: 1, editor: 2, owner: 3 }
const canEdit = (role) => role === 'editor' || role === 'owner'

// The role a folder member gets on a file in it.
const roleIn = (folderRole, type) => canEdit(folderRole) ? 'editor' : type === 'form' ? 'respondent' : 'viewer'

export class SharedFolders {
  constructor (drive) {
    this.drive = drive
    this.timer = null
  }

  get engine () { return this.drive.engine }
  get me () { return this.drive.identity.userId }

  isFolder (docId) { return this.drive.files.get(docId)?.type === 'folder' }

  folders () { return [...this.drive.files.values()].filter((e) => e.type === 'folder') }

  items (folderId) {
    const doc = this.engine.getDoc(folderId)
    return doc ? folderItems(doc.ydoc) : new Map()
  }

  roleIn (folderId) { return this.engine.access(folderId)?.role || null }

  // childId -> [folderId, ...]: which of my shared folders hold each file.
  containers () {
    const map = new Map()
    for (const f of this.folders()) {
      for (const childId of this.items(f.docId).keys()) {
        if (childId === f.docId) continue
        if (!map.has(childId)) map.set(childId, [])
        map.get(childId).push(f.docId)
      }
    }
    return map
  }

  // Where a file shows: the shared folder holding it (the one I got it
  // through, if several), else wherever I put it myself.
  placeOf (docId, containers = this.containers()) {
    const entry = this.drive.files.get(docId)
    const holders = containers.get(docId) || []
    if (holders.length) return holders.includes(entry?.viaFolder) ? entry.viaFolder : holders[0]
    const own = entry?.folderId
    return own && (this.drive.folders.has(own) || this.isFolder(own)) && own !== docId ? own : null
  }

  // ---- changing what's in a folder ---------------------------------------------

  // Puts a file of mine (or of someone also in the folder) into it.
  add (folderId, docId) {
    const fdoc = this.engine.getDoc(folderId)
    const entry = this.drive.files.get(docId)
    if (!fdoc || !entry) throw new Error('No such file.')
    if (!canEdit(this.roleIn(folderId))) throw new Error('You can only view this folder, so you can’t add to it.')
    if (folderId === docId || this._within(docId, folderId)) throw new Error('A folder can’t go inside itself.')
    const owner = this.engine.access(docId)?.owner || entry.owner?.userId
    const ownerInFolder = owner === this.me || this.engine.membersDetailed(folderId).some((m) => m.userId === owner)
    if (!ownerInFolder) {
      const err = new Error(`Only ${entry.owner?.name || 'its owner'} can share this file, so it’s in this folder for you only.`)
      err.localOnly = true
      throw err
    }
    if (fdoc.ydoc.getMap(ITEMS).size >= MAX_ITEMS && !fdoc.ydoc.getMap(ITEMS).has(docId)) throw new Error(`A shared folder holds up to ${MAX_ITEMS} items.`)
    fdoc.ydoc.transact(() => fdoc.ydoc.getMap(ITEMS).set(docId, {
      secret: entry.secret,
      type: entry.type,
      title: entry.title,
      owner,
      ownerName: owner === this.me ? this.drive.identity.name : entry.owner?.name || null,
      by: this.me,
      at: Date.now()
    }), 'local')
    this.soon()
  }

  remove (folderId, docId) {
    const fdoc = this.engine.getDoc(folderId)
    if (!fdoc || !fdoc.ydoc.getMap(ITEMS).has(docId)) return
    if (!canEdit(this.roleIn(folderId))) throw new Error('You can only view this folder, so you can’t take things out of it.')
    fdoc.ydoc.transact(() => fdoc.ydoc.getMap(ITEMS).delete(docId), 'local')
    this.soon()
  }

  // Is `docId` (a folder) somewhere inside `folderId`'s contents, or the same?
  _within (folderId, target) {
    const seen = new Set()
    const walk = (id) => {
      if (id === target) return true
      if (seen.has(id) || !this.isFolder(id)) return false
      seen.add(id)
      for (const child of this.items(id).keys()) if (walk(child)) return true
      return false
    }
    return walk(folderId)
  }

  // ---- keeping everyone's access in step -------------------------------------------

  soon () {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.reconcile() }, 300)
    this.timer.unref?.()
  }

  destroy () { clearTimeout(this.timer) }

  reconcile () {
    const containers = this.containers()
    this._joinNew()
    this._grantAccess(containers)
    this._dropGone(containers)
    this.drive._changed()
  }

  // Files in my folders that I don't have yet: join them by their secret.
  // The owner's log decides whether anything arrives.
  _joinNew () {
    for (const f of this.folders()) {
      if (!this.roleIn(f.docId)) continue
      for (const [childId, it] of this.items(f.docId)) {
        if (this.drive.files.has(childId) || childId === this.drive.indexId || this.drive.dismissed.has(childId)) continue
        this.drive._joinFromFolder(childId, it, f.docId)
      }
    }
  }

  // As the owner of files in shared folders: the folders' people get them.
  _grantAccess (containers) {
    for (const entry of this.drive.files.values()) {
      const doc = this.engine.getDoc(entry.docId)
      if (!doc?.members.exists || doc.members.owner !== this.me) continue
      const want = new Map() // userId -> { role, enc, folder }
      for (const folderId of containers.get(entry.docId) || []) {
        if (!this.engine.getDoc(folderId)?.members.exists) continue
        for (const m of this.engine.membersDetailed(folderId)) {
          if (m.userId === this.me || !m.enc) continue
          const role = roleIn(m.role, entry.type)
          const cur = want.get(m.userId)
          if (!cur || RANK[role] > RANK[cur.role]) want.set(m.userId, { role, enc: m.enc, folder: folderId })
        }
      }
      const have = new Map(this.engine.membersDetailed(entry.docId).map((m) => [m.userId, m]))
      // A folder whose log hasn't arrived yet can't say who left it.
      const unsure = (containers.get(entry.docId) || []).some((id) => !this.engine.getDoc(id)?.members.exists)
      try {
        for (const [userId, w] of want) {
          const cur = have.get(userId)
          if (!cur) this.engine.addMember(entry.docId, { userId, role: w.role, enc: w.enc, folder: w.folder })
          else if (cur.role === 'owner') continue
          else if (RANK[w.role] > RANK[cur.role] || (cur.folder && RANK[w.role] < RANK[cur.role])) this.engine.setRole(entry.docId, userId, w.role)
        }
        // People who had it only through a folder that no longer gives it.
        for (const [userId, cur] of have) {
          if (cur.folder && cur.role !== 'owner' && !want.has(userId) && !unsure) this.engine.removeMember(entry.docId, userId)
        }
      } catch (err) { this.drive.emit('error', err) }
    }
  }

  // Files I got through a folder that left it (or that I left), and that I
  // never opened or changed: they leave my Drive too.
  _dropGone (containers) {
    for (const entry of [...this.drive.files.values()]) {
      if (!entry.viaFolder || containers.has(entry.docId)) continue
      if (entry.owner?.userId === this.me || entry.lastOpenedAt || entry.contributed) {
        this.drive._patch(entry.docId, { viaFolder: null })
        continue
      }
      this.drive.remove(entry.docId)
    }
  }
}
