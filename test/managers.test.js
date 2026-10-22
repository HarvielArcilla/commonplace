// People who can share ("managers"): they invite, admit and remove people
// for everyone but the owner and other managers, so a file doesn't wait on
// its owner's computer.
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
import { Membership, loadOrCreateIdentity } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-managers-'))
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

test('the log: managers sign changes to everyone but the owner and other managers', () => {
  const [owner, mia, ed, vi, max] = Array.from({ length: 5 }, () => loadOrCreateIdentity(tmp()))
  const m = Membership.create(owner, 'doc1')
  m.admit(owner, { userId: mia.userId, role: 'manager', enc: mia.encPublic })
  m.admit(owner, { userId: max.userId, role: 'manager', enc: max.encPublic })
  m.admit(owner, { userId: ed.userId, role: 'editor', enc: ed.encPublic })
  assert.ok(m.mayManage(mia.userId))
  assert.ok(!m.mayManage(ed.userId))

  m.admit(mia, { userId: vi.userId, role: 'viewer', enc: vi.encPublic })
  m.setRole(mia, vi.userId, 'commenter')
  m.remove(mia, ed.userId, Buffer.alloc(32, 7))
  assert.equal(new Membership('doc1', m.entries).member(vi.userId).role, 'commenter', 'others accept it')
  assert.equal(m.epoch, 1)
  assert.ok(m.sealedKeyFor(owner.userId, 1), 'the owner gets the new key')

  assert.throws(() => m.setRole(mia, owner.userId, 'viewer'), /not signed/)
  assert.throws(() => m.remove(mia, max.userId, Buffer.alloc(32)), /not signed/)
  assert.throws(() => m.setRole(mia, vi.userId, 'manager'), /not signed/)
  assert.throws(() => m.transfer(mia, mia.userId), /not signed/)
  assert.throws(() => m.append(ed, { type: 'remove', userId: vi.userId }), /Only the owner/)
  assert.throws(() => m.createInvite(mia, 'manager'), /Only the owner can let people share/)

  // Their invites work while they can share, and stop when they can't.
  const token = m.createInvite(mia, 'editor')
  assert.equal(m.inviteProblem(token), null)
  m.setRole(owner, mia.userId, 'editor')
  assert.equal(m.inviteProblem(token), 'invalid')
})

test('a manager lets people in and takes them out while the owner is away', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = (name, dir = tmp()) => { const d = new Drive({ dataDir: dir, apps: [docsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); return d }
  const ownerDir = tmp()
  let owner = make('Olive', ownerDir)
  const mia = make('Mia')
  const sam = make('Sam')
  t.after(async () => { for (const d of [owner, mia, sam]) await d.stop().catch(() => {}); await testnet.destroy() })
  for (const d of [owner, mia, sam]) await d.start()

  const docId = await owner.create('docs', 'Budget')
  write(owner, docId, 'Draft.')
  await mia.join(owner.invite(docId, 'manager'))
  await until(() => mia.describe(docId)?.access?.manage, 20000, 'Mia to be able to share')
  await owner.stop()

  // The owner is away: Mia invites Sam, who gets in.
  await sam.join(mia.invite(docId, 'editor'))
  await until(() => sam.describe(docId)?.access?.role === 'editor' && !sam.describe(docId).access.pending, 20000, 'Sam to be admitted by Mia')
  await until(() => text(sam, docId) === 'Draft.', 20000, 'Sam to get the file')
  write(sam, docId, ' Sam’s line.')
  await until(() => text(mia, docId) === 'Draft. Sam’s line.', 20000, 'Mia to get Sam’s edit')

  // Mia takes Sam out again: a new key, and Sam gets nothing new.
  mia.removeMember(docId, sam.identity.userId)
  await until(() => sam.describe(docId)?.access?.removed, 20000, 'Sam to learn he was removed')
  write(mia, docId, ' After Sam.')
  await sleep(1500)
  assert.equal(text(sam, docId), 'Draft. Sam’s line.')

  // The owner comes back and follows all of it.
  owner = make('Olive', ownerDir)
  await owner.start()
  await until(() => text(owner, docId) === 'Draft. Sam’s line. After Sam.', 30000, 'the owner to catch up')
  // (Sam may reach the owner first with Mia's link, and be let in again on
  // the owner's older log; the owner's log and Mia's then merge, and Mia's
  // computer removes him again.)
  await until(() => owner.getDoc(docId).members.isRemoved(sam.identity.userId), 30000, 'the owner to see Sam removed')
})
