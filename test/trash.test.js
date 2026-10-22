// The trash and stars: part of each file's Drive entry, so they follow you to
// your other computers; the trash empties itself after a set number of days.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Drive } from '@commonplace/drive'
import { docsApp } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-trash-'))

test('files go to the trash, come back, and are deleted for good only when it empties', async (t) => {
  const drive = new Drive({ dataDir: tmp(), apps: [docsApp], transport: false, lan: false })
  t.after(() => drive.stop())
  await drive.start()
  const a = await drive.create('docs', 'Keep')
  const b = await drive.create('docs', 'Old draft')

  drive.star(a)
  assert.equal(drive.describe(a).starred, true)
  drive.star(a, false)
  assert.equal(drive.describe(a).starred, false)

  drive.trash(b)
  assert.ok(drive.describe(b).trashedAt <= Date.now())
  assert.ok(drive.getDoc(b), 'still here, and still syncing')
  drive.untrash(b)
  assert.equal(drive.describe(b).trashedAt, null)

  // Only what has been in the trash long enough goes when it empties by itself.
  drive.trash(b)
  await drive.emptyTrash({ olderThan: 60e3 })
  assert.ok(drive.describe(b), 'too recent')
  drive._patch(b, { trashedAt: Date.now() - (drive.policy.get('trashDays') + 1) * 86400e3 })
  drive._emptyOldTrash()
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(drive.describe(b), null)
  assert.ok(!drive.getDoc(b))
  assert.ok(drive.describe(a))

  // Emptying it by hand takes everything in it.
  drive.trash(a)
  await drive.emptyTrash()
  assert.equal(drive.list().length, 0)
  assert.equal(drive.policy.get('trashDays'), 30)
})
