// Offline edits: different paragraphs merge on their own; the same paragraph
// edited on both sides becomes a conflict that only the owner decides.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-conflict-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const swarmOpts = (testnet) => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })

async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

// Edits the shared document the way a window would.
function edit (drive, docId, fn) {
  drive.engine.registerLocalClient(docId, drive.getDoc(docId).ydoc.clientID)
  drive.getDoc(docId).ydoc.transact(() => fn(drive.getDoc(docId).ydoc.getXmlFragment(CONTENT_FIELD)), 'renderer')
}
const paragraph = (text) => { const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); t.insert(0, text); p.insert(0, [t]); return p }
const setText = (frag, i, text) => { const t = frag.get(i).get(0); t.delete(0, t.length); t.insert(0, text) }
const texts = (drive, docId) => drive.getDoc(docId).ydoc.getXmlFragment(CONTENT_FIELD).toArray().map((p) => p.get(0).toString())

async function pair (t) {
  const testnet = await createTestnet(3)
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarmOpts(testnet) })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarmOpts(testnet) })
  alice.setProfile({ name: 'Alice' }); bob.setProfile({ name: 'Bob' })
  await alice.start(); await bob.start()
  t.after(async () => { await alice.stop(); await bob.stop(); await testnet.destroy() })
  const docId = await alice.create('docs', 'Plan')
  edit(alice, docId, (frag) => frag.insert(0, [paragraph('Intro.'), paragraph('Budget is 100.'), paragraph('Dates are open.')]))
  await bob.join(alice.invite(docId, 'editor'))
  await until(() => texts(bob, docId).length === 3 && bob.describe(docId).sync.live, 20000, 'bob to sync')
  await sleep(2600) // both record the shared state
  return { alice, bob, docId }
}

function disconnect (...drives) {
  for (const d of drives) d.setSyncMode(d.list()[0].docId, 'open') // stop syncing (nothing is open)
}
function reconnect (...drives) {
  for (const d of drives) d.setSyncMode(d.list()[0].docId, 'always')
}

test('edits to different paragraphs while apart merge with no conflict', async (t) => {
  const { alice, bob, docId } = await pair(t)
  disconnect(alice, bob)
  await until(() => !alice.describe(docId).sync.live && !bob.describe(docId).sync.live, 20000, 'disconnect')
  edit(alice, docId, (f) => setText(f, 0, 'Intro, revised by Alice.'))
  edit(bob, docId, (f) => setText(f, 2, 'Dates: June 3 to 9.'))
  reconnect(alice, bob)
  await until(() => texts(alice, docId).join() === texts(bob, docId).join() && texts(bob, docId)[0].includes('Alice'), 30000, 'merge')
  assert.deepEqual(texts(alice, docId), ['Intro, revised by Alice.', 'Budget is 100.', 'Dates: June 3 to 9.'])
  await sleep(500)
  assert.equal(alice.describe(docId).conflicts.length, 0)
  assert.equal(bob.describe(docId).conflicts.length, 0)
})

test('the same paragraph edited on both sides becomes one conflict the owner decides', async (t) => {
  const { alice, bob, docId } = await pair(t)
  disconnect(alice, bob)
  await until(() => !alice.describe(docId).sync.live && !bob.describe(docId).sync.live, 20000, 'disconnect')
  edit(alice, docId, (f) => setText(f, 1, 'Budget is 120.'))
  edit(bob, docId, (f) => { setText(f, 1, 'Budget is 150.'); setText(f, 2, 'Dates are fixed.') })
  reconnect(alice, bob)
  await until(() => alice.describe(docId).conflicts.length === 1 && bob.describe(docId).conflicts.length === 1, 30000, 'conflict on both')
  assert.equal(alice.describe(docId).conflicts[0].id, bob.describe(docId).conflicts[0].id, 'both computers agree on the conflict')
  // The other paragraph merged on its own.
  assert.equal(texts(alice, docId)[2], 'Dates are fixed.')

  const [c] = alice.conflicts(docId)
  assert.deepEqual(c.versions.map((v) => v.text).sort(), ['Budget is 120.', 'Budget is 150.'])
  assert.equal(c.base.text, 'Budget is 100.')

  // Only the owner decides.
  assert.throws(() => bob.resolveConflict(docId, c.id, 'v0'), /Only the owner/)
  const bobs = c.versions.findIndex((v) => v.userId === bob.identity.userId)
  alice.resolveConflict(docId, c.id, `v${bobs}`)
  await until(() => texts(bob, docId)[1] === 'Budget is 150.' && texts(alice, docId)[1] === 'Budget is 150.', 20000, 'resolution to reach bob')
  await until(() => bob.describe(docId).conflicts.length === 0, 20000, 'conflict closed on bob')
  assert.deepEqual(texts(alice, docId), ['Intro.', 'Budget is 150.', 'Dates are fixed.'])
})

test('keeping both versions, and a paragraph one side deleted', async (t) => {
  const { alice, bob, docId } = await pair(t)
  disconnect(alice, bob)
  await until(() => !alice.describe(docId).sync.live && !bob.describe(docId).sync.live, 20000, 'disconnect')
  edit(alice, docId, (f) => { setText(f, 0, 'Intro by Alice.'); f.delete(2, 1) })
  edit(bob, docId, (f) => { setText(f, 0, 'Intro by Bob.'); setText(f, 2, 'Dates are firm.') })
  reconnect(alice, bob)
  await until(() => alice.describe(docId).conflicts.length === 2, 30000, 'two conflicts')
  const list = alice.conflicts(docId)
  const intro = list.find((c) => c.base.text === 'Intro.')
  const dates = list.find((c) => c.base.text === 'Dates are open.')
  assert.ok(dates.versions.some((v) => !v.exists), 'one side deleted the dates paragraph')
  alice.resolveConflict(docId, intro.id, 'both')
  // Keep Bob's edited paragraph instead of the deletion.
  alice.resolveConflict(docId, dates.id, `v${dates.versions.findIndex((v) => v.exists)}`)
  await until(() => texts(bob, docId).length === 4 && texts(bob, docId).join() === texts(alice, docId).join(), 20000, 'resolutions to sync')
  assert.deepEqual(texts(alice, docId).slice(0, 2).sort(), ['Intro by Alice.', 'Intro by Bob.'])
  assert.deepEqual(texts(alice, docId).slice(2), ['Budget is 100.', 'Dates are firm.'])
})

test('editing at the same time while connected never raises a conflict', async (t) => {
  const { alice, bob, docId } = await pair(t)
  for (let i = 0; i < 20; i++) {
    edit(alice, docId, (f) => { const x = f.get(1).get(0); x.insert(x.length, 'a') })
    edit(bob, docId, (f) => { const x = f.get(1).get(0); x.insert(0, 'b') })
    await sleep(30)
  }
  await until(() => texts(alice, docId).join() === texts(bob, docId).join(), 20000, 'live convergence')
  await sleep(800)
  assert.equal(alice.describe(docId).conflicts.length, 0)
  assert.equal(bob.describe(docId).conflicts.length, 0)
})
