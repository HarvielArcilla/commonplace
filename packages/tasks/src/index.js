// commonTasks app descriptor: what commonDrive needs to create, preview,
// merge and restore task boards. The board lives in the desktop app.

import * as Y from 'yjs'
import { initTasks, preview, thumbnail, allCards, readLists, LISTS, LIST_DATA, CARDS } from './model.js'
import { taskTemplates } from './templates.js'

// Conflict units: each card (everything but its exact place in the list),
// each list's name, and the title.
function units (ydoc) {
  const out = new Map()
  for (const c of allCards(ydoc)) {
    const { id, pos, ...props } = c
    out.set(`card|${id}`, { kind: 'card', sig: JSON.stringify(props), text: [c.title || 'Untitled task', c.notes].filter(Boolean).join('\n'), props: c, prev: null })
  }
  for (const l of readLists(ydoc)) out.set(`list|${l.id}`, { kind: 'list', sig: l.name, text: l.name, prev: null })
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

const snapshotUnit = (u) => (u?.props ? JSON.stringify(u.props) : null)

// The owner's decision: one version of a card (or list name, or title).
// 'both' keeps the first and adds the second as another card.
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  const present = picked.filter((v) => v.exists)
  if (rec.kind === 'title') { if (present.length) ydoc.getMap('meta').set('title', present.map((v) => v.text).join(' / ')); return }
  const [kind, id] = rec.unit.split('|')
  if (kind === 'list') { if (present.length) ydoc.getMap(LIST_DATA).get(id)?.set('name', present.map((v) => v.text).join(' / ')); return }
  const cards = ydoc.getMap(CARDS)
  if (!present.length) { cards.delete(id); return }
  present.forEach((v, n) => {
    const { id: _old, ...props } = JSON.parse(v.snapshot)
    const c = new Y.Map()
    cards.set(n === 0 ? id : `${id}-${n}`, c)
    for (const [k, val] of Object.entries(props)) c.set(k, n && k === 'pos' ? val + 0.5 : val) // the copy goes just below
  })
}

export const tasksApp = {
  type: 'tasks',
  kind: 'tasks',
  name: 'Task board',
  description: 'Lists of tasks with due dates and people, as a board or a checklist. Exports .csv and Markdown.',
  schemaVersion: 1,
  exports: ['csv', 'md'],
  initContent (ydoc) { initTasks(ydoc) },
  preview,
  thumbnail,
  units,
  resolve,
  snapshotUnit,
  templates: taskTemplates,
  history: { roots: [{ name: LISTS, type: 'array' }, { name: LIST_DATA, type: 'map' }, { name: CARDS, type: 'map' }] }
}

export default tasksApp
