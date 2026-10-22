// The "can comment" role: commenters change the comments and nothing else,
// and every computer checks that for itself.
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
import { addThread, reply, readThreads, isCommentUpdate } from '@commonplace/core/threads'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-comment-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const user = (n) => String(n).repeat(64)

function typeInto (ydoc, str) {
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
  const t = frag.get(0).get(0)
  t.insert(t.length, str)
}

// Captures the update one change to a copy of `base` makes.
function updateFrom (base, change) {
  const copy = new Y.Doc()
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(base))
  const before = Y.encodeStateVector(copy)
  change(copy)
  return Y.encodeStateAsUpdate(copy, before)
}

test('a commenter’s update may touch the comments and nothing else', () => {
  const doc = new Y.Doc()
  typeInto(doc, 'The plan.')
  doc.getMap('meta').set('title', 'Plan')
  const id = addThread(doc, { userId: user(1), text: 'First', quote: 'plan' })

  assert.ok(isCommentUpdate(doc, updateFrom(doc, (d) => addThread(d, { userId: user(2), text: 'Why?', anchor: { kind: 'text', from: 'AA', to: 'AB' } }))), 'a new thread')
  assert.ok(isCommentUpdate(doc, updateFrom(doc, (d) => reply(d, id, { userId: user(2), text: 'Agreed' }))), 'a reply')
  assert.ok(!isCommentUpdate(doc, updateFrom(doc, (d) => typeInto(d, ' Changed.'))), 'the text')
  assert.ok(!isCommentUpdate(doc, updateFrom(doc, (d) => d.getMap('meta').set('title', 'Mine'))), 'the title')
  assert.ok(!isCommentUpdate(doc, updateFrom(doc, (d) => d.getMap('people').set(user(2), { name: 'x' }))), 'the people map')
  assert.ok(!isCommentUpdate(doc, updateFrom(doc, (d) => d.transact(() => { addThread(d, { userId: user(2), text: 'Hi' }); typeInto(d, '!') }))), 'a comment with an edit')
  // Deleting text is a change to the text too.
  assert.ok(!isCommentUpdate(doc, updateFrom(doc, (d) => d.getXmlFragment(CONTENT_FIELD).get(0).get(0).delete(0, 4))), 'deleting text')

  // An update that builds on something this computer doesn't have yet would
  // sit waiting and could land anywhere: refused.
  const elsewhere = new Y.Doc()
  Y.applyUpdate(elsewhere, Y.encodeStateAsUpdate(doc))
  typeInto(elsewhere, ' More.')
  const later = updateFrom(elsewhere, (d) => typeInto(d, ' Most.'))
  assert.ok(!isCommentUpdate(doc, later))
  assert.ok(!isCommentUpdate(doc, Buffer.from('not an update')))
})

test('commenters comment from their own computer; their edits to the text go nowhere', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = (name) => { const d = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); return d }
  const alice = make('Alice')
  const bob = make('Bob')
  t.after(async () => { await alice.stop(); await bob.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()

  const docId = await alice.create('docs', 'Brief')
  alice.getDoc(docId).ydoc.transact(() => typeInto(alice.getDoc(docId).ydoc, 'Launch on Monday.'), 'local')
  await bob.join(alice.invite(docId, 'commenter'))
  await until(() => docsApp.preview(bob.getDoc(docId).ydoc) === 'Launch on Monday.', 20000, 'the commenter to get the file')
  await until(() => bob.describe(docId).access.role === 'commenter' && !bob.describe(docId).access.pending, 20000, 'the commenter admitted')

  // Bob's window comments: it reaches Alice.
  const bobView = bob.getDoc(docId).ydoc
  bob.engine.applyLocalUpdate(docId, updateFrom(bobView, (d) => addThread(d, { userId: bob.identity.userId, text: 'Monday is a holiday.', quote: 'Monday' })), 'renderer')
  await until(() => readThreads(alice.getDoc(docId).ydoc).length === 1, 20000, 'the comment to reach Alice')
  assert.equal(readThreads(alice.getDoc(docId).ydoc)[0].messages[0].text, 'Monday is a holiday.')

  // An edit to the text from Bob's window doesn't even go into his own copy.
  bob.engine.applyLocalUpdate(docId, updateFrom(bobView, (d) => typeInto(d, ' Or Tuesday.')), 'renderer')
  assert.equal(docsApp.preview(bob.getDoc(docId).ydoc), 'Launch on Monday.')

  // A tampered app that pushes it anyway: Alice refuses it.
  const doc = bob.getDoc(docId)
  const real = doc.members.roleOf.bind(doc.members)
  doc.members.roleOf = (id, inv) => (id === bob.identity.userId ? { role: 'editor', pending: false } : real(id, inv))
  doc.ydoc.transact(() => typeInto(doc.ydoc, ' Or Tuesday.'), 'local')
  await sleep(1500)
  assert.equal(docsApp.preview(alice.getDoc(docId).ydoc), 'Launch on Monday.')
  doc.members.roleOf = real

  // Alice replies; Bob sees it.
  const aliceDoc = alice.getDoc(docId).ydoc
  aliceDoc.transact(() => reply(aliceDoc, readThreads(aliceDoc)[0].id, { userId: alice.identity.userId, text: 'Good catch.' }), 'local')
  await until(() => readThreads(bob.getDoc(docId).ydoc)[0]?.messages.length === 2, 20000, 'the reply to reach Bob')
})

test('a comment made while nobody who can edit is online arrives later', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const aliceDir = tmp()
  let alice = new Drive({ dataDir: aliceDir, apps: [docsApp], swarm: swarm(), lan: false })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false })
  t.after(async () => { await alice.stop(); await bob.stop(); await testnet.destroy() })
  await alice.start()
  await bob.start()
  const docId = await alice.create('docs', 'Notes')
  await bob.join(alice.invite(docId, 'commenter'))
  await until(() => bob.describe(docId)?.access?.role === 'commenter' && !bob.describe(docId).access.pending, 20000, 'the commenter admitted')
  await alice.stop()

  const view = bob.getDoc(docId).ydoc
  bob.engine.applyLocalUpdate(docId, updateFrom(view, (d) => addThread(d, { userId: bob.identity.userId, text: 'Left while you were away.' })), 'renderer')
  alice = new Drive({ dataDir: aliceDir, apps: [docsApp], swarm: swarm(), lan: false })
  await alice.start()
  await until(() => readThreads(alice.getDoc(docId).ydoc).length === 1, 30000, 'the comment to arrive')
})
