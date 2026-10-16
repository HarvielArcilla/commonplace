// Comments in any app: anchors, @mentions, and the activity that tells you.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { addThread, reply, readThreads, mentionsIn, openThreadCount, setResolved } from '@commonplace/core/threads'
import { Drive } from '@commonplace/drive'
import { docsApp } from '@commonplace/docs'
import { sheetsApp } from '@commonplace/sheets'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-comments-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 40000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

test('threads: anchors and mentions are kept, and checked', () => {
  const ydoc = new Y.Doc()
  const people = [{ userId: A, name: 'Maya' }, { userId: B, name: 'Maya Lin' }]
  assert.deepEqual(mentionsIn('thanks @Maya Lin!', people), [B])
  assert.deepEqual(mentionsIn('@Maya and @Maya Lin', people).sort(), [A, B].sort())
  const id = addThread(ydoc, { anchor: { kind: 'cell', sheet: 's1', row: 'r1', col: 'c1', junk: { no: 1 } }, userId: A, text: 'Is this right? @Maya Lin', mentions: [B, 'not-an-id'] })
  const [t] = readThreads(ydoc)
  assert.deepEqual(t.anchor, { kind: 'cell', sheet: 's1', row: 'r1', col: 'c1' })
  assert.deepEqual(t.messages[0].mentions, [B])
  reply(ydoc, id, { userId: B, text: 'Yes' })
  assert.equal(readThreads(ydoc)[0].messages.length, 2)
  assert.equal(openThreadCount(ydoc), 1)
  setResolved(ydoc, id, true, { userId: A })
  assert.equal(openThreadCount(ydoc), 0)
})

test('activity: mentions, replies and comments on my files reach me', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = async (name) => { const d = new Drive({ dataDir: tmp(), apps: [docsApp, sheetsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); await d.start(); return d }
  const maya = await make('Maya')
  const sam = await make('Sam')
  t.after(async () => { await maya.stop(); await sam.stop(); await testnet.destroy() })

  const docId = await maya.create('sheet', 'Budget')
  // An old comment, from before Sam joined: not news to him.
  const old = addThread(maya.getDoc(docId).ydoc, { anchor: { kind: 'file' }, userId: maya.identity.userId, text: 'Started this' })
  await sam.join(maya.invite(docId, 'editor'))
  await until(() => sam.describe(docId)?.title === 'Budget' && readThreads(sam.getDoc(docId).ydoc).length === 1, 40000, 'Sam to get the sheet')
  await sleep(600)
  assert.equal(sam.activity.list().length, 0)
  assert.equal(sam.describe(docId).review.comments, 1)

  // Sam comments on Maya's file, mentioning her.
  const samDoc = sam.getDoc(docId).ydoc
  const thread = addThread(samDoc, { anchor: { kind: 'file' }, userId: sam.identity.userId, text: '@Maya can we cut this?', mentions: [maya.identity.userId] })
  await until(() => maya.activity.list().some((i) => i.kind === 'mention' && i.threadId === thread), 40000, 'Maya to hear she was mentioned')
  assert.equal(maya.activity.unread(), 1)
  const fired = []
  sam.activity.on('new', (items) => fired.push(...items))

  // Maya replies: Sam hears about it. Sam's own messages are never news to him.
  reply(maya.getDoc(docId).ydoc, thread, { userId: maya.identity.userId, text: 'Sure' })
  await until(() => sam.activity.list().some((i) => i.kind === 'reply' && i.byName === 'Maya'), 40000, 'Sam to hear the reply')
  assert.ok(fired.every((i) => i.by !== sam.identity.userId))
  // Replying to Maya's old thread is news to her (it's hers).
  reply(samDoc, old, { userId: sam.identity.userId, text: 'Nice' })
  await until(() => maya.activity.list().some((i) => i.threadId === old), 40000, 'Maya to hear Sam replied to her thread')
  maya.activity.markRead()
  assert.equal(maya.activity.unread(), 0)
})
