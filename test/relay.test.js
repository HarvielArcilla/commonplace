// The always-on relay: files sync between people who are never online at
// the same time, and the relay can't read or forge anything.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive } from '@commonplace/drive'
import { RelayServer } from '@commonplace/relay'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-relay-'))
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

test('people who are never online together sync through a relay that can’t read', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const relayDir = tmp()
  const relay = new RelayServer({ dir: relayDir, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const aliceDir = tmp()
  const opts = { apps: [docsApp], lan: false }
  let alice = new Drive({ dataDir: aliceDir, swarm: swarm(), ...opts })
  const bob = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  t.after(async () => { await alice.stop(); await bob.stop(); await relay.stop(); await testnet.destroy() })
  alice.setProfile({ name: 'Alice' })
  bob.setProfile({ name: 'Bob' })
  await alice.start()
  await bob.start()

  // Alice's relay keeps every new file she makes.
  alice.addMyRelay(address)
  const docId = await alice.create('docs', 'Field journal')
  write(alice, docId, 'Secret heron count: 14.')
  await until(() => alice.describe(docId).sync.relays[0]?.online, 20000, 'alice connected to the relay')
  await until(() => allBytes(relayDir).length > 2000, 20000, 'the relay to hold a copy')
  const link = alice.invite(docId, 'editor')
  await alice.stop()

  // Bob joins while Alice is offline and gets the file from the relay.
  await bob.join(link)
  await until(() => text(bob, docId) === 'Secret heron count: 14.', 30000, 'bob to get the file from the relay')
  assert.equal(bob.describe(docId).title, 'Field journal')
  write(bob, docId, ' Bob saw two more.')
  await until(() => bob.describe(docId).sync.relays[0]?.lastSyncedAt, 20000, 'bob to reach the relay')
  await sleep(500)
  await bob.stop()

  // Alice comes back after Bob has left, and gets his edit.
  alice = new Drive({ dataDir: aliceDir, swarm: swarm(), ...opts })
  await alice.start()
  await until(() => text(alice, docId) === 'Secret heron count: 14. Bob saw two more.', 30000, 'alice to get bob’s edit')

  // Nothing on the relay's disk is readable.
  const stored = allBytes(relayDir)
  for (const secret of ['heron', 'Field journal', 'Alice', 'Bob saw']) assert.ok(!stored.includes(secret), `relay storage contains "${secret}"`)
})

test('an uploaded file downloads from the relay while whoever uploaded it is off', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const relayDir = tmp()
  const relay = new RelayServer({ dir: relayDir, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const opts = { apps: [docsApp], lan: false }
  const alice = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  const bob = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  t.after(async () => { await alice.stop(); await bob.stop(); await relay.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()
  alice.addMyRelay(address)

  const bytes = crypto.randomBytes(700 * 1024) // three chunks
  const src = path.join(tmp(), 'survey.pdf')
  fs.writeFileSync(src, bytes)
  const docId = await alice.upload(src)
  const chunksDir = path.join(relayDir, 'chunks')
  const stored = () => (fs.existsSync(chunksDir) ? fs.readdirSync(chunksDir, { recursive: true }).filter((f) => /[0-9a-f]{64}$/.test(path.basename(f)) && f.includes(path.sep)).length : 0)
  await until(() => stored() === 3, 30000, 'the relay to hold the file’s chunks')
  const link = alice.invite(docId, 'viewer')
  await alice.stop()

  await bob.join(link)
  await until(() => bob.describe(docId)?.upload?.ready, 30000, 'bob to download the file from the relay')
  const out = path.join(tmp(), 'out.pdf')
  await bob.uploads.saveTo(docId, out)
  assert.deepEqual(fs.readFileSync(out), bytes)

  // The relay holds neither the contents nor the chunks' real hashes.
  const disk = allBytes(chunksDir)
  assert.ok(!disk.includes(bytes.subarray(0, 64).toString('latin1')))
  const real = bob.getDoc(docId).ydoc.getArray('versions').toArray()[0].chunks
  const names = fs.readdirSync(chunksDir, { recursive: true }).map((f) => path.basename(f))
  for (const h of real) assert.ok(!names.includes(h), 'a chunk stored under its hash')
})

test('a computer can be its own relay: its Drive fills it in memory, and others read it over the network', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const relay = new RelayServer({ dir: tmp(), swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const opts = { apps: [docsApp], lan: false }
  const alice = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  const bob = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  t.after(async () => { await alice.stop(); await bob.stop(); await relay.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()

  alice.useLocalRelay(relay)
  alice.addMyRelay(address)
  const docId = await alice.create('docs', 'Minutes')
  write(alice, docId, 'Kept on my own relay.')
  await until(() => alice.describe(docId).sync.relays[0]?.online, 10000, 'alice’s Drive to reach its relay')
  assert.equal(relay.stats().connections, 1, 'in memory, not over the network')
  await until(() => relay.stats().usedBytes > 0, 10000, 'the relay to hold a copy')
  const link = alice.invite(docId, 'viewer')
  await alice.stop() // the window closed; the relay keeps running

  await bob.join(link)
  await until(() => text(bob, docId) === 'Kept on my own relay.', 30000, 'bob to read it from the relay')
})

test('a relay keeps only one blob per file after compacting, and rejects writes without the box key', async (t) => {
  const testnet = await createTestnet(3)
  const relayDir = tmp()
  const relay = new RelayServer({ dir: relayDir, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 } })
  t.after(async () => { await alice.stop(); await relay.stop(); await testnet.destroy() })
  await alice.start()
  alice.relays.compactAfter = 5
  alice.addMyRelay(address)
  const docId = await alice.create('docs', 'Many edits')
  await until(() => alice.describe(docId).sync.relays[0]?.online, 20000, 'connected')
  for (let i = 0; i < 12; i++) { write(alice, docId, `${i} `); await sleep(30) }
  await sleep(500)
  // Reconnecting catches up, sees a long box, and rewrites it as one.
  for (const link of alice.relays.links.values()) link.socket.destroy()
  await until(() => [...relay.boxes.values()].some((b) => b.count <= 3 && b.last >= 12), 20000, 'compaction')

  // A put signed with the wrong key is refused.
  const [box] = [...relay.boxes.keys()]
  const before = relay.boxes.get(box).last
  assert.throws(() => relay._onMessage({ send: () => {} }, { t: 'put', box, sig: Buffer.alloc(64).toString('base64'), id: 'x' }, Buffer.from('junk')), /bad signature/)
  assert.equal(relay.boxes.get(box).last, before)
})

test('edits from a viewer that arrive through a relay are ignored', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const relay = new RelayServer({ dir: tmp(), swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: swarm() })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], lan: false, swarm: swarm() })
  t.after(async () => { await alice.stop(); await bob.stop(); await relay.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()
  alice.addMyRelay(address)
  const docId = await alice.create('docs', 'Policy')
  write(alice, docId, 'Version one.')
  await bob.join(alice.invite(docId, 'viewer'))
  await until(() => text(bob, docId) === 'Version one.' && bob.describe(docId).access.role === 'viewer' && !bob.describe(docId).access.pending, 20000, 'viewer synced')
  await until(() => bob.describe(docId).sync.relays[0]?.online, 20000, 'viewer connected to the relay')

  // A tampered viewer writes straight to the relay, and cuts the direct link.
  for (const c of [...bob.engine.connections]) c.destroy()
  bob.engine.setActive(docId, false)
  bob.relays._mayWrite = () => true
  const doc = bob.getDoc(docId)
  const state = [...[...bob.relays.links.values()][0].boxes.values()][0]
  const p = new Y.Doc()
  Y.applyUpdate(p, Y.encodeStateAsUpdate(doc.ydoc))
  const before = Y.encodeStateVector(p)
  p.getXmlFragment(CONTENT_FIELD).get(0).get(0).insert(0, 'Forged. ')
  bob.relays._put([...bob.relays.links.values()][0], doc, state, 'u', Buffer.from(Y.encodeStateAsUpdate(p, before)))
  await sleep(1500)
  assert.equal(text(alice, docId), 'Version one.')
})

test('relay addresses: new ones start cpr1., and old cph1. ones still work', async () => {
  const { formatRelayAddress, parseRelayAddress } = await import('@commonplace/core')
  const key = 'ab'.repeat(32)
  const address = formatRelayAddress(key)
  assert.match(address, /^cpr1\./)
  assert.equal(parseRelayAddress(address), key)
  assert.equal(parseRelayAddress(address.replace('cpr1.', 'cph1.')), key)
  assert.equal(parseRelayAddress('nonsense'), null)
})
