// commonForms app descriptor: what commonDrive needs to create, preview,
// merge and restore forms. The builder and the answer view live in the
// desktop app; sealing answers is in responses.js.

import * as Y from 'yjs'
import { initForm, preview, thumbnail, readQuestions, FORM, QUESTIONS, QUESTION_DATA } from './model.js'

// Conflict units: each question (its whole definition), the description
// and the title.
function units (ydoc) {
  const out = new Map()
  for (const q of readQuestions(ydoc)) {
    const { id, ...props } = q
    out.set(`q|${id}`, { kind: 'question', sig: JSON.stringify(props), text: describe(props), props, prev: null })
  }
  const description = ydoc.getMap(FORM).get('description')
  if (description) out.set('description', { kind: 'description', sig: description, text: description, prev: null })
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

const describe = (q) => [q.title || 'Untitled question', ...(q.options || []).map((o) => `  ○ ${o}`)].join('\n')
const snapshotUnit = (u) => (u?.props ? JSON.stringify(u.props) : null)

// The owner's decision: one version of a question (or the description, or
// the title). 'both' keeps the first version, followed by a copy of the
// second as its own question.
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  const present = picked.filter((v) => v.exists)
  if (rec.kind === 'title') { if (present.length) ydoc.getMap('meta').set('title', present.map((v) => v.text).join(' / ')); return }
  if (rec.kind === 'description') { ydoc.getMap(FORM).set('description', present.map((v) => v.text).join('\n\n')); return }
  const id = rec.unit.slice(2)
  const data = ydoc.getMap(QUESTION_DATA)
  const order = ydoc.getArray(QUESTIONS)
  if (!present.length) {
    const i = order.toArray().indexOf(id)
    if (i >= 0) order.delete(i, 1)
    data.delete(id)
    return
  }
  present.forEach((v, n) => {
    const qid = n === 0 ? id : `${id}-${n}`
    const q = new Y.Map()
    data.set(qid, q)
    for (const [k, val] of Object.entries(JSON.parse(v.snapshot))) q.set(k, val)
    if (order.toArray().includes(qid)) return
    if (n === 0) order.push([qid])
    else order.insert(order.toArray().indexOf(id) + n, [qid])
  })
}

export const formsApp = {
  type: 'form',
  kind: 'form',
  name: 'Form',
  description: 'Questions people answer. Only people who can edit see the answers. Exports answers as .csv.',
  schemaVersion: 1,
  exports: ['csv'],
  initContent (ydoc) { initForm(ydoc) },
  preview,
  thumbnail,
  units,
  resolve,
  snapshotUnit,
  // Answers and the response key aren't part of a version: restoring an
  // old version of the questions never loses answers.
  history: { roots: [{ name: QUESTIONS, type: 'array' }, { name: QUESTION_DATA, type: 'map' }, { name: FORM, type: 'map' }] }
}

export default formsApp
