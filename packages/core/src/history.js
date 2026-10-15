// Version history, kept on each computer for the files it has.
//
// A version is a checkpoint of the whole file. Checkpoints are stored as a
// chain: the first holds the full state, each later one only what changed
// since the one before (new content plus the delete set). Rebuilding version
// k merges checkpoints 0..k. Dropping a checkpoint from the middle merges it
// into the next one, so older history can be thinned without breaking the
// chain.
//
//   versions.json  { last: <encoded snapshot>, list: [{ id, at, by, kind, label }] }
//   v-<id>.bin     the change since the previous checkpoint
//
// Checkpoints record what this computer saw. Two collaborators' histories
// can differ in which moments they caught, never in what the file was.

import crypto from 'node:crypto'
import * as Y from 'yjs'

const KEEP_ALL_MS = 2 * 24 * 3600e3 // everything from the last two days
const DAILY_MS = 60 * 24 * 3600e3 // then one a day for two months, then one a week
const DAY = 24 * 3600e3

export class History {
  constructor (store) {
    this.store = store
  }

  _read (docId) {
    return this.store.readJSON(docId, 'versions') || { last: null, list: [] }
  }

  _write (docId, data) {
    this.store.writeJSON(docId, 'versions', data)
  }

  list (docId) {
    return this._read(docId).list.map((v) => ({ ...v }))
  }

  // Saves a checkpoint if the file changed since the last one. Returns the
  // new version, or null. `authorOf(clientId)` returns the userId who wrote
  // with that Yjs client, so a version can say whose edits it holds.
  record (docId, ydoc, { kind = 'auto', label = null, restoredFrom = null, authorOf = () => null, now = Date.now() } = {}) {
    const data = this._read(docId)
    const snap = Y.snapshot(ydoc)
    if (data.last && Y.equalSnapshots(snap, Y.decodeSnapshot(Buffer.from(data.last, 'base64')))) return null
    const full = Y.encodeStateAsUpdate(ydoc)
    const prevSV = data.last ? Y.decodeSnapshot(Buffer.from(data.last, 'base64')).sv : null
    const change = prevSV ? Y.diffUpdate(full, Y.encodeStateVector(prevSV)) : full
    const by = new Set()
    try {
      for (const s of Y.decodeUpdate(change).structs) {
        const who = authorOf(s.id.client)
        if (who) by.add(who)
      }
    } catch {}
    const version = { id: crypto.randomBytes(6).toString('hex'), at: now, by: [...by], kind, label, restoredFrom }
    this.store.writeBinary(docId, `v-${version.id}`, change)
    data.list.push(version)
    data.last = Buffer.from(Y.encodeSnapshot(snap)).toString('base64')
    this._thin(docId, data, now)
    this._write(docId, data)
    return version
  }

  // The file as it was at a version, as a Yjs update.
  load (docId, id) {
    const { list } = this._read(docId)
    const at = list.findIndex((v) => v.id === id)
    if (at < 0) return null
    const parts = []
    for (let i = 0; i <= at; i++) {
      const bytes = this.store.readBinary(docId, `v-${list[i].id}`)
      if (bytes) parts.push(bytes)
    }
    return Y.mergeUpdates(parts)
  }

  name (docId, id, label) {
    const data = this._read(docId)
    const v = data.list.find((x) => x.id === id)
    if (!v) return
    v.label = String(label || '').trim().slice(0, 80) || null
    this._write(docId, data)
  }

  // Keeps every checkpoint from the last two days, one per day for two
  // months, then one per week. Named versions and restore points stay.
  _thin (docId, data, now) {
    const keep = new Set()
    const seen = new Set()
    const list = data.list
    for (let i = list.length - 1; i >= 0; i--) {
      const v = list[i]
      const age = now - v.at
      const bucket = age < KEEP_ALL_MS ? `all:${v.id}` : age < DAILY_MS ? `d:${Math.floor(v.at / DAY)}` : `w:${Math.floor(v.at / (7 * DAY))}`
      if (i === list.length - 1 || v.label || v.kind !== 'auto' || !seen.has(bucket)) keep.add(v.id)
      seen.add(bucket)
    }
    for (let i = 0; i < list.length - 1; i++) {
      if (keep.has(list[i].id)) continue
      // Fold this checkpoint's change into the next one, then drop it.
      const mine = this.store.readBinary(docId, `v-${list[i].id}`)
      const next = this.store.readBinary(docId, `v-${list[i + 1].id}`)
      if (mine && next) this.store.writeBinary(docId, `v-${list[i + 1].id}`, Y.mergeUpdates([mine, next]))
      list[i + 1].by = [...new Set([...list[i].by, ...list[i + 1].by])]
      this.store.removeFile(docId, `v-${list[i].id}.bin`)
      list.splice(i, 1)
      i--
    }
  }
}

// Puts a file's content back to what `past` (a Y.Doc) shows, as an ordinary
// edit. `roots` names the app's content: [{ name, type: 'xml' | 'map' | 'array' }].
// The title comes back too; who has access and the file's history don't.
export function restoreContent (ydoc, past, roots) {
  const copy = (v) => (v instanceof Y.AbstractType ? v.clone() : v)
  for (const { name, type } of roots) {
    if (type === 'xml') {
      const to = ydoc.getXmlFragment(name)
      const from = past.getXmlFragment(name)
      if (to.length) to.delete(0, to.length)
      if (from.length) to.insert(0, from.toArray().map(copy))
    } else if (type === 'array') {
      const to = ydoc.getArray(name)
      const from = past.getArray(name)
      if (to.length) to.delete(0, to.length)
      if (from.length) to.insert(0, from.toArray().map(copy))
    } else {
      const to = ydoc.getMap(name)
      const from = past.getMap(name)
      for (const key of [...to.keys()]) if (!from.has(key)) to.delete(key)
      for (const [key, value] of from) to.set(key, copy(value))
    }
  }
  const title = past.getMap('meta').get('title')
  if (title != null) ydoc.getMap('meta').set('title', title)
}
