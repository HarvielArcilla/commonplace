// This computer's limits (policy.js): settings kept in range, daily
// download budgets, shared folders that bring too much, pausing for free
// space and for your own files, a cap on answers per person, and blocking.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive, normalizePolicy, DEFAULT_POLICY } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { formsApp } from '@commonplace/forms'
import { answerUpdate } from '@commonplace/forms/responses'
import { formServices } from '../apps/desktop/src/forms.js'
import { Policy } from '../packages/drive/src/policy.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-limits-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 40000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const writeTemp = (name, bytes) => { const p = path.join(tmp(), name); fs.writeFileSync(p, bytes); return p }
const grow = (ydoc, bytes) => ydoc.transact(() => {
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText(crypto.randomBytes(bytes).toString('base64'))])
  ydoc.getXmlFragment(CONTENT_FIELD).push([p])
}, 'renderer')

async function network (t, apps, policies) {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const drives = []
  for (const [name, policy] of Object.entries(policies)) {
    const d = new Drive({ dataDir: tmp(), apps, swarm: swarm(), lan: false, policy })
    d.setProfile({ name })
    await d.start()
    drives.push(d)
  }
  t.after(async () => { for (const d of drives) await d.stop(); await testnet.destroy() })
  return drives
}

test('limits are kept in range, saved, and restored to their defaults', () => {
  const dir = tmp()
  assert.deepEqual(normalizePolicy({}), DEFAULT_POLICY)
  const n = normalizePolicy({ autoBytes: -5, answersPerPerson: 'lots', askRisky: 'no', maxFileBytes: 1e15 })
  assert.equal(n.autoBytes, 0)
  assert.equal(n.answersPerPerson, DEFAULT_POLICY.answersPerPerson)
  assert.equal(n.askRisky, true)
  assert.equal(n.maxFileBytes, 2 * 1024 ** 3)
  const p = new Policy(dir)
  assert.equal(p.fresh, true)
  p.set({ folderFilesPerDay: 3 })
  const again = new Policy(dir)
  assert.equal(again.get('folderFilesPerDay'), 3)
  assert.equal(again.fresh, false)
  again.reset()
  assert.equal(new Policy(dir).get('folderFilesPerDay'), DEFAULT_POLICY.folderFilesPerDay)
  // Daily budgets count each download once.
  again.set({ personDailyBytes: 1000, dailyBytes: 1500 })
  assert.equal(again.fitsDownload('a'.repeat(64), 900), true)
  again.spendDownload('f1:v1', 'a'.repeat(64), 900)
  again.spendDownload('f1:v1', 'a'.repeat(64), 900)
  assert.equal(again.fitsDownload('a'.repeat(64), 200), false)
  assert.equal(again.fitsDownload('b'.repeat(64), 500), true)
  assert.equal(again.fitsDownload('b'.repeat(64), 700), false) // the total
})

test('files wait once a person’s daily budget is used, and blocking stops them', async (t) => {
  const [maya, sam] = await network(t, [docsApp], { Maya: {}, Sam: { personDailyBytes: 1024 * 1024 } })
  const first = await maya.upload(writeTemp('one.pdf', crypto.randomBytes(700 * 1024)))
  const second = await maya.upload(writeTemp('two.pdf', crypto.randomBytes(700 * 1024)))
  const big = await maya.upload(writeTemp('three.pdf', crypto.randomBytes(300 * 1024)))
  sam.setPolicy({ maxFileBytes: 1024 * 1024 })
  sam.setPolicy({ autoBytes: 1024 * 1024 })
  await sam.join(maya.invite(first, 'viewer'))
  await until(() => sam.describe(first)?.upload?.ready, 40000, 'the first file')
  await sam.join(maya.invite(second, 'viewer'))
  await until(() => sam.describe(second)?.upload?.hold === 'budget', 40000, 'the second to wait for tomorrow’s budget')
  // A yes still downloads it.
  sam.approveDownload(second)
  await until(() => sam.describe(second)?.upload?.ready, 40000, 'the second file once approved')

  // Blocking Maya: her files pause and nothing more comes from her.
  sam.block(maya.me().userId, 'Maya')
  assert.equal(sam.describe(first).held.reason, 'blocked')
  await sam.join(maya.invite(big, 'viewer'))
  await sleep(2500)
  assert.notEqual(sam.describe(big)?.upload?.ready, true)
  assert.throws(() => sam.keepSyncing(first), /blocked/)
  sam.unblock(maya.me().userId)
  assert.equal(sam.describe(first).held, null)
  await until(() => sam.describe(big)?.upload?.ready, 40000, 'her file after unblocking')
})

test('a shared folder that brings too many files in a day pauses the rest', async (t) => {
  const [maya, sam] = await network(t, [docsApp], { Maya: {}, Sam: { folderFilesPerDay: 2 } })
  const folderId = await maya.createSharedFolder('Trips')
  await sam.join(maya.invite(folderId, 'viewer'))
  await until(() => sam.listFolders().some((f) => f.id === folderId && f.name === 'Trips'), 40000, 'Sam to see the folder')
  const ids = []
  for (let i = 0; i < 4; i++) {
    const id = await maya.create('docs', `Day ${i + 1}`)
    maya.moveFile(id, folderId)
    ids.push(id)
  }
  await until(() => ids.every((id) => sam.describe(id)), 40000, 'all four listed for Sam')
  const held = ids.filter((id) => sam.describe(id).held?.reason === 'many')
  assert.equal(held.length, 2)
  sam.keepSyncingFolder(folderId)
  assert.ok(ids.every((id) => !sam.describe(id).held))
  await until(() => ids.every((id) => sam.describe(id)?.title?.startsWith('Day')), 40000, 'all four to sync after a yes')
})

test('your own file pauses when others’ edits grow it past your limit', async (t) => {
  const [maya, sam] = await network(t, [docsApp], { Maya: { ownDocGuardBytes: 200 * 1024 }, Sam: {} })
  const docId = await maya.create('docs', 'Notes')
  await sam.join(maya.invite(docId, 'editor'))
  await until(() => sam.describe(docId)?.role === 'editor' && sam.describe(docId)?.type === 'docs', 40000, 'Sam to get the file')
  // Maya's own edits never pause it.
  grow(maya.getDoc(docId).ydoc, 50 * 1024)
  await sleep(2500)
  assert.equal(maya.describe(docId).held, null)
  grow(sam.getDoc(docId).ydoc, 200 * 1024)
  await until(() => maya.describe(docId)?.held?.reason === 'own', 40000, 'Maya’s file to pause')
  maya.keepSyncing(docId)
  assert.equal(maya.describe(docId).held, null)
})

test('a disk down to its free-space floor pauses files others change', async (t) => {
  // Ask for more free space than any test machine has.
  const [maya, sam] = await network(t, [docsApp], { Maya: {}, Sam: {} })
  const docId = await maya.create('docs', 'Notes')
  await sam.join(maya.invite(docId, 'viewer'))
  await until(() => sam.describe(docId)?.type === 'docs', 40000, 'Sam to get the file')
  sam.setPolicy({ keepFreeBytes: 1024 ** 4 })
  grow(maya.getDoc(docId).ydoc, 1024)
  await until(() => sam.describe(docId)?.held?.reason === 'space', 40000, 'the file to pause for space')
})

test('a form takes only so many answers from one person', async (t) => {
  const [owner, sam] = await network(t, [formsApp], { Maya: { answersPerPerson: 2 }, Sam: {} })
  formServices(owner).watch()
  const docId = await owner.create('form', 'Poll')
  formServices(owner).setup(docId)
  await sam.join(owner.invite(docId, 'respondent'))
  await until(() => sam.describe(docId)?.role === 'respondent' && sam.getDoc(docId).ydoc.getMap('keyGrants').has('_public'), 40000, 'Sam admitted with the form’s key')
  for (let i = 0; i < 4; i++) sam.engine.respond(docId, answerUpdate(sam.getDoc(docId).ydoc, sam.identity, { q: String(i) }))
  await until(() => owner.getDoc(docId).ydoc.getMap('responses').size >= 2, 40000, 'two answers')
  await sleep(2500)
  assert.equal(owner.getDoc(docId).ydoc.getMap('responses').size, 2)
})
