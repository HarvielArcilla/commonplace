// Team drives (docs/TEAM-DRIVES.md): the handover in the membership log,
// and a server hosting a drive end to end.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import { Membership, loadOrCreateIdentity } from '@commonplace/core'
import { Drive } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { TeamServer } from '@commonplace/server'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-team-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const text = (drive, docId) => docsApp.preview(drive.getDoc(docId).ydoc)
function write (drive, docId, str) {
  const ydoc = drive.getDoc(docId).ydoc
  ydoc.transact(() => {
    const frag = ydoc.getXmlFragment(CONTENT_FIELD)
    if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
    const t = frag.get(0).get(0)
    t.insert(t.length, str)
  }, 'local')
}

test('the log: a handover lets the drive’s server pass ownership on, once', () => {
  const [owner, server, admin, other] = Array.from({ length: 4 }, () => loadOrCreateIdentity(tmp()))
  const m = Membership.create(owner, 'doc1')
  m.admit(owner, { userId: server.userId, role: 'manager', enc: server.encPublic })
  m.admit(owner, { userId: admin.userId, role: 'editor', enc: admin.encPublic })
  // Without a handover a manager can't move ownership.
  assert.throws(() => new Membership('doc1', m.entries).transfer(server, admin.userId))
  // Only the owner promises one.
  assert.throws(() => m.setHandover(server, { to: server.userId, drive: 'd' }))
  m.setHandover(owner, { to: server.userId, drive: 'drive1' })
  assert.deepEqual(m.handover, { to: server.userId, drive: 'drive1' })
  assert.ok(m.entries.at(-1).critical)
  // The delegate can't make itself owner…
  assert.throws(() => new Membership('doc1', m.entries).transfer(server, server.userId))
  // …but can pass it to someone in the file.
  const after = new Membership('doc1', m.entries)
  after.transfer(server, admin.userId)
  assert.equal(after.owner, admin.userId)
  assert.equal(after.handover, null)
  assert.equal(after.member(owner.userId).role, 'editor')
  // The promise is spent: the server can't move it again.
  after.admit(admin, { userId: other.userId, role: 'viewer', enc: other.encPublic })
  assert.throws(() => new Membership('doc1', after.entries).transfer(server, other.userId))
  // Withdrawing it works too.
  const w = new Membership('doc1', m.entries)
  w.setHandover(owner, { to: null })
  assert.equal(w.handover, null)
})

test('a server hosts a team drive: people get in, and files stay when their owner leaves', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = (name) => { const d = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); return d }
  const server = new TeamServer({ dir: tmp(), name: 'Acme server', swarm: swarm(), lan: false })
  const alice = make('Alice')
  const bob = make('Bob')
  t.after(async () => { for (const d of [alice, bob]) await d.stop().catch(() => {}); await server.stop().catch(() => {}); await testnet.destroy() })
  const { serverId, adminLink } = await server.start()
  for (const d of [alice, bob]) await d.start()
  assert.ok(adminLink, 'a new server offers an admin link')

  // Alice becomes its admin, and asks it for a team drive.
  await alice.join(adminLink)
  await until(() => alice.servers().length === 1 && alice.engine.access(serverId)?.role === 'manager', 20000, 'Alice to become an admin')
  const driveId = await alice.createTeamDrive(serverId, 'Acme design')
  await until(() => alice.teamDrives().some((d) => d.id === driveId && d.admin), 20000, 'Alice to be in the drive')
  assert.equal(alice.teamDrives()[0].host, server.me)

  // A file of hers goes in: she stays its owner, the server hosts it.
  const docId = await alice.create('docs', 'Brief', { folderId: driveId })
  write(alice, docId, 'Plan.')
  const doc = alice.getDoc(docId)
  assert.equal(doc.members.owner, alice.identity.userId)
  assert.equal(doc.members.member(server.me)?.role, 'manager')
  assert.equal(doc.members.handover?.to, server.me)
  assert.equal(alice.driveOfFile(docId)?.id, driveId)
  await until(() => server.drive.getDoc(docId) && text(server.drive, docId) === 'Plan.', 20000, 'the server to have the file')

  // Moving a file out undoes it: no handover, no server, back in My Drive.
  const noteId = await alice.create('docs', 'Notes', { folderId: driveId })
  assert.equal(alice.getDoc(noteId).members.handover?.to, server.me)
  alice.moveFile(noteId, null)
  assert.equal(alice.getDoc(noteId).members.handover, null)
  assert.ok(!alice.getDoc(noteId).members.member(server.me))
  assert.equal(alice.driveOfFile(noteId), null)

  // Someone else's file can't be moved in by anyone but its owner.
  const other = make('Olive')
  await other.start()
  t.after(() => other.stop().catch(() => {}))
  const theirs = await other.create('docs', 'Theirs')
  await alice.join(other.invite(theirs, 'editor'))
  await until(() => alice.engine.access(theirs)?.role === 'editor', 20000, 'Alice to get Olive’s file')
  assert.throws(() => alice.moveFile(theirs, driveId), /Only Olive/)

  // Alice invites Bob to the drive and goes away: the server lets him in.
  const link = alice.invite(driveId, 'editor')
  await alice.stop()
  await bob.join(link)
  await until(() => bob.getDoc(docId) && text(bob, docId) === 'Plan.', 30000, 'Bob to get the file from the server')

  // Bob becomes a drive admin, and Alice leaves the drive: her file passes
  // to Bob, and stays in the drive.
  server.makeDriveAdmin(driveId, bob.identity.userId)
  server.drive.engine.removeMember(driveId, alice.identity.userId)
  await until(() => server.drive.getDoc(docId).members.owner === bob.identity.userId, 20000, 'the handover')
  assert.ok(!server.drive.getDoc(docId).members.member(alice.identity.userId), 'Alice is out of the file')
  await until(() => bob.getDoc(docId).members.owner === bob.identity.userId, 20000, 'Bob to see he owns it')
})
