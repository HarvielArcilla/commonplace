// What happened that's for me: someone @-mentioned me, replied in a thread
// I'm part of, commented on a file I own, or a shared folder brought me a
// file. Kept on this computer only (activity.json), newest first, at most
// MAX_ITEMS. Old comments that arrive when a file first syncs aren't news.

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { readThreads, COMMENTS } from '@commonplace/core/threads'

const MAX_ITEMS = 300
const GRACE_MS = 60e3

export class Activity extends EventEmitter {
  constructor (drive) {
    super()
    this.drive = drive
    this.file = path.join(drive.dataDir, 'activity.json')
    let saved = {}
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')) } catch {}
    this.items = Array.isArray(saved.items) ? saved.items.slice(0, MAX_ITEMS) : []
    this.known = new Map() // docId -> Set(message id) already seen
    this.watching = new Map() // docId -> stop()
    this.timers = new Map()
  }

  get me () { return this.drive.identity.userId }

  watch (docId) {
    if (this.watching.has(docId)) return
    const doc = this.drive.engine.getDoc(docId)
    if (!doc) return
    this.known.set(docId, new Set(this._messages(doc.ydoc).map(({ m }) => m.id)))
    const map = doc.ydoc.getMap(COMMENTS)
    const onChange = () => {
      if (this.timers.has(docId)) return
      this.timers.set(docId, setTimeout(() => { this.timers.delete(docId); this._scan(docId) }, 250))
    }
    map.observeDeep(onChange)
    this.watching.set(docId, () => map.unobserveDeep(onChange))
  }

  unwatch (docId) {
    this.watching.get(docId)?.()
    this.watching.delete(docId)
    clearTimeout(this.timers.get(docId))
    this.timers.delete(docId)
    this.known.delete(docId)
    const before = this.items.length
    this.items = this.items.filter((i) => i.docId !== docId)
    if (this.items.length !== before) this._save()
  }

  _messages (ydoc) {
    const out = []
    for (const t of readThreads(ydoc)) for (const m of t.messages) if (typeof m.id === 'string') out.push({ t, m })
    return out
  }

  _scan (docId) {
    const doc = this.drive.engine.getDoc(docId)
    const entry = this.drive.files.get(docId)
    const known = this.known.get(docId)
    if (!doc || !entry || !known) return
    const people = doc.ydoc.getMap('people')
    const owner = this.drive.engine.access(docId)?.owner || entry.owner?.userId
    const fresh = []
    for (const { t, m } of this._messages(doc.ydoc)) {
      if (known.has(m.id)) continue
      known.add(m.id)
      if (m.userId === this.me || !(m.at > (entry.addedAt || 0) - GRACE_MS)) continue
      const mine = t.userId === this.me || t.messages.some((x) => x.userId === this.me && x.at <= m.at && x.id !== m.id)
      const kind = (m.mentions || []).includes(this.me) ? 'mention' : mine ? 'reply' : owner === this.me ? 'comment' : null
      if (!kind) continue
      fresh.push({
        id: `${docId}:${m.id}`,
        kind,
        docId,
        threadId: t.id,
        by: m.userId,
        byName: String(people.get(m.userId)?.name || entry.names?.[m.userId] || 'Someone').slice(0, 40),
        text: String(m.text || '').slice(0, 280),
        at: Math.min(Number(m.at) || Date.now(), Date.now()),
        read: false
      })
    }
    if (fresh.length) this._add(fresh)
  }

  // A shared folder brought me a file.
  shared (docId, folderId, by) {
    this._add([{ id: `${docId}:shared`, kind: 'shared', docId, folderId, by: by?.userId || null, byName: by?.name || null, at: Date.now(), read: false }])
  }

  _add (fresh) {
    const ids = new Set(fresh.map((i) => i.id))
    this.items = [...fresh, ...this.items.filter((i) => !ids.has(i.id))].sort((a, b) => b.at - a.at).slice(0, MAX_ITEMS)
    this._save()
    this.emit('new', fresh)
    this.drive._changed()
  }

  list () {
    return this.items
      .filter((i) => this.drive.files.has(i.docId))
      .map((i) => ({ ...i, title: this.drive.files.get(i.docId)?.title || 'Untitled', folderName: i.folderId ? this.drive.files.get(i.folderId)?.title || null : null }))
  }

  unread () { return this.list().filter((i) => !i.read).length }

  markRead (ids = null) {
    const set = ids ? new Set(ids) : null
    let changed = false
    for (const i of this.items) if (!i.read && (!set || set.has(i.id))) { i.read = true; changed = true }
    if (changed) { this._save(); this.drive._changed() }
  }

  _save () {
    try { fs.writeFileSync(this.file, JSON.stringify({ items: this.items })) } catch {}
  }

  destroy () {
    for (const stop of this.watching.values()) stop()
    for (const t of this.timers.values()) clearTimeout(t)
    this.watching.clear()
  }
}
