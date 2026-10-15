// Comment threads and suggestion counts, as stored in the document.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { addThread, reply, editMessage, deleteMessage, setResolved, readThreads, recordSuggestions, reviewCounts } from '@commonplace/docs/comments'
import { CONTENT_FIELD } from '@commonplace/docs'

const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

test('two people replying at once both land in the thread', () => {
  const a = new Y.Doc()
  const b = new Y.Doc()
  const id = addThread(a, { quote: 'Friday', userId: 'alice', text: 'Thursday instead?' })
  sync(a, b)
  reply(a, id, { userId: 'alice', text: 'Or Saturday.' })
  reply(b, id, { userId: 'bob', text: 'Thursday works.' })
  sync(a, b)
  const [ta] = readThreads(a)
  assert.equal(ta.messages.length, 3)
  assert.deepEqual(readThreads(b)[0].messages.map((m) => m.text), ta.messages.map((m) => m.text))
})

test('only a message’s author can change it; resolving and replying', () => {
  const d = new Y.Doc()
  const id = addThread(d, { quote: 'x', userId: 'alice', text: 'First' })
  const first = readThreads(d)[0].messages[0]
  editMessage(d, id, first.id, { userId: 'bob', text: 'Hijacked' })
  assert.equal(readThreads(d)[0].messages[0].text, 'First')
  editMessage(d, id, first.id, { userId: 'alice', text: 'First, edited' })
  assert.equal(readThreads(d)[0].messages[0].text, 'First, edited')
  assert.ok(readThreads(d)[0].messages[0].editedAt)

  setResolved(d, id, true, { userId: 'bob' })
  assert.equal(readThreads(d)[0].resolvedBy, 'bob')
  reply(d, id, { userId: 'carol', text: 'Wait, one more thing' })
  assert.equal(readThreads(d)[0].resolved, false, 'a reply reopens the thread')

  for (const m of readThreads(d)[0].messages) deleteMessage(d, id, m.id, { userId: m.userId })
  assert.equal(readThreads(d).length, 0, 'deleting every message removes the thread')
})

test('counts open comments and pending suggestions for Drive', () => {
  const d = new Y.Doc()
  const frag = d.getXmlFragment(CONTENT_FIELD)
  const p = new Y.XmlElement('paragraph')
  const t = new Y.XmlText()
  p.insert(0, [t])
  frag.insert(0, [p])
  t.insert(0, 'Budget is ')
  t.insert(10, 'two', { deletion: { id: 's1' } })
  t.insert(13, 'three', { insertion: { id: 's1' } })
  t.insert(18, ' dollars.', { insertion: { id: 's2' } })
  recordSuggestions(d, ['s1', 's2'], 'bob')
  addThread(d, { quote: 'Budget', userId: 'alice', text: 'Too low?' })
  const resolved = addThread(d, { quote: 'is', userId: 'alice', text: 'Fine' })
  setResolved(d, resolved, true, { userId: 'alice' })
  assert.deepEqual(reviewCounts(d), { comments: 1, suggestions: 2 })
  assert.equal(d.getMap('suggestions').get('s1').userId, 'bob')
})
