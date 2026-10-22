// My computers, and protection (see core/devices.js and core/identity.js):
// turning it on with the recovery key, removing a lost one for real, starting over with the recovery key, and
// keeping the Drive index on my newest key.
//
// Before protection, "Remove" only asks the other computer to sign out (it
// holds the account key, so nothing stronger is possible). After it, a
// removed computer's signatures stop counting everywhere, my encryption key
// and Drive index move to new keys it doesn't get, and the files I manage
// move to new keys too. A computer that learns it was removed doesn't wipe
// itself (a thief could use that against me); it says so and offers the
// recovery key or signing out.

import fs from 'node:fs'
import { directory } from '@commonplace/core'

export class Computers {
  _watchComputers () {
    this._onUsers = () => this._saveUsersSoon()
    directory.on('change', this._onUsers)
    this.engine.on('identity', (r) => this._identityChanged(r))
    this._useNewestIndexKey()
    // Protection may have been turned on while this computer was off.
    setImmediate(() => { if (!this.stopped) this._identityChanged(this.identity.adoptState()) })
  }

  _stopWatchingComputers () {
    directory.off('change', this._onUsers)
    clearTimeout(this._usersTimer)
    this._saveUsers()
  }

  _saveUsersSoon () {
    clearTimeout(this._usersTimer)
    this._usersTimer = setTimeout(() => this._saveUsers(), 1000)
    this._usersTimer.unref?.()
  }

  _saveUsers () {
    try { fs.writeFileSync(this._usersFile, JSON.stringify(directory.dump())) } catch {}
  }

  _identityChanged (r) {
    if (r.removed && !this.removedHere) {
      this.removedHere = true
      this.emit('removed')
    }
    // Computers of mine that joined the list without my newest key get it.
    if (r.valid && this.identity.shareEncryptionKey()) this.engine.announce()
    this._useNewestIndexKey()
    this._changed()
  }

  // The index moves to each new encryption key of mine (the older keys only
  // meet computers of mine that haven't heard yet).
  _useNewestIndexKey () {
    for (let n = 1; n <= this.identity.encKeyNumber; n++) {
      try { this.engine.setPrivateKey(this.indexId, n, this.identity.driveSecret(n)) } catch {}
    }
  }

  // { on, canTurnOn, removedHere, unconfirmed }
  protection () {
    const st = directory.state(this.identity.userId)
    return {
      on: this.identity.isProtected,
      // Only a computer that still has the account key can turn it on.
      canTurnOn: !this.identity.isProtected && this.identity.hasAccountKey,
      removedHere: Boolean(this.removedHere),
      confirmedHere: Boolean(st?.valid.has(this.identity.deviceId))
    }
  }

  // How each of my computers stands: 'confirmed', 'unconfirmed' (protection
  // is on and it hasn't joined the list yet: it does by itself when it next
  // runs), 'removed', or null (protection is off).
  _computerStatus (entry) {
    const st = directory.state(this.identity.userId)
    if (!st || !entry?.key) return st ? 'unconfirmed' : null
    if (st.valid.has(entry.key.id)) return 'confirmed'
    return st.revoked.has(entry.key.id) ? 'removed' : 'unconfirmed'
  }

  // Turns protection on, with the recovery key just made or typed in. Every
  // computer of mine that has reported its key is listed now; others list
  // themselves when they next run (they still hold the account key).
  protect (recoveryKey) {
    const devices = [...this.devicesMap.values()]
      .filter((d) => d && !d.unlinked && d.key)
      .map((d) => ({ id: d.key.id, enc: d.key.enc, name: d.name || undefined }))
    this.identity.protect(recoveryKey, devices)
    this.index.getMap('account').set('sealed', this.identity.accountSealed)
    this.engine.announce()
    this._changed()
    return this.protection()
  }

  // Removes one of my computers. With protection on, for real: everything
  // it signs stops counting, and it gets none of the new keys.
  removeComputer (id) {
    if (id === this.device.id) throw new Error('To stop using this computer, remove it from another one, or move your Drive.')
    const d = this.devicesMap.get(id)
    if (this.identity.isProtected && d?.key) {
      const st = directory.state(this.identity.userId)
      // The others stay, including any the removed one had added.
      const keep = [...this.devicesMap.entries()]
        .filter(([other, x]) => other !== id && x && !x.unlinked && x.key && st?.devices.has(x.key.id) && !st.revoked.has(x.key.id))
        .map(([, x]) => x.key.id)
      this.identity.removeDevice(d.key.id, { keep })
      this.engine.announce()
    }
    this.unlinkDevice(id)
    this._changed()
  }

  // This computer is moving its Drive to another and leaves my list.
  leaveList () {
    const st = directory.state(this.identity.userId)
    if (!st?.valid.has(this.identity.deviceId)) return
    this.removedHere = true // (on purpose: nothing to tell anyone)
    directory.merge(this.identity.userId, [this.identity.statement({ t: 'revoke', gen: st.gen, dev: this.identity.deviceId })])
    this.engine.announce()
  }

  // Takes my account back with the recovery key: this computer starts a new
  // list on its own (my other computers are confirmed again from here).
  recover (recoveryKey) {
    this.identity.rememberSealedAccount(this.index.getMap('account').get('sealed'))
    this.identity.resetWithRecovery(recoveryKey)
    this.removedHere = false
    const me = this.devicesMap.get(this.device.id)
    if (me?.unlinked) this.devicesMap.set(this.device.id, { ...me, unlinked: false, unlinkedAt: null })
    this.engine.announce()
    this._changed()
    return this.protection()
  }
}
