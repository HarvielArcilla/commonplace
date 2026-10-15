// Membership, roles, removal, ownership transfer, per-file sync and moving a
// Drive between computers, on a private local DHT.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive, sendDrive, receiveDrive, newMoveCode } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { Membership, loadOrCreateIdentity } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-access-'))
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

function editorFor (drive, docId) {
  const view = new Y.Doc()
  Y.applyUpdate(view, Y.encodeStateAsUpdate(drive.getDoc(docId).ydoc))
  drive.engine.registerLocalClient(docId, view.clientID)
  view.on('update', (u, origin) => { if (origin !== 'engine') drive.engine.applyLocalUpdate(docId, u, 'renderer') })
  drive.engine.on('update', (id, u, origin) => { if (id === docId && origin !== 'renderer') Y.applyUpdate(view, u, 'engine') })
  return {
    type (str) {
      const frag = view.getXmlFragment(CONTENT_FIELD)
      if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
      const t = frag.get(0).get(0)
      t.insert(t.length, str)
    }
  }
}

const text = (drive, docId) => docsApp.preview(drive.getDoc(docId).ydoc)

async function people (t, names) {
  const testnet = await createTestnet(3)
  const out = {}
  for (const name of names) {
    out[name] = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarmOpts(testnet) })
    out[name].setProfile({ name })
    await out[name].start()
  }
  t.after(async () => { for (const d of Object.values(out)) await d.stop().catch(() => {}); await testnet.destroy() })
  return { ...out, testnet }
}

test('membership log: only the owner can sign, and forged entries are rejected', () => {
  const dir = tmp()
  const alice = loadOrCreateIdentity(path.join(dir, 'a'))
  const bob = loadOrCreateIdentity(path.join(dir, 'b'))
  const docId = 'ab'.repeat(16)
  const m = Membership.create(alice, docId)
  m.admit(alice, { userId: bob.userId, role: 'viewer', enc: bob.encPublic })
  assert.equal(m.member(bob.userId).role, 'viewer')
  assert.throws(() => m.setRole(bob, bob.userId, 'editor'), /Only the owner/)
  // A copy with a tampered entry doesn't replace the real log.
  const forged = JSON.parse(JSON.stringify(m.entries))
  forged[1].role = 'editor'
  const other = new Membership(docId)
  assert.equal(other.merge(forged), false)
  assert.equal(other.merge(m.entries), true)
  assert.equal(other.member(bob.userId).role, 'viewer')
  // Invite tokens: valid until revoked.
  const token = m.createInvite(alice, 'editor')
  assert.equal(m.validInvite(token), true)
  assert.equal(m.validInvite({ ...token, r: 'owner' }), false)
  m.revokeInvites(alice)
  assert.equal(m.validInvite(token), false)
})

test('viewers can read but their edits are refused by everyone else', async (t) => {
  const { alice, bob } = await people(t, ['alice', 'bob'])
  const docId = await alice.create('docs', 'Policy')
  editorFor(alice, docId).type('Version one.')
  await bob.join(alice.invite(docId, 'viewer'))
  await until(() => text(bob, docId) === 'Version one.', 20000, 'viewer to receive content')
  await until(() => bob.describe(docId).access.role === 'viewer' && !bob.describe(docId).access.pending, 20000, 'viewer admitted')
  assert.equal(alice.describe(docId).members.find((m) => m.userId === bob.identity.userId)?.role, 'viewer')

  // A tampered client that pretends to be an editor still can't change Alice's copy.
  const doc = bob.getDoc(docId)
  const real = doc.members.roleOf.bind(doc.members)
  doc.members.roleOf = (id, inv) => (id === bob.identity.userId ? { role: 'editor', pending: false } : real(id, inv))
  editorFor(bob, docId).type(' Edited by a viewer.')
  await sleep(1500)
  assert.equal(text(alice, docId), 'Version one.')

  // Alice's edits still reach the viewer.
  editorFor(alice, docId).type(' Version two.')
  await until(() => text(bob, docId).includes('Version two.'), 20000, 'viewer to receive new edits')
})

test('removing someone moves everyone else to a new key; they get nothing new', async (t) => {
  const { alice, bob, carol, dave } = await people(t, ['alice', 'bob', 'carol', 'dave'])
  const docId = await alice.create('docs', 'Plans')
  const a = editorFor(alice, docId)
  a.type('Shared start.')
  const link = alice.invite(docId, 'editor')
  await bob.join(link)
  await carol.join(link)
  await until(() => text(bob, docId) === 'Shared start.' && text(carol, docId) === 'Shared start.', 20000, 'both to sync')
  await until(() => alice.describe(docId).members.filter((m) => !m.pending).length === 3, 20000, 'both admitted')

  alice.removeMember(docId, carol.identity.userId)
  await until(() => bob.getDoc(docId).members.epoch === 1 && bob.getDoc(docId).myEpoch === 1, 20000, 'bob to get the new key')
  await until(() => carol.describe(docId).access.removed, 20000, 'carol to learn she was removed')
  assert.equal(carol.getDoc(docId).myEpoch, 0, 'carol never gets the new key')

  a.type(' After removal.')
  await until(() => text(bob, docId).includes('After removal.'), 20000, 'bob to receive post-removal edits')
  await sleep(1500)
  assert.equal(text(carol, docId), 'Shared start.')

  // The old link no longer admits anyone.
  assert.equal(alice.getDoc(docId).members.validInvite(JSON.parse(Buffer.from(link.split('.')[2], 'base64url'))), false)

  // Someone invited afterwards is let in by the owner and handed the new key.
  await dave.join(alice.invite(docId, 'editor'))
  await until(() => dave.getDoc(docId).myEpoch === 1 && text(dave, docId).includes('After removal.'), 20000, 'late joiner to get the new key and content')
  await sleep(500)
  assert.equal(text(carol, docId), 'Shared start.')
})

test('ownership can be transferred to another member', async (t) => {
  const { alice, bob, dave } = await people(t, ['alice', 'bob', 'dave'])
  const docId = await alice.create('docs', 'Handover')
  await bob.join(alice.invite(docId, 'editor'))
  await until(() => alice.describe(docId).members.some((m) => m.userId === bob.identity.userId && !m.pending), 20000, 'bob admitted')
  alice.transferOwnership(docId, bob.identity.userId)
  await until(() => bob.describe(docId).role === 'owner', 20000, 'bob to become owner')
  assert.equal(alice.describe(docId).role, 'editor')
  assert.throws(() => alice.invite(docId, 'editor'), /Only the owner/)

  // The new owner can let new people in.
  await dave.join(bob.invite(docId, 'viewer'))
  await until(() => dave.describe(docId).access.role === 'viewer' && dave.describe(docId).title === 'Handover', 20000, 'dave admitted by the new owner')
})

test('files set to sync only while open stay offline until opened', async (t) => {
  const { alice, bob } = await people(t, ['alice', 'bob'])
  const docId = await alice.create('docs', 'Quiet')
  await bob.join(alice.invite(docId, 'editor'))
  await until(() => bob.describe(docId).sync.live, 20000, 'initial sync')
  bob.setSyncMode(docId, 'open')
  await until(() => !alice.describe(docId).sync.live, 20000, 'bob to stop syncing')
  editorFor(alice, docId).type('Written while Bob was away.')
  await sleep(1000)
  assert.equal(text(bob, docId), '')
  bob.setOpen(docId, true)
  await until(() => text(bob, docId) === 'Written while Bob was away.', 20000, 'sync on open')
})

test('a Drive moves to another computer and keeps ownership', async (t) => {
  const { alice, bob, testnet } = await people(t, ['alice', 'bob'])
  const docId = await alice.create('docs', 'Thesis')
  editorFor(alice, docId).type('Chapter one.')
  const folder = alice.createFolder('School')
  alice.moveFile(docId, folder)
  await bob.join(alice.invite(docId, 'editor'))
  await until(() => text(bob, docId) === 'Chapter one.', 20000, 'bob synced')
  const userId = alice.identity.userId

  const newDir = tmp()
  const code = newMoveCode()
  const [sent, received] = await Promise.all([
    sendDrive({ code, drive: alice, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } }),
    receiveDrive({ code, dataDir: newDir, isEmpty: () => true, swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  ])
  assert.equal(sent.count, 1)
  assert.equal(received.userId, userId)
  await alice.stop()

  const moved = new Drive({ dataDir: newDir, apps: [docsApp], swarm: swarmOpts(testnet) })
  t.after(() => moved.stop())
  await moved.start()
  assert.equal(moved.identity.userId, userId)
  assert.equal(moved.describe(docId).role, 'owner')
  assert.equal(moved.describe(docId).folderId, folder)
  assert.equal(text(moved, docId), 'Chapter one.')
  assert.ok(moved.invite(docId, 'viewer').includes('cp2.'))
  // Collaborators keep working with the same person on the new computer.
  editorFor(bob, docId).type(' From Bob.')
  await until(() => text(moved, docId) === 'Chapter one. From Bob.', 20000, 'moved drive to sync')
})

test('invite tokens can expire, be single-use, or need approval', () => {
  const dir = tmp()
  const alice = loadOrCreateIdentity(path.join(dir, 'a'))
  const bob = loadOrCreateIdentity(path.join(dir, 'b'))
  const carol = loadOrCreateIdentity(path.join(dir, 'c'))
  const m = Membership.create(alice, 'cd'.repeat(16))
  const soon = m.createInvite(alice, 'editor', { expiresAt: Date.now() + 1000 })
  assert.equal(m.inviteProblem(soon), null)
  assert.equal(m.inviteProblem(soon, { now: Date.now() + 2000 }), 'expired')
  assert.equal(m.inviteProblem({ ...soon, x: soon.x + 60000 }), 'invalid', 'the expiry is signed')

  const once = m.createInvite(alice, 'viewer', { once: true })
  assert.deepEqual(m.roleOf(bob.userId, once), { role: 'viewer', pending: true, gated: true })
  m.admit(alice, { userId: bob.userId, role: 'viewer', enc: bob.encPublic, via: once.i })
  assert.equal(m.roleOf(bob.userId, once).pending, false)
  assert.equal(m.inviteProblem(once, { userId: carol.userId }), 'used')
  assert.equal(m.roleOf(carol.userId, once), null)

  const ask = m.createInvite(alice, 'editor', { ask: true })
  assert.equal(m.roleOf(carol.userId, ask).gated, true)
  // Links from before roles existed don't work on new files.
  assert.equal(m.roleOf(carol.userId, null), null)
})

test('approval links let people in only when the owner says yes', async (t) => {
  const { alice, bob } = await people(t, ['alice', 'bob'])
  const docId = await alice.create('docs', 'Budget')
  editorFor(alice, docId).type('Private numbers.')
  await bob.join(alice.invite(docId, 'editor', { ask: true }))
  await until(() => alice.describe(docId).requests.some((r) => r.userId === bob.identity.userId), 20000, 'request to reach the owner')
  await until(() => bob.describe(docId).access.waitingForApproval, 20000, 'bob to learn he must wait')
  await sleep(1000)
  assert.equal(bob.describe(docId).waitingForPeer, true, 'nothing arrives before approval')
  assert.equal(alice.describe(docId).sync.peers.length, 0)

  alice.approveRequest(docId, bob.identity.userId, 'viewer')
  await until(() => text(bob, docId) === 'Private numbers.', 20000, 'content after approval')
  assert.equal(bob.describe(docId).role, 'viewer', 'the owner can change the role when approving')
  assert.equal(alice.describe(docId).requests.length, 0)
})

test('a one-person link stops working once someone has used it', async (t) => {
  const { alice, bob, carol } = await people(t, ['alice', 'bob', 'carol'])
  const docId = await alice.create('docs', 'Letter')
  editorFor(alice, docId).type('Dear Bob.')
  const link = alice.invite(docId, 'editor', { once: true })
  await bob.join(link)
  await until(() => text(bob, docId) === 'Dear Bob.', 20000, 'bob to get the file')
  await carol.join(link)
  await until(() => carol.describe(docId).access.inviteProblem === 'used', 20000, 'carol to learn the link is used up')
  await sleep(1000)
  assert.equal(carol.describe(docId).waitingForPeer, true)
  assert.equal(text(carol, docId), '')
})

test('expired and old-style links are refused when joining', async (t) => {
  const { alice, bob } = await people(t, ['alice', 'bob'])
  const docId = await alice.create('docs', 'Old')
  const expired = alice.invite(docId, 'editor', { expiresIn: 1 })
  await sleep(5)
  await assert.rejects(bob.join(expired), /expired/)
  await assert.rejects(bob.join('commonplace://join/cp1.' + Buffer.alloc(32, 1).toString('base64url')), /older version/)
})
