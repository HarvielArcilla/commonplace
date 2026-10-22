// Per-computer keys: with protection on, a lost computer is really cut off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive, sendDrive, receiveDrive, newMoveCode, Backups, readBackupFile, restoreBackup, newRecoveryKey } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { loadOrCreateIdentity, installIdentity, directory, Membership } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-computers-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const text = (drive, docId) => docsApp.preview(drive.getDoc(docId).ydoc)
function write (drive, docId, str) {
  const ydoc = drive.getDoc(docId).ydoc
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment(CONTENT_FIELD)
    if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
    const t = frag.get(0).get(0)
    t.insert(t.length, str)
  }, 'local')
}
// Another computer of the same person (before protection: a copy of the identity).
function sibling (identity) {
  const dir = tmp()
  installIdentity(dir, identity.exportBundle())
  return loadOrCreateIdentity(dir)
}

test('the list of computers: adding, removing (and what they added), new keys, and the recovery key', () => {
  const one = loadOrCreateIdentity(tmp())
  const two = sibling(one)
  const three = sibling(one)
  const rk = newRecoveryKey()
  one.protect(rk, [one.myDevice, two.myDevice])
  assert.equal(one.hasAccountKey, false, 'the account key is gone from this computer')
  let st = directory.state(one.userId)
  assert.deepEqual([...st.valid].sort(), [one.deviceId, two.deviceId].sort())

  // two adopts protection: drops its account key, signs as itself.
  two.adoptState()
  assert.equal(two.hasAccountKey, false)
  const proof = 'hello'
  assert.equal(two.sign(proof).length, 97)

  // two adds three; one removes two, keeping three.
  three.adoptState() // lists itself with the account key it still had
  assert.ok(directory.state(one.userId).valid.has(three.deviceId))
  one.removeDevice(two.deviceId, { keep: [three.deviceId] })
  st = directory.state(one.userId)
  assert.ok(!st.valid.has(two.deviceId))
  assert.ok(st.valid.has(three.deviceId))
  assert.equal(st.key.n, 1)
  assert.ok(st.key.grants[one.deviceId] && st.key.grants[three.deviceId] && !st.key.grants[two.deviceId], 'the new key goes to the computers still in')
  three.adoptState()
  assert.equal(three.encPublic, one.encPublic, 'both computers left have the new key')
  assert.notEqual(two.encPublic, one.encPublic)

  // What the removed computer signs no longer counts.
  const m = Membership.create(one, 'doc-x')
  const signedByTwo = two.sign('anything')
  assert.equal(directory.state(one.userId).revoked.has(two.deviceId), true)
  assert.ok(signedByTwo)
  assert.throws(() => m.append(two, { type: 'revoke-invites' }), /removed computer|bad signature/)

  // A thief on `three` removes `one`: both removals stand, so nothing is
  // left; the recovery key starts a new list.
  three.removeDevice(one.deviceId)
  directory.merge(one.userId, [one.statement({ t: 'revoke', gen: 1, dev: three.deviceId })])
  assert.equal(directory.state(one.userId).valid.size, 0)
  assert.throws(() => one.resetWithRecovery(newRecoveryKey()), /doesn’t match/)
  one.resetWithRecovery(rk)
  st = directory.state(one.userId)
  assert.equal(st.gen, 2)
  assert.deepEqual([...st.valid], [one.deviceId])
})

test('removing a lost computer: everyone stops trusting it, and files move to keys it doesn’t get', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const opts = { apps: [docsApp], lan: false }
  const laptop = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts, deviceName: 'Laptop' })
  const bob = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  const drives = [laptop, bob]
  t.after(async () => { for (const d of drives) await d.stop().catch(() => {}); await testnet.destroy() })
  laptop.setProfile({ name: 'Alice' })
  bob.setProfile({ name: 'Bob' })
  await laptop.start()
  await bob.start()

  // A desktop of Alice's, linked from the laptop.
  const deskDir = tmp()
  const code = newMoveCode()
  await Promise.all([
    sendDrive({ code, drive: laptop, swarm: swarm(), leaving: false }),
    receiveDrive({ code, dataDir: deskDir, isEmpty: () => true, swarm: swarm(), deviceName: 'Desktop' })
  ])
  const desk = new Drive({ dataDir: deskDir, swarm: swarm(), ...opts, deviceName: 'Desktop' })
  drives.push(desk)
  await desk.start()
  await until(() => laptop.devices().length === 2, 30000, 'the laptop to see the desktop')

  // Alice's file, shared with Bob; Bob's file, shared with Alice.
  const mine = await desk.create('docs', 'Alice’s plan')
  write(desk, mine, 'Plan.')
  await bob.join(desk.invite(mine, 'editor'))
  const his = await bob.create('docs', 'Bob’s notes')
  write(bob, his, 'Notes.')
  await laptop.join(bob.invite(his, 'editor'))
  await until(() => text(bob, mine) === 'Plan.' && laptop.getDoc(his) && text(laptop, his) === 'Notes.' && desk.getDoc(his) && text(desk, his) === 'Notes.', 30000, 'everything to sync')

  // Protection on, from the desktop, with a backup's recovery key.
  const backups = new Backups({ drive: desk, dataDir: deskDir })
  t.after(() => backups.destroy())
  const { recoveryKey, path: backupFile } = backups.create(path.join(tmp(), 'alice.cpbackup'))
  desk.protect(recoveryKey)
  await until(() => !laptop.identity.hasAccountKey, 30000, 'the laptop to take up protection')
  assert.equal(directory.state(desk.identity.userId).valid.size, 2)

  // The laptop is lost. The desktop removes it.
  const laptopId = laptop.devices().find((d) => d.thisComputer).id
  desk.removeComputer(laptopId)
  await until(() => desk.identity.encKeyNumber === 1, 10000, 'a new encryption key')
  await until(() => desk.getDoc(mine).members.epoch >= 1, 20000, 'Alice’s own file to move to a new key')
  await until(() => bob.getDoc(his).members.epoch >= 1, 30000, 'Bob’s computer to move his file to a new key')

  // New edits reach Bob and the desktop, never the laptop.
  write(bob, his, ' After.')
  write(desk, mine, ' After.')
  await until(() => text(desk, his) === 'Notes. After.' && text(bob, mine) === 'Plan. After.', 30000, 'new edits between the desktop and Bob')
  await sleep(2000)
  assert.equal(text(laptop, his), 'Notes.')
  assert.equal(text(laptop, mine), 'Plan.')
  assert.ok(laptop.removedHere, 'the laptop knows (if it’s honest)')

  // A new computer from the backup: the recovery key lists it, and it gets
  // the newest key from the desktop.
  const freshDir = tmp()
  const { payload } = readBackupFile(backupFile, recoveryKey)
  await restoreBackup({ payload, dataDir: freshDir, recoveryKey })
  const fresh = new Drive({ dataDir: freshDir, swarm: swarm(), ...opts })
  drives.push(fresh)
  await fresh.start()
  await until(() => fresh.identity.encKeyNumber === 1, 30000, 'the restored computer to get the newest key')
  await until(() => fresh.getDoc(his) && text(fresh, his) === 'Notes. After.', 30000, 'the restored computer to sync')
})
