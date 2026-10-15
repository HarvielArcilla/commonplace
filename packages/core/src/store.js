// Local, append-only persistence for Yjs documents.
//
// Each document gets a folder:
//   snapshot.bin  - the whole document state at the last compaction
//   updates.log   - length-prefixed Yjs updates appended since then
//   state.json    - small bookkeeping (sync status, which edits peers have)
//
// Appends are synchronous so an edit is on disk before we tell anyone about it.

import fs from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'

const COMPACT_AFTER = 500

export class FileStore {
  constructor (dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }

  _docDir (id) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error('bad document id')
    return path.join(this.dir, id)
  }

  has (id) {
    return fs.existsSync(this._docDir(id))
  }

  // Applies everything on disk to ydoc. Compacts if the log has grown long.
  load (id, ydoc) {
    const dir = this._docDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const snapshot = path.join(dir, 'snapshot.bin')
    const log = path.join(dir, 'updates.log')
    if (fs.existsSync(snapshot)) Y.applyUpdate(ydoc, fs.readFileSync(snapshot), 'disk')
    let count = 0
    if (fs.existsSync(log)) {
      const buf = fs.readFileSync(log)
      let off = 0
      while (off + 4 <= buf.length) {
        const len = buf.readUInt32BE(off)
        if (off + 4 + len > buf.length) break // torn final write; ignore it
        Y.applyUpdate(ydoc, buf.subarray(off + 4, off + 4 + len), 'disk')
        off += 4 + len
        count++
      }
    }
    if (count > COMPACT_AFTER) this.compact(id, ydoc)
    return count
  }

  append (id, update) {
    const header = Buffer.alloc(4)
    header.writeUInt32BE(update.length)
    fs.appendFileSync(path.join(this._docDir(id), 'updates.log'), Buffer.concat([header, Buffer.from(update)]))
  }

  compact (id, ydoc) {
    const dir = this._docDir(id)
    const tmp = path.join(dir, 'snapshot.bin.tmp')
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(ydoc))
    fs.renameSync(tmp, path.join(dir, 'snapshot.bin'))
    fs.writeFileSync(path.join(dir, 'updates.log'), Buffer.alloc(0))
  }

  readState (id) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._docDir(id), 'state.json'), 'utf8'))
    } catch {
      return null
    }
  }

  writeState (id, state) {
    const dir = this._docDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, 'state.json.tmp')
    fs.writeFileSync(tmp, JSON.stringify(state))
    fs.renameSync(tmp, path.join(dir, 'state.json'))
  }

  readJSON (id, name) {
    try {
      return JSON.parse(fs.readFileSync(path.join(this._docDir(id), `${name}.json`), 'utf8'))
    } catch {
      return null
    }
  }

  writeJSON (id, name, value) {
    const dir = this._docDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${name}.json.tmp`)
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(tmp, path.join(dir, `${name}.json`))
  }

  readBinary (id, name) {
    try { return new Uint8Array(fs.readFileSync(path.join(this._docDir(id), `${name}.bin`))) } catch { return null }
  }

  writeBinary (id, name, bytes) {
    const dir = this._docDir(id)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${name}.bin.tmp`)
    fs.writeFileSync(tmp, Buffer.from(bytes))
    fs.renameSync(tmp, path.join(dir, `${name}.bin`))
  }

  // Every file belonging to one document, for moving it to another computer.
  exportDoc (id) {
    const dir = this._docDir(id)
    const out = {}
    if (!fs.existsSync(dir)) return out
    for (const f of fs.readdirSync(dir)) if (!f.endsWith('.tmp')) out[f] = fs.readFileSync(path.join(dir, f)).toString('base64')
    return out
  }

  importDoc (id, files) {
    const dir = this._docDir(id)
    fs.mkdirSync(dir, { recursive: true })
    for (const [f, b64] of Object.entries(files)) {
      if (!/^[a-z0-9._-]+$/i.test(f)) continue
      fs.writeFileSync(path.join(dir, f), Buffer.from(b64, 'base64'))
    }
  }

  remove (id) {
    fs.rmSync(this._docDir(id), { recursive: true, force: true })
  }
}
