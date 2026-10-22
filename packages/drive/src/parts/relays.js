// Always-on relays: mine (for new files and my own computers) and each
// file's (listed in the file, so everyone working on it uses them). When
// this computer runs a relay itself, the Drive talks to it in memory
// rather than over the network.

import { duplexPair } from 'node:stream'
import { formatRelayAddress, parseRelayAddress, canEdit } from '@commonplace/core'

// Relays used to be called helpers; files and Drives made then keep their
// relay list under this name, so it stays.
export const RELAYS_MAP = 'helpers'

export class Relays {
  myRelays () {
    return [...this.myRelaysMap.keys()].map((key) => ({ key, address: formatRelayAddress(key), ...(this.relays?.status(this.indexId).find((h) => h.key === key) || {}) }))
  }

  // Adds a relay for my computers' Drive and for new files. `everywhere`
  // also adds it to every file I own now.
  addMyRelay (address, { everywhere = false } = {}) {
    const key = parseRelayAddress(address)
    if (!key) throw new Error('That isn\u2019t a relay address. It starts with cpr1.')
    this.myRelaysMap.set(key, { addedAt: Date.now() })
    if (everywhere) for (const f of this.list()) if (f.role === 'owner') this.addRelay(f.docId, address)
    return key
  }

  removeMyRelay (key) {
    this.myRelaysMap.delete(key)
  }

  // Relays for one file are part of the file, so everyone working on it
  // uses them.
  addRelay (docId, address) {
    const key = parseRelayAddress(address)
    if (!key) throw new Error('That isn\u2019t a relay address. It starts with cpr1.')
    const doc = this.engine.getDoc(docId)
    if (!doc || !canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can add a relay.')
    doc.ydoc.transact(() => doc.ydoc.getMap(RELAYS_MAP).set(key, { addedBy: this.identity.userId, at: Date.now() }), 'local')
    return key
  }

  removeRelay (docId, key) {
    const doc = this.engine.getDoc(docId)
    if (!doc || !canEdit(this.engine.access(docId)?.role)) throw new Error('Only people who can edit can remove a relay.')
    doc.ydoc.transact(() => doc.ydoc.getMap(RELAYS_MAP).delete(key), 'local')
  }

  // Tells the relay client which relays a file (or my index) uses.
  _applyRelays (docId) {
    if (this.files.get(docId)?.guest) { this.relays?.setRelays(docId, []); return } // guests sync only with the owner
    if (!this.relays) return
    if (docId === this.indexId) { this.relays.setRelays(docId, [...this.myRelaysMap.keys()]); return }
    const entry = this.files.get(docId)
    const doc = this.engine.getDoc(docId)
    if (!entry || !doc) return
    const keys = new Set([...doc.ydoc.getMap(RELAYS_MAP).keys(), ...(entry.inviteRelays || entry.inviteHelpers || [])])
    this.relays.setRelays(docId, this._shouldSync(entry) ? [...keys] : [])
  }

  // The relay running in this process (a RelayServer), or null to go back
  // to reaching it over the network.
  useLocalRelay (server) {
    const old = this.localRelay
    this.localRelay = server || null
    if (!this.relays) return
    if (old?.key && this.relays.isRelay(old.key) && old.key !== server?.key) {
      this.relays.links.get(old.key)?.socket.destroy()
      this.transport.joinPeer(Buffer.from(old.key, 'hex'))
    }
    if (server?.key && this.relays.isRelay(server.key)) {
      this.transport.leavePeer(Buffer.from(server.key, 'hex'))
      this.relays.links.get(server.key)?.socket.destroy()
      this._connectRelay(Buffer.from(server.key, 'hex'))
    }
  }

  _connectRelay (key) {
    const hex = key.toString('hex')
    if (this.localRelay?.key !== hex) { this.transport.joinPeer(key); return }
    const [mine, theirs] = duplexPair()
    mine.on('close', () => theirs.destroy())
    this.localRelay.accept(theirs)
    this.relays.addConnection(mine, hex)
  }

  _disconnectRelay (key) {
    if (this.localRelay?.key !== key.toString('hex')) this.transport.leavePeer(key)
  }
}
