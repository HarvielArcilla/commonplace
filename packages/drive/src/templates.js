// Templates: the ready-made ones each app offers (app.templates, built in
// code, the same on every computer), and your own, saved from a file. Your
// templates are a snapshot of the file's content (no title, people,
// comments or history) kept on this computer in templates/.

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as Y from 'yjs'
import { restoreContent } from '@commonplace/core'

const MAX_MINE = 200
const MAX_BYTES = 20 * 1024 * 1024

export class Templates {
  constructor (drive) {
    this.drive = drive
    this.dir = path.join(drive.dataDir, 'templates')
    this.indexFile = path.join(this.dir, 'index.json')
    this.samples = new Map() // template id -> { preview, thumb }
  }

  _mine () {
    try { return JSON.parse(fs.readFileSync(this.indexFile, 'utf8')).filter((t) => t && /^[0-9a-f]{16}$/.test(t.id)) } catch { return [] }
  }

  _saveIndex (list) {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(this.indexFile, JSON.stringify(list, null, 2))
  }

  // Every template, with a preview made from a sample copy.
  list () {
    const out = []
    for (const app of this.drive.appsByType.values()) {
      if (app.hidden) continue
      for (const t of app.templates || []) out.push({ id: t.id, type: app.type, kind: app.kind, appName: app.name, name: t.name, description: t.description, mine: false, ...this._sample(t.id, app, (y) => t.build(y)) })
    }
    for (const t of this._mine()) {
      const app = this.drive.appsByType.get(t.type)
      if (!app) continue
      out.push({ id: t.id, type: t.type, kind: app.kind, appName: app.name, name: t.name, description: t.description || '', mine: true, at: t.at, ...this._sample(t.id, app, (y) => this._load(t.id, y, app)) })
    }
    return out
  }

  _sample (id, app, build) {
    if (!this.samples.has(id)) {
      const ydoc = new Y.Doc()
      let sample = { preview: '', thumb: null }
      try {
        build(ydoc)
        sample = { preview: safe(() => app.preview?.(ydoc), ''), thumb: safe(() => app.thumbnail?.(ydoc), null) }
      } catch {}
      ydoc.destroy()
      this.samples.set(id, sample)
    }
    return this.samples.get(id)
  }

  _find (id) {
    for (const app of this.drive.appsByType.values()) {
      const t = (app.templates || []).find((x) => x.id === id)
      if (t) return { app, build: (ydoc) => t.build(ydoc), name: t.name }
    }
    const mine = this._mine().find((t) => t.id === id)
    const app = mine && this.drive.appsByType.get(mine.type)
    return app ? { app, build: (ydoc) => this._load(id, ydoc, app), name: mine.name } : null
  }

  _load (id, ydoc, app) {
    const snap = new Y.Doc()
    try {
      Y.applyUpdate(snap, fs.readFileSync(path.join(this.dir, `${id}.bin`)))
      ydoc.transact(() => restoreContent(ydoc, snap, app.history.roots))
    } finally { snap.destroy() }
  }

  // A new file from a template, named after it unless told otherwise.
  async create (id, { title = null, folderId = null } = {}) {
    const t = this._find(id)
    if (!t) throw new Error('That template is gone.')
    return this.drive.create(t.app.type, title || t.name, { folderId, build: t.build })
  }

  // Saves a file's content as one of my templates.
  save (docId, { name, description = '' }) {
    const entry = this.drive.files.get(docId)
    const doc = this.drive.engine.getDoc(docId)
    const app = entry && this.drive.appsByType.get(entry.type)
    if (!doc || !app?.history?.roots?.length || app.hidden) throw new Error('This kind of file can’t be a template.')
    const mine = this._mine()
    if (mine.length >= MAX_MINE) throw new Error(`You can keep up to ${MAX_MINE} templates. Delete one first.`)
    const snap = new Y.Doc()
    restoreContent(snap, doc.ydoc, app.history.roots)
    snap.getMap('meta').delete('title')
    const bytes = Y.encodeStateAsUpdate(snap)
    snap.destroy()
    if (bytes.length > MAX_BYTES) throw new Error('This file is too big to be a template.')
    const id = randomBytes(8).toString('hex')
    fs.mkdirSync(this.dir, { recursive: true })
    fs.writeFileSync(path.join(this.dir, `${id}.bin`), bytes)
    this._saveIndex([...mine, { id, type: entry.type, name: String(name || entry.title || 'Template').slice(0, 80), description: String(description).slice(0, 200), at: Date.now() }])
    return id
  }

  remove (id) {
    const mine = this._mine()
    if (!mine.some((t) => t.id === id)) return
    this._saveIndex(mine.filter((t) => t.id !== id))
    fs.rmSync(path.join(this.dir, `${id}.bin`), { force: true })
    this.samples.delete(id)
  }
}

function safe (fn, fallback) {
  try { return fn() ?? fallback } catch { return fallback }
}
