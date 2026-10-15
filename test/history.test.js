// Version history: checkpoints, thinning, and restoring for everyone.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { History, FileStore, docFrom } from '@commonplace/core'
import { Drive } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-history-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const text = (ydoc) => docsApp.preview(ydoc)

function setText (ydoc, str) {
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  ydoc.transact(() => {
    if (frag.length) frag.delete(0, frag.length)
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(str)])
    frag.insert(0, [p])
  })
}

async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${what}`)
}

test('checkpoints rebuild every version, and thinning keeps the chain intact', () => {
  const store = new FileStore(tmp())
  const history = new History(store)
  const id = 'aa'.repeat(16)
  const ydoc = new Y.Doc()
  const day = 24 * 3600e3
  const start = Date.now() - 90 * day
  const expected = []
  // Three checkpoints a day for 90 days.
  for (let i = 0; i < 270; i++) {
    setText(ydoc, `Draft ${i}`)
    const v = history.record(id, ydoc, { now: start + i * day / 3 })
    expected.push([v.id, `Draft ${i}`])
  }
  assert.equal(history.record(id, ydoc), null, 'no checkpoint when nothing changed')
  const kept = history.list(id)
  assert.ok(kept.length < 100, `old checkpoints are thinned (${kept.length} kept)`)
  assert.equal(kept.at(-1).id, expected.at(-1)[0], 'the newest is always kept')
  for (const v of kept) {
    const want = expected.find(([vid]) => vid === v.id)[1]
    assert.equal(text(docFrom(history.load(id, v.id))), want)
  }
  // Deletions show up in the version too.
  setText(ydoc, '')
  const empty = history.record(id, ydoc)
  assert.equal(text(docFrom(history.load(id, empty.id))), '')
})

test('restoring a version is an edit everyone receives, and is itself undoable', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), history: { idleMs: 200, maxMs: 1000 } })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm() })
  t.after(async () => { await alice.stop(); await bob.stop(); await testnet.destroy() })
  alice.setProfile({ name: 'Alice' })
  await alice.start()
  await bob.start()

  const docId = await alice.create('docs', 'Essay')
  const doc = alice.getDoc(docId)
  doc.ydoc.getMap('authors').set(String(doc.ydoc.clientID), { userId: alice.identity.userId })
  setText(doc.ydoc, 'The good first draft.')
  await until(() => alice.versions(docId).length === 1, 5000, 'first checkpoint')
  setText(doc.ydoc, 'A worse second draft.')
  await until(() => alice.versions(docId).length === 2, 5000, 'second checkpoint')
  const [latest, first] = alice.versions(docId)
  assert.equal(latest.names[0], 'Alice')
  assert.equal(text(docFrom(alice.version(docId, first.id))), 'The good first draft.')

  await bob.join(alice.invite(docId))
  await until(() => text(bob.getDoc(docId).ydoc) === 'A worse second draft.', 20000, 'bob synced')

  alice.restoreVersion(docId, first.id)
  assert.equal(text(doc.ydoc), 'The good first draft.')
  await until(() => text(bob.getDoc(docId).ydoc) === 'The good first draft.', 20000, 'restore reaches bob')
  const after = alice.versions(docId)
  assert.equal(after[0].kind, 'restore')
  assert.equal(after[0].restoredFrom, first.at)
  // The draft that was replaced is still in the history.
  assert.equal(text(docFrom(alice.version(docId, latest.id))), 'A worse second draft.')
})
