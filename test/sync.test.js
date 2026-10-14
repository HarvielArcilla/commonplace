// End-to-end sync tests on a private, local DHT (no internet needed).
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

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'commonplace-test-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Peers bind to loopback so the tests run in sandboxes without LAN UDP.
const swarmOpts = (testnet) => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 1000 })

async function until (fn, ms = 20000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error('timed out waiting for condition')
}

// Simulates an editor window: its own Y.Doc, bridged to the drive's copy.
function editorFor (drive, docId) {
  const engineDoc = drive.getDoc(docId)
  const view = new Y.Doc()
  Y.applyUpdate(view, Y.encodeStateAsUpdate(engineDoc.ydoc))
  drive.engine.registerLocalClient(docId, view.clientID)
  view.on('update', (u, origin) => { if (origin !== 'engine') drive.engine.applyLocalUpdate(docId, u, 'renderer') })
  drive.engine.on('update', (id, u, origin) => { if (id === docId && origin !== 'renderer') Y.applyUpdate(view, u, 'engine') })
  view.getMap('authors').set(String(view.clientID), { userId: drive.identity.userId, name: drive.identity.name })
  const text = new Y.XmlText()
  const para = new Y.XmlElement('paragraph')
  return {
    view,
    type (str) {
      const frag = view.getXmlFragment(CONTENT_FIELD)
      if (!frag.length) { para.insert(0, [text]); frag.insert(0, [para]) }
      const t = frag.get(0).get(0)
      t.insert(t.length, str)
    },
    text: () => docsApp.preview(view)
  }
}

test('two peers converge live, and again after both edit offline', async (t) => {
  const testnet = await createTestnet(3)
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarmOpts(testnet) })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarmOpts(testnet) })
  alice.setProfile({ name: 'Alice' })
  bob.setProfile({ name: 'Bob' })
  t.after(async () => { await alice.stop(); await bob.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()

  const docId = await alice.create('docs', 'Plan')
  const a = editorFor(alice, docId)
  a.type('Hello from Alice.')

  await bob.join(alice.invite(docId))
  await until(() => bob.describe(docId).title === 'Plan')
  const b = editorFor(bob, docId)
  await until(() => b.text() === 'Hello from Alice.')

  // Live edit from Bob reaches Alice.
  b.type(' Bob here.')
  await until(() => a.text() === 'Hello from Alice. Bob here.')
  await until(() => alice.describe(docId).sync.live && alice.describe(docId).contributors.length === 2)
  await until(() => bob.describe(docId).sync.pending === 0)
  assert.equal(bob.describe(docId).sync.ownerOnline, true)
  assert.equal(bob.describe(docId).role, 'editor')

  // Cut the network on both sides, edit independently.
  for (const d of [alice, bob]) for (const c of d.engine.connections) c.destroy()
  await until(() => !alice.describe(docId).sync.live && !bob.describe(docId).sync.live)
  a.type(' A-offline.')
  b.type(' B-offline.')
  await sleep(300)
  assert.ok(bob.describe(docId).sync.pending > 0, 'bob should report unsynced edits')
  assert.equal(bob.describe(docId).sync.ownerOnline, false)

  // Reconnect: both copies must become identical and include both edits.
  await until(() => alice.describe(docId).sync.live, 30000)
  await until(() => a.text() === b.text() && a.text().includes('A-offline') && a.text().includes('B-offline'), 30000)
  await until(() => bob.describe(docId).sync.pending === 0 && alice.describe(docId).sync.pending === 0)
})

test('edits survive a restart and a third peer can serve the doc when the owner is gone', async (t) => {
  const testnet = await createTestnet(3)
  const dirs = { alice: tmp(), bob: tmp(), carol: tmp() }
  let alice = new Drive({ dataDir: dirs.alice, apps: [docsApp], swarm: swarmOpts(testnet) })
  const bob = new Drive({ dataDir: dirs.bob, apps: [docsApp], swarm: swarmOpts(testnet) })
  await alice.start(); await bob.start()
  const docId = await alice.create('docs', 'Handoff')
  editorFor(alice, docId).type('Written by Alice.')
  await bob.join(alice.invite(docId))
  await until(() => bob.describe(docId).preview === 'Written by Alice.')
  const invite = alice.invite(docId)
  await alice.stop() // owner leaves

  const carol = new Drive({ dataDir: dirs.carol, apps: [docsApp], swarm: swarmOpts(testnet) })
  await carol.start()
  await carol.join(invite)
  await until(() => carol.describe(docId).preview === 'Written by Alice.')
  assert.equal(carol.describe(docId).sync.ownerOnline, false)

  // Restart Alice from disk: her doc is still there, unchanged.
  alice = new Drive({ dataDir: dirs.alice, apps: [docsApp], transport: false })
  await alice.start()
  assert.equal(alice.describe(docId).preview, 'Written by Alice.')
  assert.equal(alice.describe(docId).role, 'owner')
  t.after(async () => { await alice.stop(); await bob.stop(); await carol.stop(); await testnet.destroy() })
})

test('a peer without the secret learns nothing and cannot inject edits', async () => {
  const { seal, open, deriveDocKeys, newDocSecret } = await import('@commonplace/core')
  const k1 = deriveDocKeys(newDocSecret())
  const k2 = deriveDocKeys(newDocSecret())
  const sealed = seal(k1.encKey, Buffer.from('secret text'))
  assert.equal(open(k2.encKey, sealed), null)
  assert.equal(open(k1.encKey, sealed).toString(), 'secret text')
  sealed[20] ^= 1
  assert.equal(open(k1.encKey, sealed), null)
})
