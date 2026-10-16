// Uploaded files: small ones arrive by themselves, big or risky ones wait
// for a yes, chunks nobody asked for are refused, and shared documents that
// grow too big pause.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive, fileKind, safeFileName, MAX_FILE_BYTES } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'
import { BlobStore, ChunkExchange, sha256 } from '@commonplace/core'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-files-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 30000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}
const writeTemp = (name, bytes) => { const p = path.join(tmp(), name); fs.writeFileSync(p, bytes); return p }

test('names and kinds: what can run code, and names that disguise it', () => {
  assert.equal(fileKind('setup.exe').risky, true)
  assert.equal(fileKind('notes.pdf').kind, 'pdf')
  assert.equal(fileKind('photo.JPG').kind, 'image')
  assert.equal(fileKind('run.sh').kind, 'program')
  assert.equal(fileKind('invoice.html').risky, true)
  assert.equal(fileKind('budget.xlsm').risky, true)
  // "photo<RLO>gpj.exe" shows as "photoexe.jpg" in some places: the trick is removed.
  assert.equal(safeFileName('photo‮gpj.exe'), 'photogpj.exe')
  assert.equal(fileKind(safeFileName('photo‮gpj.exe')).risky, true)
  assert.equal(safeFileName('../../etc/passwd'), '_.._etc_passwd')
  assert.equal(safeFileName('CON.txt'), '_CON.txt')
  assert.equal(safeFileName('   '), 'file')
})

test('chunks: only what was asked for, from who was asked, and what it claims to be', () => {
  const blobs = new BlobStore(tmp())
  const sent = []
  const conn = { id: 'a' }
  const other = { id: 'b' }
  const second = { id: 'c' }
  const peers = [conn]
  const ex = new ChunkExchange({ blobs, types: { WANT: 7, CHUNK: 8, NOCHUNK: 9 }, send: (c, type, docId, plain) => sent.push({ c, type, plain }), links: () => peers })
  const data = Buffer.from('hello chunk')
  const hash = sha256(data)
  const unasked = Buffer.from('not requested')
  // Nobody asked for this: refused.
  ex.onMessage('d', conn, 8, Buffer.concat([Buffer.from(sha256(unasked), 'hex'), unasked]))
  assert.equal(blobs.has(sha256(unasked)), false)
  ex.want('d', [hash])
  assert.equal(sent[0].type, 7)
  // From someone else than the peer asked: refused. Wrong bytes: refused.
  ex.onMessage('d', other, 8, Buffer.concat([Buffer.from(hash, 'hex'), data]))
  assert.equal(blobs.has(hash), false)
  ex.onMessage('d', conn, 8, Buffer.concat([Buffer.from(hash, 'hex'), Buffer.from('tampered')]))
  assert.equal(blobs.has(hash), false)
  // The peer that sent bad bytes isn't asked again; another one is.
  peers.push(second)
  ex.pump('d')
  assert.equal(sent.at(-1).c, second)
  ex.onMessage('d', second, 8, Buffer.concat([Buffer.from(hash, 'hex'), data]))
  assert.equal(blobs.read(hash).toString(), 'hello chunk')
  // Serving: only chunks the file says are its own.
  sent.length = 0
  ex.onMessage('d', conn, 7, Buffer.from(JSON.stringify({ h: [hash] })))
  assert.equal(sent[0].type, 9) // allow() says no: "don't have it"
  ex.destroy()
})

test('files: small ones arrive, big and risky ones wait for a yes', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = async (name) => { const d = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false }); d.setProfile({ name }); await d.start(); return d }
  const maya = await make('Maya')
  const sam = await make('Sam')
  t.after(async () => { await maya.stop(); await sam.stop(); await testnet.destroy() })

  const small = crypto.randomBytes(700 * 1024) // three chunks
  const smallId = await maya.upload(writeTemp('plan.pdf', small))
  const bigId = await maya.upload(writeTemp('video.mp4', crypto.randomBytes(1200 * 1024)))
  const exeId = await maya.upload(writeTemp('tool.exe', crypto.randomBytes(1000)))
  assert.equal(maya.describe(smallId).upload.ready, true)
  assert.equal(maya.describe(smallId).kind, 'file')
  await assert.rejects(() => maya.upload(writeTemp('huge.bin', Buffer.alloc(0)).replace('huge.bin', 'missing.bin')))

  // Sam auto-downloads up to 1 MB in this test.
  sam.setStorageSettings({ autoBytes: 1024 * 1024 })
  for (const id of [smallId, bigId, exeId]) await sam.join(maya.invite(id, 'viewer'))
  await until(() => sam.describe(smallId)?.upload?.ready, 30000, 'the small file to arrive')
  const out = path.join(tmp(), 'plan copy.pdf')
  await sam.uploads.saveTo(smallId, out)
  assert.deepEqual(fs.readFileSync(out), small)

  await until(() => sam.describe(bigId)?.upload?.hold === 'large' && sam.describe(exeId)?.upload?.hold === 'risky', 30000, 'the big and risky files to wait')
  await sleep(1500)
  assert.equal(sam.describe(bigId).upload.progress, 0) // not a byte without a yes
  sam.approveDownload(bigId)
  await until(() => sam.describe(bigId).upload.ready, 30000, 'the big file once approved')

  // Removing my copy frees the space and it doesn't come straight back.
  const before = sam.storageUsage().uploads
  sam.removeDownloadedCopy(smallId)
  assert.ok(sam.storageUsage().uploads < before)
  await sleep(1500)
  assert.equal(sam.describe(smallId).upload.ready, false)
  assert.equal(sam.describe(smallId).upload.hold, 'removed')

  // A new version replaces the old one; the old one's chunks are cleaned up later.
  await maya.uploadVersion(smallId, writeTemp('plan v2.pdf', Buffer.from('second version')))
  assert.equal(maya.describe(smallId).upload.name, 'plan v2.pdf')
  assert.equal(maya.describe(smallId).upload.versions, 2)
  assert.ok(MAX_FILE_BYTES >= 100 * 1024 * 1024)
})

test('a shared document that grows too big pauses until you say to keep going', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const maya = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false })
  const sam = new Drive({ dataDir: tmp(), apps: [docsApp], swarm: swarm(), lan: false, guardBytes: 200 * 1024 })
  t.after(async () => { await maya.stop(); await sam.stop(); await testnet.destroy() })
  await maya.start()
  await sam.start()
  const docId = await maya.create('docs', 'Notes')
  await sam.join(maya.invite(docId, 'editor'))
  await until(() => sam.describe(docId)?.type === 'docs', 30000, 'sam to get the file')
  const ydoc = maya.getDoc(docId).ydoc
  ydoc.transact(() => {
    const p = new Y.XmlElement('paragraph')
    p.insert(0, [new Y.XmlText(crypto.randomBytes(200 * 1024).toString('base64'))])
    ydoc.getXmlFragment(CONTENT_FIELD).push([p])
  }, 'renderer')
  await until(() => sam.describe(docId)?.held, 30000, 'the guard to pause it')
  assert.ok(sam.describe(docId).held.bytes > 200 * 1024)
  assert.equal(sam.engine.status(docId).active, false)
  sam.keepSyncing(docId)
  assert.equal(sam.describe(docId).held, null)
})
