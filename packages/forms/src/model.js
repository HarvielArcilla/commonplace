// commonForms data model, on top of the file's Y.Doc. No DOM code, and no
// keys: sealing and opening answers is in responses.js (main process only).
//
//   ydoc.getMap('form')           description, accepting (bool), confirmation
//   ydoc.getArray('questions')    question ids, in order
//   ydoc.getMap('questionData')   id -> Y.Map {
//                                   type: see TYPES
//                                   title, help: text
//                                   required: bool
//                                   options: string[] (choice, checkboxes, dropdown)
//                                   low, high, lowLabel, highLabel (scale)
//                                 }
//   ydoc.getMap('keyGrants')      _public: the response key (hex X25519 public key);
//                                 userId -> its private half, sealed to that editor.
//                                 Kept apart from what version history restores,
//                                 so restoring never loses the key to old answers.
//   ydoc.getMap('responses')      one entry per answer, sealed (see
//                                 @commonplace/core respond.js)

import * as Y from 'yjs'

export const FORM = 'form'
export const QUESTIONS = 'questions'
export const QUESTION_DATA = 'questionData'
export const KEY_GRANTS = 'keyGrants'
export const PUBLIC_KEY = '_public'

export const TYPES = {
  short: { name: 'Short answer' },
  long: { name: 'Paragraph' },
  choice: { name: 'Multiple choice', options: true },
  checkboxes: { name: 'Checkboxes', options: true },
  dropdown: { name: 'Dropdown', options: true },
  scale: { name: 'Linear scale' },
  date: { name: 'Date' }
}

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

export function initForm (ydoc) {
  ydoc.transact(() => {
    const form = ydoc.getMap(FORM)
    form.set('description', '')
    form.set('accepting', true)
    form.set('confirmation', 'Thanks. Your answers were sent.')
    addQuestion(ydoc, { type: 'short', title: 'Your name' })
  })
}

export function addQuestion (ydoc, { type = 'choice', title = '', after = null } = {}) {
  const id = newId()
  ydoc.transact(() => {
    const q = new Y.Map()
    ydoc.getMap(QUESTION_DATA).set(id, q)
    q.set('type', TYPES[type] ? type : 'short')
    q.set('title', title)
    q.set('help', '')
    q.set('required', false)
    if (TYPES[type]?.options) q.set('options', ['Option 1', 'Option 2'])
    if (type === 'scale') { q.set('low', 1); q.set('high', 5); q.set('lowLabel', ''); q.set('highLabel', '') }
    const order = ydoc.getArray(QUESTIONS)
    const at = after ? order.toArray().indexOf(after) + 1 : order.length
    order.insert(Math.max(0, at), [id])
  })
  return id
}

export function updateQuestion (ydoc, id, patch) {
  const q = ydoc.getMap(QUESTION_DATA).get(id)
  if (!q) return
  ydoc.transact(() => {
    for (const [k, v] of Object.entries(patch)) q.set(k, v)
    if (patch.type && TYPES[patch.type]?.options && !Array.isArray(q.get('options'))) q.set('options', ['Option 1', 'Option 2'])
    if (patch.type === 'scale' && q.get('low') == null) { q.set('low', 1); q.set('high', 5) }
  })
}

export function deleteQuestion (ydoc, id) {
  ydoc.transact(() => {
    const order = ydoc.getArray(QUESTIONS)
    const i = order.toArray().indexOf(id)
    if (i >= 0) order.delete(i, 1)
    ydoc.getMap(QUESTION_DATA).delete(id)
  })
}

export function moveQuestion (ydoc, id, by) {
  const order = ydoc.getArray(QUESTIONS)
  const ids = order.toArray()
  const i = ids.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= ids.length) return
  ydoc.transact(() => { order.delete(i, 1); order.insert(j, [id]) })
}

export function readQuestions (ydoc) {
  const data = ydoc.getMap(QUESTION_DATA)
  const seen = new Set()
  const out = []
  for (const id of ydoc.getArray(QUESTIONS).toArray()) {
    const q = data.get(id)
    if (!q || seen.has(id)) continue // two people moving the same question can leave a duplicate id
    seen.add(id)
    out.push({ id, ...q.toJSON() })
  }
  return out
}

export function readForm (ydoc) {
  const f = ydoc.getMap(FORM)
  return {
    description: f.get('description') || '',
    accepting: f.get('accepting') !== false,
    confirmation: f.get('confirmation') || 'Thanks. Your answers were sent.',
    responseKey: ydoc.getMap(KEY_GRANTS).get(PUBLIC_KEY) || null
  }
}

export const responseCount = (ydoc) => ydoc.getMap('responses').size

// What's missing from a set of answers (ids of required questions left blank).
export function missingAnswers (questions, answers) {
  return questions.filter((q) => q.required && isBlank(answers[q.id])).map((q) => q.id)
}

export const isBlank = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0)

export function preview (ydoc) {
  const qs = readQuestions(ydoc)
  const n = responseCount(ydoc)
  const head = qs.length ? qs.slice(0, 3).map((q) => q.title || 'Untitled question').join(' · ') : 'Empty form'
  return n ? `${head} · ${n} response${n === 1 ? '' : 's'}` : head
}

export function thumbnail (ydoc) {
  return {
    questions: readQuestions(ydoc).slice(0, 4).map((q) => ({ title: q.title || 'Untitled question', type: q.type, options: (q.options || []).slice(0, 3) })),
    responses: responseCount(ydoc)
  }
}
