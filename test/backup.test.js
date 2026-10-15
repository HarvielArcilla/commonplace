// Recovery: a backup file and its recovery key bring a whole Drive back on a
// new computer; the wrong key doesn't; and a backup is never overwritten by
// a different identity.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { Drive, Backups, readBackupFile, restoreBackup, newRecoveryKey, normalizeRecoveryKey } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-backup-'))
const open = (dataDir) => new Drive({ dataDir, apps: [docsApp], transport: false, lan: false })

function write (drive, docId, str) {
  const ydoc = drive.getDoc(docId).ydoc
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  ydoc.transact(() => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(str)])
    frag.insert(frag.length, [p])
  }, 'renderer')
}

test('recovery keys: 25 characters, forgiving about how they are typed', () => {
  const key = newRecoveryKey()
  assert.match(key, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/)
  assert.equal(normalizeRecoveryKey(key.toLowerCase().replace(/-/g, ' ')), key.replace(/-/g, ''))
  assert.equal(normalizeRecoveryKey('O0000-IIIII-LLLLL-00000-11111'), '0000011111111110000011111')
  assert.equal(normalizeRecoveryKey('too short'), null)
})

test('a backup restores the identity, folders and files on a new computer, and stays current', async (t) => {
  const oldDir = tmp()
  const newDir = tmp()
  const file = path.join(tmp(), 'my backup.cpbackup')
  let restored
  t.after(async () => {
    await restored?.stop()
    for (const d of [oldDir, newDir, path.dirname(file)]) fs.rmSync(d, { recursive: true, force: true })
  })

  const old = open(oldDir)
  await old.start()
  old.setProfile?.({ name: 'Rosa' })
  const folder = old.createFolder('Letters')
  const doc = await old.create('docs', 'Dear Ada', { folderId: folder })
  write(old, doc, 'First line')
  const backups = new Backups({ drive: old, dataDir: oldDir })
  const { recoveryKey } = backups.create(file)
  assert.ok(fs.existsSync(file))
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o077, 0) // only you can read it
  // Nothing readable in the file, and the key isn't kept anywhere.
  const raw = fs.readFileSync(file)
  assert.ok(!raw.includes('Dear Ada') && !raw.includes('First line'))
  assert.ok(!fs.readFileSync(path.join(oldDir, 'backup.json'), 'utf8').includes(recoveryKey.replace(/-/g, '')))

  // Newer changes reach the same file with the same key.
  write(old, doc, 'Second line')
  assert.equal(backups.refresh().error, null)
  const userId = old.me().userId
  backups.destroy()
  await old.stop()

  assert.throws(() => readBackupFile(file, newRecoveryKey()), /doesn’t open this backup/)
  const { payload, lock } = readBackupFile(file, recoveryKey.toLowerCase())

  const fresh = open(newDir)
  await fresh.start()
  assert.ok(fresh.isEmpty)
  const result = await restoreBackup({ payload, dataDir: newDir, beforeInstall: () => fresh.stop() })
  assert.equal(result.count, 1)

  restored = open(newDir)
  await restored.start()
  assert.equal(restored.me().userId, userId)
  const f = restored.list().find((x) => x.docId === doc)
  assert.equal(f?.title, 'Dear Ada')
  assert.equal(f.folderId, folder)
  assert.equal(restored.listFolders().find((x) => x.id === folder)?.name, 'Letters')
  assert.match(docsApp.preview(restored.getDoc(doc).ydoc), /First line[\s\S]*Second line/)
  assert.equal(restored.list().find((x) => x.docId === doc).role, 'owner')

  // The restored computer keeps the same backup going, same key.
  const again = new Backups({ drive: restored, dataDir: newDir })
  again.adopt(file, lock)
  const before = readBackupFile(file, recoveryKey).payload.createdAt
  write(restored, doc, 'Third line')
  assert.equal(again.refresh().error, null)
  const after = readBackupFile(file, recoveryKey).payload
  assert.ok(after.createdAt >= before)
  assert.equal(after.identity.userId, userId)
  again.destroy()
})

test('a different identity never writes over a backup', async (t) => {
  const aDir = tmp()
  const bDir = tmp()
  const file = path.join(tmp(), 'b.cpbackup')
  let b
  t.after(async () => {
    await b?.stop()
    for (const d of [aDir, bDir, path.dirname(file)]) fs.rmSync(d, { recursive: true, force: true })
  })
  const a = open(aDir)
  await a.start()
  await a.create('docs', 'Mine')
  const backups = new Backups({ drive: a, dataDir: aDir })
  const { recoveryKey } = backups.create(file)
  backups.destroy()
  await a.stop()
  const before = fs.readFileSync(file)

  // Same data folder, but this computer signed out and started over.
  fs.rmSync(path.join(aDir, 'identity.json'))
  fs.rmSync(path.join(aDir, 'files'), { recursive: true })
  b = open(aDir)
  await b.start()
  const kept = new Backups({ drive: b, dataDir: aDir })
  assert.equal(kept.refresh().on, false)
  kept.destroy()
  assert.deepEqual(fs.readFileSync(file), before)
  assert.equal(readBackupFile(file, recoveryKey).payload.docs.length, 1)
})
