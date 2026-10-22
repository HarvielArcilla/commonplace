// The network keeping itself going: remembered DHT nodes, and bootstrap
// addresses a group can set for itself.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { Drive, NetworkSettings, parseNodes } from '@commonplace/drive'
import { PUBLIC_BOOTSTRAP } from '@commonplace/core'
import { docsApp } from '@commonplace/docs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-net-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('bootstrap addresses: checked, saved, and the public ones can be left out only with another way in', () => {
  assert.deepEqual(parseNodes('a.example.org:49737\n10.0.0.2:1000, 1.2.3.4@b.example.org:5 a.example.org:49737'), { nodes: ['a.example.org:49737', '10.0.0.2:1000', '1.2.3.4@b.example.org:5'], bad: [] })
  assert.deepEqual(parseNodes('no-port nothing:99999').bad, ['no-port', 'nothing:99999'])
  const dir = tmp()
  const n = new NetworkSettings(dir)
  assert.deepEqual(n.swarmOptions(), { nodesFile: path.join(dir, 'dht-nodes.json') }, 'by default, hyperswarm’s own list')
  assert.throws(() => n.set({ publicBootstrap: false }), /Add a bootstrap address/)
  assert.throws(() => n.set({ bootstrap: 'not an address' }), /Not a bootstrap address/)
  n.set({ bootstrap: 'boot.example.org:49737' })
  assert.deepEqual(n.swarmOptions().bootstrap, ['boot.example.org:49737', ...PUBLIC_BOOTSTRAP])
  n.set({ publicBootstrap: false })
  const again = new NetworkSettings(dir)
  assert.deepEqual(again.swarmOptions().bootstrap, ['boot.example.org:49737'], 'saved')
})

test('a computer remembers the DHT nodes it met, and rejoins from them when the bootstrap node is gone', async (t) => {
  const testnet = await createTestnet(4)
  t.after(() => testnet.destroy())
  const dir = tmp()
  const first = new Drive({ dataDir: dir, apps: [docsApp], lan: false, swarm: { bootstrap: testnet.bootstrap } })
  await first.start()
  await first.transport.swarm.dht.fullyBootstrapped()
  await first.stop()
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'dht-nodes.json'), 'utf8')).nodes
  assert.ok(saved.length >= 2, 'remembered the nodes it met')
  assert.ok(saved.every((n) => n.host && n.port))

  // Start again with a bootstrap address that answers nothing: the
  // remembered nodes are enough to join.
  const second = new Drive({ dataDir: dir, apps: [docsApp], lan: false, swarm: { bootstrap: [{ host: '127.0.0.1', port: 1 }] } })
  t.after(() => second.stop())
  await second.start()
  await second.transport.swarm.dht.fullyBootstrapped()
  await sleep(200)
  assert.ok(second.transport.swarm.dht.toArray().length >= 2, 'found the network from memory')
  assert.equal(second.networkInfo().overridden, true)
  second.forgetNetworkNodes()
  assert.equal(fs.existsSync(path.join(dir, 'dht-nodes.json')), false)
})
