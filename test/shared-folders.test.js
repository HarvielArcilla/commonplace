// Shared folders: everyone in the folder gets what's in it, with the
// folder's role, and loses it when they leave or it's taken out.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { Drive } from '@commonplace/drive'
import { docsApp } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-shared-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 40000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}

test('shared folders give their people the files in them, and take them back', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = async (name) => { const d = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); await d.start(); return d }
  const maya = await make('Maya')
  const sam = await make('Sam')
  const lee = await make('Lee')
  t.after(async () => { await maya.stop(); await sam.stop(); await lee.stop(); await testnet.destroy() })

  const folderId = await maya.createSharedFolder('Garden club')
  const planId = await maya.create('docs', 'Planting plan')
  maya.moveFile(planId, folderId)
  assert.equal(maya.describe(planId).folderId, folderId)

  await sam.join(maya.invite(folderId, 'editor'))
  await lee.join(maya.invite(folderId, 'viewer'))
  await until(() => sam.listFolders().some((f) => f.id === folderId && f.name === 'Garden club'), 40000, 'Sam to see the folder')

  // Both get the file inside, with the folder's role.
  await until(() => sam.describe(planId)?.role === 'editor' && sam.describe(planId)?.title === 'Planting plan', 40000, 'Sam to get the plan as editor')
  await until(() => lee.describe(planId)?.role === 'viewer', 40000, 'Lee to get the plan as viewer')
  assert.equal(sam.describe(planId).folderId, folderId)

  // Sam (a folder editor) adds his own file: Maya and Lee get it.
  const listId = await sam.create('docs', 'Seed list')
  sam.moveFile(listId, folderId)
  await until(() => maya.describe(listId)?.role === 'editor', 40000, 'Maya to get Sam’s file')
  await until(() => lee.describe(listId)?.role === 'viewer', 40000, 'Lee to get Sam’s file')

  // A viewer can't put things in or take them out.
  const leesId = await lee.create('docs', 'Lee’s notes')
  assert.throws(() => lee.moveFile(leesId, folderId), /only view/)
  assert.throws(() => lee.moveFile(planId, null), /only view/)

  // Removing Lee from just the file would only give it back: refused.
  assert.throws(() => maya.removeMember(planId, lee.identity.userId), /shared folder/)

  // Lee leaves the folder (Maya removes him): he loses both files.
  maya.removeMember(folderId, lee.identity.userId)
  await until(() => maya.engine.membersDetailed(planId).every((m) => m.userId !== lee.identity.userId), 40000, 'Lee out of Maya’s file')
  await until(() => sam.engine.membersDetailed(listId).every((m) => m.userId !== lee.identity.userId), 40000, 'Lee out of Sam’s file')

  // Taking a file out of the folder takes it from the people who had it
  // only through the folder. Sam never opened Maya's plan, so it leaves his Drive.
  maya.moveFile(planId, null)
  await until(() => maya.engine.membersDetailed(planId).every((m) => m.userId !== sam.identity.userId), 40000, 'Sam out of the plan')
  await until(() => !sam.files.has(planId), 40000, 'the plan to leave Sam’s Drive')

  // Someone given access by hand keeps it whatever the folder does.
  maya.moveFile(planId, folderId)
  await until(() => sam.describe(planId)?.role === 'editor', 40000, 'Sam to get the plan back')
  maya.setMemberRole(planId, sam.identity.userId, 'viewer')
  maya.moveFile(planId, null)
  await sleep(1500)
  assert.equal(maya.engine.membersDetailed(planId).find((m) => m.userId === sam.identity.userId)?.role, 'viewer')
})

test('sharing one of my folders brings its subfolders and my files along', async (t) => {
  const maya = new Drive({ dataDir: tmp(), apps: [docsApp], transport: false, lan: false })
  t.after(() => maya.stop())
  await maya.start()
  const top = maya.createFolder('Projects')
  const sub = maya.createFolder('Kitchen', top)
  const a = await maya.create('docs', 'Budget', { folderId: top })
  const b = await maya.create('docs', 'Tiles', { folderId: sub })
  const shared = await maya.shareFolder(top)
  assert.equal(maya.folders.has(top), false)
  const folders = maya.listFolders()
  const kitchen = folders.find((f) => f.name === 'Kitchen')
  assert.ok(kitchen.shared)
  assert.equal(kitchen.parentId, shared)
  assert.equal(maya.describe(a).folderId, shared)
  assert.equal(maya.describe(b).folderId, kitchen.id)
  // A folder can't go into itself.
  assert.throws(() => maya.moveFile(shared, kitchen.id), /inside itself/)
  // Personal folders don't go inside shared ones.
  const other = maya.createFolder('Other')
  assert.throws(() => maya.moveFolder(other, shared), /Share this folder first/)
})
