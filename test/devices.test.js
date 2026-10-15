// One person, several computers: linking, a shared Drive index, unlinking,
// and owner changes made on two computers at once.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { duplexPair } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive, sendDrive, receiveDrive, newMoveCode } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { loadOrCreateIdentity } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-devices-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (drive, docId) => docsApp.preview(drive.getDoc(docId).ydoc)

async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

function write (drive, docId, str) {
  const ydoc = drive.getDoc(docId).ydoc
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  ydoc.transact(() => {
    if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
    const t = frag.get(0).get(0)
    t.insert(t.length, str)
  }, 'renderer')
}

// Two engines joined by an in-memory stream (no network), with made-up
// connection keys so the signed hellos check out.
function connect (a, b) {
  const [x, y] = duplexPair()
  const ka = Buffer.alloc(32, 1).toString('hex')
  const kb = Buffer.alloc(32, 2).toString('hex')
  a.engine.addConnection(x, { localId: ka, remoteId: kb })
  b.engine.addConnection(y, { localId: kb, remoteId: ka })
  return () => { x.destroy(); y.destroy() }
}

test('a linked computer shares the Drive: new files, edits, removals and unlinking', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const laptopDir = tmp()
  const desktopDir = tmp()
  const laptop = new Drive({ dataDir: laptopDir, apps: [docsApp], swarm: swarm(), deviceName: 'Laptop' })
  laptop.setProfile({ name: 'Harviel' })
  await laptop.start()
  const before = await laptop.create('docs', 'Before linking')
  write(laptop, before, 'Written on the laptop.')

  const code = newMoveCode()
  await Promise.all([
    sendDrive({ code, drive: laptop, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } }),
    receiveDrive({ code, dataDir: desktopDir, isEmpty: () => true, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  ])
  const desktop = new Drive({ dataDir: desktopDir, apps: [docsApp], swarm: swarm(), deviceName: 'Desktop' })
  t.after(async () => { await laptop.stop(); await desktop.stop(); await testnet.destroy() })
  await desktop.start()
  assert.equal(desktop.identity.userId, laptop.identity.userId)
  assert.notEqual(desktop.device.id, laptop.device.id, 'each computer keeps its own id')
  assert.equal(text(desktop, before), 'Written on the laptop.')

  // Both computers list each other.
  await until(() => laptop.devices().some((d) => d.name === 'Desktop' && d.online), 20000, 'laptop to see the desktop')
  assert.deepEqual(desktop.devices().map((d) => d.name), ['Desktop', 'Laptop'])

  // A file made on one appears on the other, and edits flow both ways.
  const after = await desktop.create('docs', 'Made on the desktop')
  await until(() => laptop.describe(after)?.title === 'Made on the desktop', 20000, 'new file on the laptop')
  write(laptop, after, 'Edited on the laptop.')
  await until(() => text(desktop, after) === 'Edited on the laptop.', 20000, 'edit reaches the desktop')
  await until(() => desktop.describe(after).sync.devices.some((d) => d.name === 'Laptop'), 20000, 'desktop shows it syncs with the laptop')
  assert.equal(desktop.describe(after).role, 'owner')

  // Folders are shared too.
  const folder = laptop.createFolder('Taxes')
  await until(() => desktop.listFolders().some((f) => f.id === folder), 20000, 'folder on the desktop')

  // Removing a file removes it from both.
  await laptop.remove(before)
  await until(() => !desktop.describe(before) && !desktop.getDoc(before), 20000, 'removal on the desktop')

  // Unlinking asks the other computer to sign out.
  let signedOut = false
  desktop.on('unlinked', () => { signedOut = true })
  laptop.unlinkDevice(desktop.device.id)
  await until(() => signedOut, 20000, 'desktop to be told to sign out')
  assert.deepEqual(laptop.devices().map((d) => d.name), ['Laptop'])
})

test('owner changes made on two computers at once are both kept', async (t) => {
  const aDir = tmp()
  const a = new Drive({ dataDir: aDir, apps: [docsApp], transport: false, deviceName: 'A' })
  await a.start()
  const docId = await a.create('docs', 'Shared')
  const bob = loadOrCreateIdentity(path.join(tmp(), 'bob'))
  const carol = loadOrCreateIdentity(path.join(tmp(), 'carol'))
  const admit = (userId, enc) => { a.engine.getDoc(docId).members.admit(a.identity, { userId, role: 'editor', enc }); a.engine._membersChanged(a.engine.getDoc(docId)) }
  admit(bob.userId, bob.encPublic)
  admit(carol.userId, carol.encPublic)

  // Copy this Drive to computer B (as linking does), then let them sync.
  const bDir = tmp()
  fs.cpSync(aDir, bDir, { recursive: true })
  fs.rmSync(path.join(bDir, 'device.json'))
  const b = new Drive({ dataDir: bDir, apps: [docsApp], transport: false, deviceName: 'B' })
  t.after(async () => { await a.stop(); await b.stop() })
  await b.start()

  // Apart, each computer makes a different change to who has access.
  a.setMemberRole(docId, bob.userId, 'viewer')
  b.removeMember(docId, carol.userId)
  const disconnect = connect(a, b)
  t.after(disconnect)
  await until(() => {
    const ma = a.getDoc(docId).members
    const mb = b.getDoc(docId).members
    return ma.head.hash === mb.head.hash && ma.member(bob.userId)?.role === 'viewer' && !ma.member(carol.userId)
  }, 10000, 'both changes on both computers')
  assert.equal(b.getDoc(docId).members.member(bob.userId).role, 'viewer')
  assert.equal(b.getDoc(docId).members.isRemoved(carol.userId), true)
})
