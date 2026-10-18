// commonForms: respondents add sealed answers and nothing else; only people
// who can edit open them; answers wait on a relay when nobody who can edit
// is online.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import DHT from 'hyperdht'
import * as Y from 'yjs'
import { Drive } from '@commonplace/drive'
import { RelayServer } from '@commonplace/relay'
import { formsApp } from '@commonplace/forms'
import { readQuestions, addQuestion, updateQuestion, missingAnswers } from '@commonplace/forms/model'
import { responsesCsv } from '@commonplace/forms/convert'
import { isResponseUpdate, responseUpdate } from '@commonplace/core'
import { formServices } from '../apps/desktop/src/forms.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-forms-'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, ms = 20000, what = 'condition') {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(100) }
  throw new Error(`timed out waiting for ${what}`)
}

test('only brand-new answers under your own name pass as a response', () => {
  const me = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  assert.equal(isResponseUpdate(responseUpdate(me, { v: 1, box: 'x' }), me), true)
  assert.equal(isResponseUpdate(responseUpdate(other, { v: 1, box: 'x' }), me), false) // someone else's name
  // Anything else: another root, a nested type, a change to an existing entry, a delete.
  const d = new Y.Doc()
  d.getMap('meta').set('title', 'Hacked')
  assert.equal(isResponseUpdate(Y.encodeStateAsUpdate(d), me), false)
  const n = new Y.Doc()
  n.getMap('responses').set(`${me}.0123456789abcdef`, new Y.Map())
  assert.equal(isResponseUpdate(Y.encodeStateAsUpdate(n), me), false)
  const base = new Y.Doc()
  base.getMap('responses').set(`${me}.0123456789abcdef`, { v: 1 })
  const sv = Y.encodeStateVector(base)
  base.getMap('responses').set(`${me}.0123456789abcdef`, { v: 2 })
  assert.equal(isResponseUpdate(Y.encodeStateAsUpdate(base, sv), me), false)
})

test('respondents answer, editors read, and nobody else can', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const make = async (name) => {
    const d = new Drive({ dataDir: tmp(), apps: [formsApp], swarm: swarm(), lan: false })
    d.setProfile({ name })
    await d.start()
    return d
  }
  const owner = await make('Maya')
  const sam = await make('Sam')
  const ana = await make('Ana')
  t.after(async () => { for (const d of [owner, sam, ana]) await d.stop(); await testnet.destroy() })
  const forms = { owner: formServices(owner), sam: formServices(sam), ana: formServices(ana) }
  forms.owner.watch()

  const docId = await owner.create('form', 'Potluck')
  const ydoc = owner.getDoc(docId).ydoc
  const dish = addQuestion(ydoc, { type: 'choice', title: 'What will you bring?' })
  updateQuestion(ydoc, dish, { options: ['Salad', 'Bread', 'Dessert'], required: true })
  forms.owner.setup(docId)
  assert.deepEqual(forms.owner.responses(docId), [])

  const link = owner.invite(docId, 'respondent')
  await sam.join(link)
  await ana.join(link)
  await until(() => sam.describe(docId)?.role === 'respondent' && ana.describe(docId)?.role === 'respondent', 30000, 'both admitted as respondents')
  await until(() => readQuestions(sam.getDoc(docId).ydoc).length === 2, 30000, 'sam to get the questions')

  // A respondent can't change the form.
  sam.getDoc(docId).ydoc.getMap('meta').set('title', 'Sam’s form')
  const [name] = readQuestions(sam.getDoc(docId).ydoc)
  assert.deepEqual(missingAnswers(readQuestions(sam.getDoc(docId).ydoc), {}), [dish])
  forms.sam.submit(docId, { [name.id]: 'Sam', [dish]: 'Bread' })
  forms.ana.submit(docId, { [dish]: 'Dessert' })

  await until(() => forms.owner.responses(docId).length === 2, 30000, 'both answers to reach the owner')
  const got = forms.owner.responses(docId)
  assert.deepEqual(got.map((r) => r.answers[dish]).sort(), ['Bread', 'Dessert'])
  assert.equal(got.find((r) => r.answers[dish] === 'Bread').name, 'Sam')
  assert.equal(ydoc.getMap('meta').get('title'), 'Potluck')
  // Respondents get each other's entries, sealed, and can't open them.
  await until(() => ana.getDoc(docId).ydoc.getMap('responses').size === 2, 30000, 'ana to receive both sealed entries')
  assert.equal(forms.ana.responses(docId), null)
  const csv = forms.owner.csv(docId)
  assert.match(csv, /What will you bring\?/)
  assert.match(csv, /Bread/)
  assert.equal(responsesCsv([], []).trim(), 'Submitted,Name')

  // Making someone an editor gives them the key; they read the earlier answers.
  owner.setMemberRole(docId, sam.me().userId, 'editor')
  await until(() => sam.describe(docId)?.role === 'editor', 30000, 'sam to become an editor')
  await until(() => forms.sam.responses(docId)?.length === 2, 30000, 'sam to open the answers')
})

test('answers wait on a relay until someone who can edit comes online', async (t) => {
  const testnet = await createTestnet(3)
  const swarm = () => ({ dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }), refreshMs: 500 })
  const relay = new RelayServer({ dir: tmp(), swarm: { dht: new DHT({ bootstrap: testnet.bootstrap, host: '127.0.0.1' }) } })
  const address = await relay.start()
  const ownerDir = tmp()
  const opts = { apps: [formsApp], lan: false }
  let owner = new Drive({ dataDir: ownerDir, swarm: swarm(), ...opts })
  const sam = new Drive({ dataDir: tmp(), swarm: swarm(), ...opts })
  t.after(async () => { await owner.stop(); await sam.stop(); await relay.stop(); await testnet.destroy() })
  owner.setProfile({ name: 'Maya' })
  sam.setProfile({ name: 'Sam' })
  await owner.start()
  await sam.start()
  owner.addMyRelay(address)
  const docId = await owner.create('form', 'Survey')
  formServices(owner).setup(docId)
  const link = owner.invite(docId, 'respondent')
  await sam.join(link)
  await until(() => sam.describe(docId)?.role === 'respondent' && readQuestions(sam.getDoc(docId).ydoc).length, 30000, 'sam admitted with the questions')
  await until(() => owner.describe(docId).sync.relays[0]?.online && sam.describe(docId).sync.relays[0]?.online, 30000, 'both on the relay')
  await owner.stop()

  // Sam answers while Maya is offline; the answer waits on the relay.
  const [q] = readQuestions(sam.getDoc(docId).ydoc)
  formServices(sam).submit(docId, { [q.id]: 'Sam from the relay' })
  await sleep(1500)
  await sam.stop()

  owner = new Drive({ dataDir: ownerDir, swarm: swarm(), ...opts })
  await owner.start()
  await until(() => formServices(owner).responses(docId)?.length === 1, 30000, 'the answer to arrive from the relay')
  assert.equal(formServices(owner).responses(docId)[0].answers[q.id], 'Sam from the relay')
})
