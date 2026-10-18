// Access that ends: until a date, or only while the owner is online
// (guests), and what happens to a copy then. Above all: nobody who should
// still have a file loses it when someone else's access ends.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { duplexPair } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Membership, loadOrCreateIdentity } from '@commonplace/core'
import { Drive } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-modes-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 40000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const write = (drive, docId, text) => {
  const ydoc = drive.getDoc(docId).ydoc
  ydoc.transact(() => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(text)])
    ydoc.getXmlFragment(CONTENT_FIELD).push([p])
  }, 'renderer')
}
const read = (drive, docId) => {
  const doc = drive.getDoc(docId)
  return doc ? doc.ydoc.getXmlFragment(CONTENT_FIELD).toString() : ''
}

test('membership: access that ends is signed, honored by everyone, and keeps nobody else out', () => {
  const owner = loadOrCreateIdentity(tmp())
  const sam = loadOrCreateIdentity(tmp())
  const lee = loadOrCreateIdentity(tmp())
  const m = Membership.create(owner, 'doc1')
  const soon = Date.now() + 1000
  m.admit(owner, { userId: sam.userId, role: 'editor', enc: sam.encPublic, until: soon, after: 'hide' })
  m.admit(owner, { userId: lee.userId, role: 'editor', enc: lee.encPublic })
  assert.equal(m.roleOf(sam.userId, null).role, 'editor')
  assert.equal(m.roleOf(sam.userId, null, soon + 1), null)
  assert.deepEqual(m.lapsed(soon + 1), [{ userId: sam.userId, after: 'hide' }])
  // Handing someone a key again keeps when their access ends.
  m.admit(owner, { userId: sam.userId, role: 'editor', enc: sam.encPublic })
  assert.equal(m.member(sam.userId).until, soon)
  // Another peer replaying the log sees the same.
  const copy = new Membership('doc1', m.entries)
  assert.equal(copy.member(sam.userId).until, soon)
  assert.equal(copy.member(sam.userId).after, 'hide')
  // Changing it, and taking it away (never ends).
  m.setAccess(owner, sam.userId, { until: null })
  assert.equal(m.roleOf(sam.userId, null, soon + 1).role, 'editor')
  m.setAccess(owner, sam.userId, { until: soon, after: 'keep' })
  // A new key never goes to someone whose access has ended...
  const ended = new Membership('doc1', m.entries)
  const realNow = Date.now
  Date.now = () => soon + 5
  try {
    ended.rotate(owner, Buffer.alloc(32, 7))
    assert.ok(ended.sealedKeyFor(lee.userId, 1))
    assert.equal(ended.sealedKeyFor(sam.userId, 1), null)
    assert.ok(ended.sealedKeyFor(owner.userId, 1))
  } finally { Date.now = realNow }
  // ...and removing them records what their computer does with its copy.
  m.remove(owner, sam.userId, Buffer.alloc(32, 9), { after: 'hide' })
  assert.deepEqual(m.removal(sam.userId).after, 'hide')
  assert.ok(m.sealedKeyFor(lee.userId, m.epoch))
  // Only the owner can change it, and invites for access that's over don't work.
  assert.throws(() => m.setAccess(lee, lee.userId, { until: null }), /owner/)
  const over = m.createInvite(owner, 'viewer', { until: Date.now() - 10 })
  assert.equal(m.inviteProblem(over), 'expired')
})

async function network (t, names, opts = {}) {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const dirs = {}
  const drives = {}
  const make = async (name) => {
    dirs[name] = dirs[name] || tmp()
    const d = new Drive({ dataDir: dirs[name], apps: [docsApp], swarm: swarm(), lan: false, guestGraceMs: 1500, ...opts })
    d.setProfile({ name })
    await d.start()
    drives[name] = d
    return d
  }
  for (const n of names) await make(n)
  t.after(async () => { for (const d of Object.values(drives)) await d.stop().catch(() => {}); await testnet.destroy() })
  return { drives, make }
}

test('access until a date: it ends everywhere, their copy goes, and everyone else keeps the file', async (t) => {
  const { drives, make } = await network(t, ['Maya', 'Sam', 'Lee'])
  const { Maya: maya, Sam: sam } = drives
  let lee = drives.Lee
  const docId = await maya.create('docs', 'Plan')
  write(maya, docId, 'first')
  const ends = Date.now() + 6000
  await sam.join(maya.invite(docId, 'editor', { access: 'until', until: ends, after: 'hide' }))
  await lee.join(maya.invite(docId, 'editor'))
  await until(() => read(sam, docId).includes('first') && read(lee, docId).includes('first'), 40000, 'both to get the file')
  assert.equal(sam.describe(docId).accessUntil, ends)

  // Lee is offline when Sam's access ends and the key changes.
  const leeDir = lee.dataDir
  await lee.stop()
  await until(() => Date.now() > ends, 10000, 'the end')
  for (const d of [maya, sam]) d.engine.checkEnds()
  await until(() => !maya.engine.membersDetailed(docId).some((m) => m.userId === sam.me().userId), 20000, 'Sam out of Maya’s log')
  assert.ok(maya.engine.getDoc(docId).members.epoch >= 1)
  await until(() => sam.describe(docId)?.ended?.after === 'hide', 20000, 'Sam’s copy to go')
  assert.equal(sam.store.sizeOf(docId), 0)
  assert.ok(!sam.getDoc(docId))

  // New work reaches Lee when he comes back (he gets the new key), not Sam.
  write(maya, docId, 'after the end')
  lee = await make('Lee')
  assert.equal(lee.dataDir, leeDir)
  await until(() => read(lee, docId).includes('after the end'), 40000, 'Lee to get the new key and the edit')
  assert.equal(lee.describe(docId).role, 'editor')
  write(lee, docId, 'from lee')
  await until(() => read(maya, docId).includes('from lee'), 40000, 'Lee’s edit to reach Maya')
  // Sam can still remove the file from his Drive.
  await sam.remove(docId)
  assert.equal(sam.describe(docId), null)
})

test('access that ends with "keep": a read-only copy as it was', async (t) => {
  const { drives } = await network(t, ['Maya', 'Sam'])
  const { Maya: maya, Sam: sam } = drives
  const docId = await maya.create('docs', 'Notes')
  write(maya, docId, 'kept')
  const ends = Date.now() + 5000
  await sam.join(maya.invite(docId, 'editor', { access: 'until', until: ends }))
  await until(() => read(sam, docId).includes('kept'), 40000, 'Sam to get it')
  await until(() => Date.now() > ends, 10000, 'the end')
  for (const d of [maya, sam]) d.engine.checkEnds()
  await until(() => sam.describe(docId)?.ended?.after === 'keep', 20000, 'Sam’s access to end')
  write(maya, docId, 'new')
  write(sam, docId, 'his own')
  await sleep(2500)
  assert.ok(read(sam, docId).includes('kept'))
  assert.ok(!read(sam, docId).includes('new'))
  assert.ok(!read(maya, docId).includes('his own'))
  assert.equal(sam.describe(docId).role, null)
})

test('guests: only while the owner is online, without the file’s keys', async (t) => {
  const { drives, make } = await network(t, ['Maya', 'Lee', 'Gus', 'Ann'])
  let maya = drives.Maya
  const { Lee: lee, Gus: gus, Ann: ann } = drives
  const docId = await maya.create('docs', 'Agenda')
  write(maya, docId, 'item one')
  await lee.join(maya.invite(docId, 'editor'))
  await until(() => read(lee, docId).includes('item one'), 40000, 'Lee to get it')

  const link = maya.invite(docId, 'editor', { access: 'online', after: 'hide' })
  const mirrorId = await gus.join(link)
  assert.notEqual(mirrorId, docId) // a different document: Gus never has the file's secret
  assert.ok(!JSON.stringify(gus.files.toJSON()).includes(maya.files.get(docId).secret))
  await until(() => read(gus, mirrorId).includes('item one'), 40000, 'Gus to see it while Maya is online')
  assert.equal(gus.describe(mirrorId).title, 'Agenda')
  await until(() => gus.describe(mirrorId).guest?.away === false, 20000, 'Gus to see Maya is online')
  assert.equal(gus.describe(mirrorId).guest.after, 'hide')
  // A guest link works for one person only.
  await ann.join(link)
  await sleep(3000)
  assert.equal(read(ann, mirrorId), '')

  // Gus's edits reach the file and everyone in it; theirs reach him.
  write(gus, mirrorId, 'from gus')
  await until(() => read(lee, docId).includes('from gus'), 20000, 'Gus’s edit to reach Lee')
  write(lee, docId, 'from lee')
  await until(() => read(gus, mirrorId).includes('from lee'), 40000, 'Lee’s edit to reach Gus')
  assert.equal(maya.describe(docId).guests.length, 1)
  await until(() => maya.describe(docId).guests[0].guest?.name === 'Gus', 20000, 'Maya to know who used the link')

  // Maya goes offline: Gus's copy goes after the grace period, and Lee's
  // new work doesn't reach him (Lee can't serve him: he has no mirror).
  const mayaDir = maya.dataDir
  await maya.stop()
  await until(() => gus.describe(mirrorId)?.guest?.away && read(gus, mirrorId) === '' && gus.getDoc(mirrorId).ydoc.store.clients.size === 0, 20000, 'Gus’s copy to go while Maya is away')
  write(lee, docId, 'while maya is away')
  await sleep(3000)
  assert.ok(!read(gus, mirrorId).includes('while maya is away'))

  // Maya back: Gus gets everything again, Lee's work included.
  maya = await make('Maya')
  assert.equal(maya.dataDir, mayaDir)
  await until(() => gus.describe(mirrorId).guest.away === false, 20000, 'Gus to see Maya is back')
  assert.equal(gus.describe(mirrorId).guest.away, false)

  // Ending his access: he's out of the mirror, his copy goes, the file is untouched.
  maya.guests.end(mirrorId)
  await until(() => gus.describe(mirrorId)?.ended?.after === 'hide', 30000, 'Gus’s access to end')
  assert.equal(maya.describe(docId).guests.length, 0)
  write(maya, docId, 'after gus')
  await until(() => read(lee, docId).includes('after gus'), 40000, 'Lee to keep working normally')
  assert.equal(lee.describe(docId).role, 'editor')
})

// ---- key logic: nobody who should have a file is left without its key ----------

// Two engines joined by an in-memory stream, with made-up connection keys
// (different for every pair) so the signed hellos check out.
let pairs = 0
function connect (a, b) {
  const [x, y] = duplexPair()
  pairs++
  const ka = crypto.createHash('sha256').update(`a${pairs}`).digest('hex')
  const kb = crypto.createHash('sha256').update(`b${pairs}`).digest('hex')
  a.engine.addConnection(x, { localId: ka, remoteId: kb })
  b.engine.addConnection(y, { localId: kb, remoteId: ka })
  return () => { x.destroy(); y.destroy() }
}

test('two of the owner’s computers ending access at once: everyone left ends up with the same key', async (t) => {
  const aDir = tmp()
  const local = (dir, name) => new Drive({ dataDir: dir, apps: [docsApp], transport: false, lan: false, deviceName: name })
  const a = local(aDir, 'A')
  const lee = local(tmp(), 'Lee')
  const sam = local(tmp(), 'Sam')
  for (const d of [a, lee, sam]) await d.start()
  lee.setProfile({ name: 'Lee' })
  sam.setProfile({ name: 'Sam' })
  const docId = await a.create('docs', 'Budget')
  write(a, docId, 'start')
  const ends = Date.now() + 2500
  await lee.join(a.invite(docId, 'editor'))
  await sam.join(a.invite(docId, 'editor', { access: 'until', until: ends }))
  const cuts = [connect(a, lee), connect(a, sam)]
  await until(() => read(lee, docId).includes('start') && read(sam, docId).includes('start'), 20000, 'both members to get the file')
  cuts.forEach((cut) => cut())

  // Computer B: a copy of A's Drive (as linking makes), offline from A.
  const bDir = tmp()
  await a.stop()
  fs.cpSync(aDir, bDir, { recursive: true })
  fs.rmSync(path.join(bDir, 'device.json'))
  const a2 = local(aDir, 'A')
  const b = local(bDir, 'B')
  await a2.start()
  await b.start()
  t.after(async () => { for (const d of [a2, b, lee, sam]) await d.stop() })

  // Sam's time runs out while A and B are apart: both remove him, each
  // with its own new key.
  await until(() => Date.now() > ends, 10000, 'the end')
  a2.engine.checkEnds()
  b.engine.checkEnds()
  const keyOf = (d) => d.engine.getDoc(docId).epochs.get(d.engine.getDoc(docId).members.epoch)?.secret.toString('hex')
  assert.notEqual(keyOf(a2), keyOf(b))

  // Lee hears from B first, then A and B meet, then Lee meets A.
  const links = [connect(b, lee)]
  await until(() => lee.engine.getDoc(docId).members.epoch === 1, 20000, 'Lee to get B’s key')
  links.push(connect(a2, b))
  await until(() => a2.engine.getDoc(docId).members.head.hash === b.engine.getDoc(docId).members.head.hash, 20000, 'A and B to agree')
  links.push(connect(a2, lee))
  await until(() => lee.engine.getDoc(docId).members.head.hash === a2.engine.getDoc(docId).members.head.hash, 20000, 'Lee to agree too')
  t.after(() => links.forEach((cut) => cut()))

  // One log, one current key, held by every computer that should have it.
  assert.equal(keyOf(lee), keyOf(a2))
  assert.equal(keyOf(b), keyOf(a2))
  assert.equal(lee.describe(docId).role, 'editor')
  assert.ok(!a2.engine.getDoc(docId).members.member(sam.me().userId))
  // And it works: edits flow both ways on the new key.
  write(lee, docId, ' from lee')
  await until(() => read(a2, docId).includes('from lee') && read(b, docId).includes('from lee'), 20000, 'Lee’s edit to reach both')
  write(b, docId, ' from b')
  await until(() => read(lee, docId).includes('from b'), 20000, 'B’s edit to reach Lee')
  // Sam, whose access ended, gets nothing from any of them.
  const samLinks = [connect(sam, lee), connect(sam, a2)]
  t.after(() => samLinks.forEach((cut) => cut()))
  write(lee, docId, ' after sam')
  await sleep(1500)
  assert.ok(!read(sam, docId).includes('after sam'))
})

test('the owner offline when access ends: others refuse at once, and the key changes when the owner is back', async (t) => {
  const aDir = tmp()
  const local = (dir, name) => new Drive({ dataDir: dir, apps: [docsApp], transport: false, lan: false, deviceName: name })
  let maya = local(aDir, 'Maya')
  const lee = local(tmp(), 'Lee')
  const sam = local(tmp(), 'Sam')
  for (const d of [maya, lee, sam]) await d.start()
  const docId = await maya.create('docs', 'Plan')
  write(maya, docId, 'start')
  const ends = Date.now() + 2500
  await lee.join(maya.invite(docId, 'editor'))
  await sam.join(maya.invite(docId, 'editor', { access: 'until', until: ends }))
  const cuts = [connect(maya, lee), connect(maya, sam)]
  await until(() => read(lee, docId).includes('start') && read(sam, docId).includes('start'), 20000, 'both to get it')
  cuts.forEach((cut) => cut())
  await maya.stop()

  // Maya is away. Sam's time ends; Lee refuses him by his own clock.
  await until(() => Date.now() > ends, 10000, 'the end')
  const samLee = connect(sam, lee)
  write(lee, docId, ' lee alone')
  write(sam, docId, ' sam late')
  await sleep(1500)
  assert.ok(!read(sam, docId).includes('lee alone'))
  assert.ok(!read(lee, docId).includes('sam late'))
  samLee()

  // Maya back: she removes Sam and moves to a new key, which Lee gets.
  maya = local(aDir, 'Maya')
  await maya.start()
  t.after(async () => { for (const d of [maya, lee, sam]) await d.stop() })
  maya.engine.checkEnds()
  assert.ok(!maya.engine.getDoc(docId).members.member(sam.me().userId))
  const cut = connect(maya, lee)
  t.after(cut)
  await until(() => lee.engine.getDoc(docId).members.epoch === maya.engine.getDoc(docId).members.epoch && lee.engine.getDoc(docId).epochs.has(maya.engine.getDoc(docId).members.epoch), 20000, 'Lee to get the new key')
  await until(() => read(maya, docId).includes('lee alone'), 20000, 'Lee’s work from while Maya was away')
  assert.equal(lee.describe(docId).role, 'editor')
})
