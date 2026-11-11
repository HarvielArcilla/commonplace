// A cloud's roster (core/roster.js): a chain signed first by the cloud's
// key and then by its admins.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Roster, loadOrCreateIdentity, newSigningKey, keySigner } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-roster-'))
const person = () => loadOrCreateIdentity(tmp())
const DOC = 'a'.repeat(32)

function cloud () {
  const key = keySigner(newSigningKey())
  const [ada, bo, cy, host] = [person(), person(), person(), person()]
  const r = Roster.create(key, DOC, { name: 'Acme', admins: [{ userId: ada.userId, enc: ada.encPublic }] })
  return { key, ada, bo, cy, host, r }
}

test('admins run the roster, and every copy agrees', () => {
  const { key, ada, bo, cy, host, r } = cloud()
  assert.equal(r.cloud, key.userId)
  assert.equal(r.name, 'Acme')
  assert.deepEqual(r.admins(), [ada.userId])
  r.setMember(ada, { userId: bo.userId, enc: bo.encPublic })
  r.setMember(ada, { userId: cy.userId, enc: cy.encPublic, role: 'admin' })
  r.setMember(cy, { userId: host.userId, enc: host.encPublic, role: 'host' })
  r.setHost(cy, { userId: host.userId, kind: 'server', address: 'office' })
  r.setGroup(ada, { id: 'design', name: 'Design', members: [bo.userId, cy.userId, 'f'.repeat(64)] })
  r.setRule(ada, 'externalSharing', 'deny')
  r.setNodes(ada, ['relay.example.org:49737', 'not a node'])
  r.rename(ada, 'Acme Inc.')

  const copy = new Roster(DOC, r.entries)
  assert.equal(copy.name, 'Acme Inc.')
  assert.deepEqual(copy.admins().sort(), [ada.userId, cy.userId].sort())
  assert.equal(copy.role(bo.userId), 'member')
  assert.deepEqual(copy.hosts(), [{ userId: host.userId, kind: 'server', address: 'office' }])
  assert.deepEqual(copy.groups(), [{ id: 'design', name: 'Design', members: [bo.userId, cy.userId] }], 'only members can be in a group')
  assert.deepEqual(copy.groupsOf(bo.userId), ['design'])
  assert.equal(copy.rule('externalSharing'), 'deny')
  assert.deepEqual(copy.nodes, ['relay.example.org:49737'])

  // Removing someone takes them out of groups too.
  r.remove(ada, bo.userId)
  assert.equal(r.member(bo.userId), null)
  assert.deepEqual(r.groupsOf(bo.userId), [])
})

test('only admins sign, and a cloud keeps an admin', () => {
  const { ada, bo, r } = cloud()
  r.setMember(ada, { userId: bo.userId, enc: bo.encPublic })
  assert.throws(() => r.setMember(bo, { userId: bo.userId, role: 'admin' }), /admins/)
  // A forged entry, signed by a member, doesn't merge.
  const body = { type: 'member', userId: bo.userId, role: 'admin', seq: r.entries.length, prev: r.head.hash, doc: DOC, by: bo.userId, at: Date.now() }
  assert.equal(r.merge([...r.entries, { ...body, sig: r.sign(bo, body) }]), false)
  assert.equal(r.role(bo.userId), 'member')
  // The last admin stays.
  assert.throws(() => r.remove(ada, ada.userId), /at least one admin/)
  assert.throws(() => r.setMember(ada, { userId: ada.userId, role: 'member' }), /at least one admin/)
})

test('two admins at once: every copy keeps the same branch', () => {
  const { ada, bo, cy, r } = cloud()
  r.setMember(ada, { userId: bo.userId, enc: bo.encPublic, role: 'admin' })
  const a = new Roster(DOC, r.entries)
  const b = new Roster(DOC, r.entries)
  a.setMember(ada, { userId: cy.userId, enc: cy.encPublic })
  b.rename(bo, 'Bo’s name')
  const left = new Roster(DOC, a.entries)
  const right = new Roster(DOC, b.entries)
  left.merge(b.entries)
  right.merge(a.entries)
  assert.deepEqual(left.head, right.head)
  assert.equal(left.dropped.length + right.dropped.length, 1, 'one side’s entry is handed back to be made again')
})

test('recovery: a newer generation from the cloud’s key replaces the chain', () => {
  const { key, ada, bo, cy, r } = cloud()
  r.setMember(ada, { userId: bo.userId, enc: bo.encPublic })
  const recovered = Roster.create(key, DOC, { name: 'Acme', admins: [{ userId: cy.userId, enc: cy.encPublic }], gen: 2 })
  assert.equal(r.merge(recovered.entries), true)
  assert.equal(r.gen, 2)
  assert.deepEqual(r.admins(), [cy.userId])
  assert.equal(r.member(bo.userId), null)
  // Older generations and other keys don't take over.
  assert.equal(r.merge(new Roster(DOC, Roster.create(key, DOC, { name: 'Old', admins: [{ userId: ada.userId, enc: ada.encPublic }] }).entries).entries), false)
  const impostor = keySigner(newSigningKey())
  assert.equal(r.merge(Roster.create(impostor, DOC, { name: 'Mine', admins: [{ userId: ada.userId, enc: ada.encPublic }], gen: 3 }).entries), false)
  assert.equal(r.gen, 2)
})

test('an entry from a newer app that limits access stops this one', () => {
  const { ada, r } = cloud()
  const other = new Roster(DOC, r.entries)
  r.append(ada, { type: 'seat-limit', max: 5, critical: true })
  assert.equal(new Roster(DOC, r.entries).needsNewer, true)
  other.append(ada, { type: 'theme', color: 'teal' })
  assert.equal(new Roster(DOC, other.entries).needsNewer, false, 'other unknown entries are skipped')
})
