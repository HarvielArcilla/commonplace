// Guests: people who can open a file only while its owner is online.
//
// A guest never gets the file's keys. Each guest link makes a *mirror*: a
// separate document with its own secret, own membership log and only two
// kinds of member, the owner and the one guest the link admits (links are
// single-use, so two guests never share a mirror and can't sync with each
// other). The owner's computers keep the mirror and the real file in step:
//
//   real file  --every change-->  mirror  --to the guest-->
//   mirror     <--guest's edits (if they may edit)--  guest
//   mirror     --accepted edits-->  real file  --to everyone else-->
//
// Both are copies of the same CRDT, so a change applies to either one as
// it is. Only the owner's computers hold the mirror besides the guest, and
// mirrors never use relays, so when none of the owner's computers is
// running the guest gets nothing new: "while I'm online" is enforced by
// where the data is, not by asking the guest's app nicely. Ending a
// guest's access removes them from the mirror (with a new key) and closes
// it. Nothing about the real file's keys or members changes, so nobody
// who should have the real file can lose it this way.
//
// The registry of mirrors is in my Drive index, so all of my computers
// serve my guests: index.getMap('guests'):
//   mirrorId -> { secret, source, role, after, createdAt, guest: { userId, name } | null, ended }

import crypto from 'node:crypto'
import * as Y from 'yjs'
import { deriveDocKeys, encodeInvite, GIVEN_ROLES } from '@commonplace/core'

const BRIDGE = 'guest-bridge'

export class Guests {
  constructor (drive) {
    this.drive = drive
    this.engine = drive.engine
    this.map = drive.index.getMap('guests')
    this.bridges = new Map() // mirrorId -> stop()
    this.map.observe(() => this.reconcile())
    this.engine.on('topics', (docId) => { if (this.map.has(docId)) this.drive._joinTopics(docId) })
    this.engine.on('members', (docId) => this._noteGuest(docId))
    this.engine.on('status', (status) => { if (status && this.map.has(status.docId)) this._noteGuest(status.docId) })
  }

  // A link for one guest. role: viewer, respondent or editor. after: what
  // their computer does with its copy whenever I'm offline, and when their
  // access ends ('keep' it read-only, or 'hide' it).
  createInvite (sourceId, role = 'viewer', { after = 'keep', expiresIn = null } = {}) {
    const entry = this.drive.files.get(sourceId)
    const source = this.engine.getDoc(sourceId)
    if (!entry || !source) throw new Error('This file is no longer in your Drive.')
    if (source.members.exists && source.members.owner !== this.drive.identity.userId) throw new Error('Only the owner can invite guests.')
    if (entry.type === 'folder') throw new Error('Shared folders can’t have guests. Invite them to a file instead.')
    const secret = crypto.randomBytes(32)
    const { docId: mirrorId } = deriveDocKeys(secret)
    this.map.set(mirrorId, {
      secret: secret.toString('base64'),
      source: sourceId,
      role: GIVEN_ROLES.includes(role) ? role : 'viewer',
      after: after === 'hide' ? 'hide' : 'keep',
      createdAt: Date.now(),
      guest: null,
      ended: false
    })
    this._open(mirrorId)
    this.engine.ensureMembership(mirrorId)
    const token = this.engine.createInvite(mirrorId, role, { once: true, guest: true, after, expiresAt: expiresIn ? Date.now() + expiresIn : null })
    return encodeInvite(secret, token)
  }

  // Ends a guest's access: out of the mirror (with a new key, and what
  // their computer should do with its copy), and the mirror closes.
  end (mirrorId) {
    const g = this.map.get(mirrorId)
    if (!g) return
    const doc = this.engine.getDoc(mirrorId)
    if (doc?.members.exists && g.guest?.userId && doc.members.member(g.guest.userId)) {
      try { this.engine.removeMember(mirrorId, g.guest.userId, { after: g.after }) } catch {}
    }
    this.map.delete(mirrorId)
  }

  // Guests of one of my files, for the Share dialog.
  list (sourceId) {
    const out = []
    for (const [mirrorId, g] of this.map) {
      if (g.source !== sourceId) continue
      const peers = this.engine.status(mirrorId)?.peers || []
      out.push({ mirrorId, role: g.role, after: g.after, createdAt: g.createdAt, guest: g.guest, online: Boolean(g.guest && peers.some((p) => p.userId === g.guest.userId)), waiting: !g.guest })
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  }

  isMirror (docId) { return this.map.has(docId) }

  // Opens every mirror whose file I have, and closes the rest.
  reconcile () {
    for (const [mirrorId, g] of this.map) {
      if (this.drive.files.has(g.source)) this._open(mirrorId)
    }
    for (const mirrorId of [...this.bridges.keys()]) {
      const g = this.map.get(mirrorId)
      if (!g || !this.drive.files.has(g.source)) this._close(mirrorId)
    }
  }

  // Ends every guest of a file (it left my Drive, or isn't mine any more).
  endAllFor (sourceId) {
    for (const [mirrorId, g] of [...this.map]) if (g.source === sourceId) this.end(mirrorId)
  }

  destroy () {
    for (const mirrorId of [...this.bridges.keys()]) this._close(mirrorId, { keepData: true })
  }

  // ---- the bridge ------------------------------------------------------------------

  _open (mirrorId) {
    const g = this.map.get(mirrorId)
    const source = g && this.engine.getDoc(g.source)
    if (!g || !source || this.bridges.has(mirrorId)) return this.engine.getDoc(mirrorId)
    const mirror = this.engine.openDoc(Buffer.from(g.secret, 'base64'), { active: true })
    // Catch up both ways: the file's changes to the mirror, and any edits a
    // guest made that reached the mirror but not the file.
    Y.applyUpdate(mirror.ydoc, Y.encodeStateAsUpdate(source.ydoc, Y.encodeStateVector(mirror.ydoc)), BRIDGE)
    Y.applyUpdate(source.ydoc, Y.encodeStateAsUpdate(mirror.ydoc, Y.encodeStateVector(source.ydoc)), BRIDGE)
    const toMirror = (update, origin) => { if (origin !== BRIDGE) Y.applyUpdate(mirror.ydoc, update, BRIDGE) }
    // Only what a guest sent (the engine applied it after checking their
    // role in the mirror) goes on to the real file.
    const toSource = (update, origin) => { if (origin && typeof origin === 'object' && origin !== BRIDGE) Y.applyUpdate(source.ydoc, update, BRIDGE) }
    source.ydoc.on('update', toMirror)
    mirror.ydoc.on('update', toSource)
    this.bridges.set(mirrorId, () => {
      source.ydoc.off('update', toMirror)
      mirror.ydoc.off('update', toSource)
    })
    this.drive._joinTopics(mirrorId)
    return mirror
  }

  _close (mirrorId, { keepData = false } = {}) {
    this.bridges.get(mirrorId)?.()
    this.bridges.delete(mirrorId)
    if (this.engine.getDoc(mirrorId)) this.engine.closeDoc(mirrorId, { deleteLocalData: !keepData })
    this.drive._leaveTopics(mirrorId)
  }

  // Remembers who used a guest link, once the owner's computer admits them.
  // (and their name, once their computer has said it).
  _noteGuest (mirrorId) {
    const g = this.map.get(mirrorId)
    const doc = g && this.engine.getDoc(mirrorId)
    if (!doc) return
    const guest = g.guest || doc.members.detailed().find((m) => m.userId !== doc.members.owner)
    if (!guest) return
    const name = this.engine.status(mirrorId)?.peers.find((p) => p.userId === guest.userId)?.name || g.guest?.name || 'Guest'
    if (g.guest?.userId !== guest.userId || g.guest?.name !== name) this.map.set(mirrorId, { ...g, guest: { userId: guest.userId, name } })
  }
}
