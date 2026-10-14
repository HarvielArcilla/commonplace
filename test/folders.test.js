import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Drive } from '@commonplace/drive'
import { docsApps } from '@commonplace/docs'
import { readPage } from '@commonplace/docs/page'

test('personal folders organize files and never delete them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-folders-'))
  let drive = new Drive({ dataDir: dir, apps: docsApps, transport: false })
  await drive.start()
  assert.deepEqual(drive.apps().map((a) => a.type), ['markdown', 'paged'])

  const work = drive.createFolder('Work')
  const q3 = drive.createFolder('Q3', work)
  const md = await drive.create('markdown', 'Notes', { folderId: q3 })
  const paged = await drive.create('paged', 'Report')
  assert.equal(readPage(drive.getDoc(paged).ydoc).size, 'letter')
  assert.equal(drive.describe(md).folderId, q3)
  assert.equal(drive.describe(paged).kind, 'paged')

  assert.equal(drive.moveFolder(work, q3), false, 'cannot move a folder into its own subfolder')
  drive.moveFile(paged, work)
  drive.deleteFolder(q3) // Notes moves up into Work
  assert.equal(drive.describe(md).folderId, work)
  assert.equal(drive.listFolders().length, 1)
  await drive.stop()

  // Survives a restart.
  drive = new Drive({ dataDir: dir, apps: docsApps, transport: false })
  await drive.start()
  assert.equal(drive.describe(paged).folderId, work)
  assert.equal(drive.listFolders()[0].name, 'Work')
  drive.deleteFolder(work)
  assert.equal(drive.describe(md).folderId, null)
  assert.equal(drive.list().length, 2)
  await drive.stop()
})
