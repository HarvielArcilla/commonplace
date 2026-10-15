// Same-network sync with no internet: multicast discovery, direct TCP.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import dgram from 'node:dgram'
import * as Y from 'yjs'
import { Drive } from '@commonplace/drive'
import { docsApp, CONTENT_FIELD } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-lan-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 15000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}

// A port of its own, so this test never meets anything else on the network.
const lan = { port: 47000 + Math.floor(Math.random() * 900), intervalMs: 300 }

// Some machines (a few CI runners) can't multicast even to themselves.
async function multicastWorks () {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  await new Promise((r) => sock.bind(lan.port + 1, r))
  try { sock.addMembership('239.255.77.17'); sock.setMulticastLoopback(true) } catch { sock.close(); return false }
  const heard = new Promise((resolve) => { sock.once('message', () => resolve(true)); setTimeout(() => resolve(false), 1000) })
  sock.send('ping', lan.port + 1, '239.255.77.17')
  const ok = await heard
  sock.close()
  return ok
}

test('two computers on one network sync with no internet at all', async (t) => {
  if (!(await multicastWorks())) { t.skip('multicast is not available on this machine'); return }
  const alice = new Drive({ dataDir: tmp(), apps: [docsApp], transport: false, lan })
  const bob = new Drive({ dataDir: tmp(), apps: [docsApp], transport: false, lan })
  alice.setProfile({ name: 'Alice' })
  t.after(async () => { await alice.stop(); await bob.stop() })
  await alice.start()
  await bob.start()

  // Listen in like any other computer on the network would.
  const heard = []
  const spy = dgram.createSocket({ type: 'udp4', reuseAddr: true })
  spy.on('message', (m) => heard.push(m))
  await new Promise((r) => spy.bind(lan.port, r))
  spy.addMembership('239.255.77.17')
  t.after(() => spy.close())

  const docId = await alice.create('docs', 'Offline notes')
  const ydoc = alice.getDoc(docId).ydoc
  const p = new Y.XmlElement('paragraph')
  p.insert(0, [new Y.XmlText('Written with the internet unplugged.')])
  ydoc.getXmlFragment(CONTENT_FIELD).insert(0, [p])

  await bob.join(alice.invite(docId))
  await until(() => docsApp.preview(bob.getDoc(docId).ydoc) === 'Written with the internet unplugged.', 15000, 'sync over the LAN')
  assert.equal(bob.describe(docId).sync.peers[0]?.name, 'Alice')

  // Announcements never carry a file's topic itself.
  const topics = alice.engine.topicsFor(docId).map((x) => x.toString('hex'))
  assert.ok(heard.length > 0)
  for (const m of heard) for (const topic of topics) assert.ok(!m.toString('hex').includes(topic))
})
