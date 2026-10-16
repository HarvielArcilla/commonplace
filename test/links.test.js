// Links between the apps: action items from a document (with person and
// date chips) to a task board, dates to a calendar, and due dates read
// back for calendars.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { tasksApp } from '@commonplace/tasks'
import { readLists, cardsIn } from '@commonplace/tasks/model'
import { allEvents } from '@commonplace/calendar/model'
import { actionItems } from '@commonplace/docs/editor'
import { Chip } from '../packages/docs/src/chips.js'
import { linkServices } from '../apps/desktop/src/links.js'

const chip = (kind, ref, label) => ({ type: 'chip', attrs: { kind, ref, label } })
const text = (t) => ({ type: 'text', text: t })

test('action items: chips assign and date, the rest is the title', () => {
  const schema = getSchema([StarterKit, Chip])
  const doc = schema.nodeFromJSON({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [text('Order compost '), chip('person', 'u-sam', 'Sam'), text(' '), chip('date', '2026-10-20', 'Tue, Oct 20')] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('Read '), chip('file', 'd1', 'Budget'), text(' first')] }] }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [chip('date', 'not a day', 'Someday')] }
    ]
  })
  assert.deepEqual(actionItems(doc, 0, doc.content.size), [
    { title: 'Order compost', due: '2026-10-20', assignee: 'u-sam' },
    { title: 'Read Budget first', due: null, assignee: null },
    { title: 'Someday', due: null, assignee: null }
  ])
})

// A Drive with a board, a calendar and a board I can only view.
function fakeDrive () {
  const docs = new Map()
  const add = (docId, kind, role, init) => { const ydoc = new Y.Doc(); init?.(ydoc); docs.set(docId, { docId, kind, role, title: docId, ydoc }) }
  add('board', 'tasks', 'editor', (d) => tasksApp.initContent(d))
  add('theirs', 'tasks', 'viewer', (d) => tasksApp.initContent(d))
  add('cal', 'calendar', 'owner')
  return {
    docs,
    list: () => [...docs.values()].map(({ ydoc, ...f }) => f),
    describe: (id) => { const d = docs.get(id); if (!d) return null; const { ydoc, ...f } = d; return f },
    getDoc: (id) => (docs.get(id) ? { ydoc: docs.get(id).ydoc } : null)
  }
}

test('links: cards on boards you can edit, events on calendars, due dates back', () => {
  const drive = fakeDrive()
  const links = linkServices(drive)
  assert.deepEqual(links.boards().map((b) => b.docId), ['board'])
  assert.deepEqual(links.calendars().map((c) => c.docId), ['cal'])
  const board = drive.docs.get('board').ydoc
  const [todo] = readLists(board)
  const res = links.addCards('board', todo.id, [
    { title: 'Order compost', due: '2026-10-20', assignee: 'u-sam' },
    { title: '  ' },
    { title: 'Fix the gate', due: 'Tuesday' }
  ], { docId: 'notes', title: 'Garden notes' })
  assert.deepEqual(res, { added: 2, list: todo.name })
  const cards = cardsIn(board, todo.id)
  assert.deepEqual(cards.map((c) => [c.title, c.due, c.assignee, c.notes]), [
    ['Order compost', '2026-10-20', 'u-sam', 'From “Garden notes”'],
    ['Fix the gate', null, null, 'From “Garden notes”']
  ])
  assert.throws(() => links.addCards('theirs', readLists(drive.docs.get('theirs').ydoc)[0].id, [{ title: 'x' }]), /only view/)
  assert.throws(() => links.addCards('cal', 'x', [{ title: 'x' }]), /no longer/)

  links.addEvent('cal', { title: 'Order compost', day: '2026-10-20' })
  assert.deepEqual(allEvents(drive.docs.get('cal').ydoc).map((e) => [e.title, e.allDay, e.start, e.end]), [['Order compost', true, '2026-10-20', '2026-10-21']])
  assert.throws(() => links.addEvent('cal', { title: 'x', day: 'soon' }), /isn’t a date/)

  assert.deepEqual(links.dueTasks().map((t) => [t.docId, t.title, t.due, t.done]), [['board', 'Order compost', '2026-10-20', false]])
})
