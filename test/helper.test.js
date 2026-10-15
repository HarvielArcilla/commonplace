// The always-on helper: files sync between people who are never online at
// the same time, and the helper can't read or forge anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive } from '@commonplace/drive'
import { HelperServer } from '@commonplace/helper'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-helper-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const text = (drive, docId) => docsApp.preview(drive.getDoc(docId).ydoc)
function write (drive, docId, str) {
  const ydoc = drive.getDoc(docId).ydoc
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  ydoc.transact(() => {
    if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
    const t = frag.get(0).get(0)
    t.insert(t.length, str)
  }, 'renderer')
}
const allBytes = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f)).filter((f) => fs.statSync(f).isFile()).map((f) => fs.readFileSync(f).toString('latin1')).join('')

test('people who are never online together sync through a helper that can’t read', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const helperDir = tmp()
  const helper = new HelperServer({ dir: helperDir, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await helper.start()
  const aliceDir = tmp()
  const opts = { apps: [docsApp], lan: false }
  let alice = new Drive({ dataDir: aliceDir, swarm: swarm(), ...opts })
  const bob = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  t.after(async () => { await alice.stop(); await bob.stop(); await helper.stop(); await testnet.destroy() })
  alice.setProfile({ name: 'Alice' })
  bob.setProfile({ name: 'Bob' })
  await alice.start()
  await bob.start()

  // Alice's helper keeps every new file she makes.
  alice.addMyHelper(address)
  const docId = await alice.create('docs', 'Field journal')
  write(alice, docId, 'Secret heron count: 14.')
  await until(() => alice.describe(docId).sync.helpers[0]?.online, 20000, 'alice connected to the helper')
  await until(() => allBytes(helperDir).length > 2000, 20000, 'the helper to hold a copy')
  const link = alice.invite(docId, 'editor')
  await alice.stop()

  // Bob joins while Alice is offline and gets the file from the helper.
  await bob.join(link)
  await until(() => text(bob, docId) === 'Secret heron count: 14.', 30000, 'bob to get the file from the helper')
  assert.equal(bob.describe(docId).title, 'Field journal')
  write(bob, docId, ' Bob saw two more.')
  await until(() => bob.describe(docId).sync.helpers[0]?.lastSyncedAt, 20000, 'bob to reach the helper')
  await sleep(500)
  await bob.stop()

  // Alice comes back after Bob has left, and gets his edit.
  alice = new Drive({ dataDir: aliceDir, swarm: swarm(), ...opts })
  await alice.start()
  await until(() => text(alice, docId) === 'Secret heron count: 14. Bob saw two more.', 30000, 'alice to get bob’s edit')

  // Nothing on the helper's disk is readable.
  const stored = allBytes(helperDir)
  for (const secret of ['heron', 'Field journal', 'Alice', 'Bob saw']) assert.ok(!stored.includes(secret), `helper storage contains "${secret}"`)
})

test('a helper keeps only one blob per file after compacting, and rejects writes without the box key', async (t) => {
  const testnet = await createTestnet(3)
  const helperDir = tmp()
  const helper = new HelperServer({ dir: helperDir, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await helper.start()
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 } })
  t.after(async () => { await alice.stop(); await helper.stop(); await testnet.destroy() })
  await alice.start()
  alice.helpers.compactAfter = 5
  alice.addMyHelper(address)
  const docId = await alice.create('docs', 'Many edits')
  await until(() => alice.describe(docId).sync.helpers[0]?.online, 20000, 'connected')
  for (let i = 0; i < 12; i++) { write(alice, docId, `${i} `); await sleep(30) }
  await sleep(500)
  // Reconnecting catches up, sees a long box, and rewrites it as one.
  for (const link of alice.helpers.links.values()) link.socket.destroy()
  await until(() => [...helper.boxes.values()].some((b) => b.count <= 3 && b.last >= 12), 20000, 'compaction')

  // A put signed with the wrong key is refused.
  const [box] = [...helper.boxes.keys()]
  const before = helper.boxes.get(box).last
  assert.throws(() => helper._onMessage({ send: () => {} }, { t: 'put', box, sig: Buffer.alloc(64).toString('base64'), id: 'x' }, Buffer.from('junk')), /bad signature/)
  assert.equal(helper.boxes.get(box).last, before)
})

test('edits from a viewer that arrive through a helper are ignored', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const helper = new HelperServer({ dir: tmp(), swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await helper.start()
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: swarm() })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: swarm() })
  t.after(async () => { await alice.stop(); await bob.stop(); await helper.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()
  alice.addMyHelper(address)
  const docId = await alice.create('docs', 'Policy')
  write(alice, docId, 'Version one.')
  await bob.join(alice.invite(docId, 'viewer'))
  await until(() => text(bob, docId) === 'Version one.' && bob.describe(docId).access.role === 'viewer' && !bob.describe(docId).access.pending, 20000, 'viewer synced')
  await until(() => bob.describe(docId).sync.helpers[0]?.online, 20000, 'viewer connected to the helper')

  // A tampered viewer writes straight to the helper, and cuts the direct link.
  for (const c of [...bob.engine.connections]) c.destroy()
  bob.engine.setActive(docId, false)
  bob.helpers._mayWrite = () => true
  const doc = bob.getDoc(docId)
  const state = [...[...bob.helpers.links.values()][0].boxes.values()][0]
  const p = new Y.Doc()
  Y.applyUpdate(p, Y.encodeStateAsUpdate(doc.ydoc))
  const before = Y.encodeStateVector(p)
  p.getXmlFragment(CONTENT_FIELD).get(0).get(0).insert(0, 'Forged. ')
  bob.helpers._put([...bob.helpers.links.values()][0], doc, state, 'u', Buffer.from(Y.encodeStateAsUpdate(p, before)))
  await sleep(1500)
  assert.equal(text(alice, docId), 'Version one.')
})
