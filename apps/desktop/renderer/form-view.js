// commonForms window. People who can edit build the form and read the
// answers; respondents fill it in; viewers see it. Questions edit the file's
// Y.Doc through @commonplace/forms/model. Answers are sealed and opened in
// the background process, which holds the keys.

import * as Y from 'yjs'
import {
  readQuestions, readForm, addQuestion, updateQuestion, deleteQuestion, moveQuestion, missingAnswers, isBlank,
  TYPES, FORM, QUESTIONS, QUESTION_DATA
} from '@commonplace/forms/model'
import { $, el, toast, openMenu, cleanError, ago } from './ui.js'
import { state, cp } from './state.js'
import { toolButton, labeledButton, toolbarGroups, setToolbar } from './toolbar.js'

const PLUS = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>'

export function mountForm (o) {
  const v = {
    o,
    ydoc: o.ydoc,
    mode: null, // 'build' | 'answer' | 'view'
    tab: 'questions', // when building: 'questions' | 'answers' | 'preview'
    answers: {}, // what I've filled in so far
    sent: false,
    responses: null, // opened answers (editors)
    undo: new Y.UndoManager([o.ydoc.getArray(QUESTIONS), o.ydoc.getMap(QUESTION_DATA), o.ydoc.getMap(FORM)], { trackedOrigins: new Set([null]) })
  }
  v.root = el('div', { class: 'form-app' })
  $('#desk').replaceChildren(v.root)

  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); o.refreshMargin() }) }
  const roots = [o.ydoc.getArray(QUESTIONS), o.ydoc.getMap(QUESTION_DATA), o.ydoc.getMap(FORM), o.ydoc.getMap('responses')]
  roots.forEach((r) => r.observeDeep(schedule))
  // New answers arrive sealed; open them again when the count changes.
  const onResponses = () => { if (v.mode === 'build') loadResponses(v) }
  o.ydoc.getMap('responses').observe(onResponses)
  v.destroy = () => {
    cancelAnimationFrame(frame)
    roots.forEach((r) => r.unobserveDeep(schedule))
    o.ydoc.getMap('responses').unobserve(onResponses)
    v.undo.destroy()
  }

  return {
    focus: () => v.root.querySelector('input, textarea')?.focus({ preventScroll: true }),
    setEditable (writable) {
      const file = state.files.find((f) => f.docId === o.docId)
      const mode = writable ? 'build' : file?.role === 'respondent' ? 'answer' : 'view'
      if (mode === v.mode) return
      v.mode = mode
      if (mode === 'build') { renderToolbar(v); loadResponses(v) } else setToolbar([])
      v.root.replaceChildren()
      render(v)
    },
    notes () {
      const n = v.ydoc.getMap('responses').size
      const form = readForm(v.ydoc)
      const out = [{ text: `${readQuestions(v.ydoc).length} question${readQuestions(v.ydoc).length === 1 ? '' : 's'}` }]
      if (v.mode === 'build') {
        out.push({ text: n ? `${n} answer${n === 1 ? '' : 's'}` : 'No answers yet' })
        if (!form.accepting) out.push({ text: 'Not accepting answers', cls: 'warn' })
      }
      return out
    },
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const shown = el('div', { class: 'form-app' }, fillForm(ydoc, { answers: {}, disabled: true }))
      $('#desk').append(shown)
      return { title: ydoc.getMap('meta').get('title') || '', close () { shown.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    async exportPayload () { return { payload: {} } },
    exportFormats: { csv: 'Answers (.csv)' },
    exportHints: { csv: 'One row per answer; opens in commonSheets, Excel and Google Sheets' },
    destroy: () => v.destroy()
  }
}

async function loadResponses (v) {
  try {
    v.responses = await cp.formResponses(v.o.docId)
  } catch { v.responses = null }
  if (state.open?.view && v.mode === 'build' && v.tab !== 'questions') render(v)
}

// ---- drawing --------------------------------------------------------------------

function render (v) {
  if (!v.mode) return
  if (v.mode === 'build') return renderBuilder(v)
  const form = readForm(v.ydoc)
  if (v.mode === 'view') {
    v.root.replaceChildren(el('p', { class: 'form-banner' }, 'You can see this form but not answer it.'), fillForm(v.ydoc, { answers: {}, disabled: true }))
    return
  }
  if (v.sent) {
    const mine = [...v.ydoc.getMap('responses').keys()].filter((k) => k.startsWith(`${state.me.userId}.`)).length
    v.root.replaceChildren(el('div', { class: 'form-page' },
      el('div', { class: 'form-card form-head' },
        el('h1', { class: 'form-title' }, v.ydoc.getMap('meta').get('title') || 'Untitled form'),
        el('p', { class: 'form-description' }, form.confirmation),
        el('p', { class: 'form-fine' }, sentNote(v)),
        mine > 1 ? el('p', { class: 'form-fine' }, `You’ve answered ${mine} times.`) : null,
        form.accepting ? el('button', { type: 'button', class: 'btn', onclick: () => { v.sent = false; v.answers = {}; render(v) } }, 'Answer again') : null)))
    return
  }
  if (!form.accepting) {
    v.root.replaceChildren(el('p', { class: 'form-banner' }, 'This form isn’t accepting answers right now.'), fillForm(v.ydoc, { answers: {}, disabled: true }))
    return
  }
  if (!form.responseKey) {
    const owner = state.files.find((f) => f.docId === v.o.docId)?.owner?.name || 'its owner'
    v.root.replaceChildren(el('p', { class: 'form-banner' }, `This form isn’t ready for answers yet. It will be once ${owner} has opened it.`), fillForm(v.ydoc, { answers: {}, disabled: true }))
    return
  }
  // Keep what's been typed: only rebuild when the questions change.
  const sig = JSON.stringify(readQuestions(v.ydoc)) + form.description
  if (v.fillSig === sig && v.root.firstChild) return
  v.fillSig = sig
  v.root.replaceChildren(fillForm(v.ydoc, { answers: v.answers, onSubmit: () => submit(v) }))
}

function sentNote (v) {
  const file = state.files.find((f) => f.docId === v.o.docId)
  const owner = file?.owner?.name || 'the form’s owner'
  if ((file?.sync?.peers || []).some((p) => p.role === 'owner' || p.role === 'editor')) return `${owner} has it.`
  return (file?.sync?.helpers || []).length
    ? `It reaches ${owner} through the relay, even if they’re offline now.`
    : `It reaches ${owner} the next time you’re both online. Keep commonplace open until then, or come back later.`
}

async function submit (v) {
  const questions = readQuestions(v.ydoc)
  const missing = missingAnswers(questions, v.answers)
  v.root.querySelectorAll('.form-card.missing').forEach((n) => n.classList.remove('missing'))
  if (missing.length) {
    for (const id of missing) v.root.querySelector(`.form-card[data-q="${id}"]`)?.classList.add('missing')
    v.root.querySelector(`.form-card[data-q="${missing[0]}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    toast(missing.length === 1 ? 'One required question is unanswered.' : `${missing.length} required questions are unanswered.`)
    return
  }
  const answers = Object.fromEntries(questions.filter((q) => !isBlank(v.answers[q.id])).map((q) => [q.id, v.answers[q.id]]))
  try {
    await cp.submitForm(v.o.docId, answers)
    v.sent = true
    v.fillSig = null
    render(v)
  } catch (err) { toast(cleanError(err)) }
}

// The form as people fill it in. answers is filled in place.
function fillForm (ydoc, { answers, disabled = false, onSubmit = null }) {
  const form = readForm(ydoc)
  const questions = readQuestions(ydoc)
  return el('div', { class: 'form-page' },
    el('div', { class: 'form-card form-head' },
      el('h1', { class: 'form-title' }, ydoc.getMap('meta').get('title') || 'Untitled form'),
      form.description ? el('p', { class: 'form-description' }, form.description) : null,
      questions.some((q) => q.required) ? el('p', { class: 'form-fine' }, el('span', { class: 'req' }, '*'), ' Required') : null),
    ...questions.map((q) => el('div', { class: 'form-card', 'data-q': q.id },
      el('p', { class: 'q-title' }, q.title || 'Untitled question', q.required ? el('span', { class: 'req', 'aria-label': 'required' }, ' *') : null),
      q.help ? el('p', { class: 'q-help' }, q.help) : null,
      answerInput(q, answers, disabled))),
    onSubmit ? el('div', { class: 'form-actions' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: onSubmit }, 'Send answers')) : null)
}

function answerInput (q, answers, disabled) {
  const set = (value) => { answers[q.id] = value }
  const name = `q-${q.id}`
  if (q.type === 'long') return el('textarea', { class: 'a-text', rows: '3', disabled: disabled || null, placeholder: 'Your answer', oninput: (e) => set(e.target.value) }, answers[q.id] || '')
  if (q.type === 'date') return el('input', { type: 'date', class: 'a-date', disabled: disabled || null, value: answers[q.id] || '', oninput: (e) => set(e.target.value) })
  if (q.type === 'choice' || q.type === 'checkboxes') {
    const multi = q.type === 'checkboxes'
    return el('div', { class: 'a-options', role: multi ? 'group' : 'radiogroup' }, ...(q.options || []).map((opt) => {
      const checked = multi ? (answers[q.id] || []).includes(opt) : answers[q.id] === opt
      return el('label', { class: 'a-option' },
        el('input', {
          type: multi ? 'checkbox' : 'radio',
          name,
          disabled: disabled || null,
          checked: checked || null,
          onchange: (e) => {
            if (!multi) { set(opt); return }
            const now = new Set(answers[q.id] || [])
            e.target.checked ? now.add(opt) : now.delete(opt)
            set((q.options || []).filter((x) => now.has(x)))
          }
        }), opt)
    }))
  }
  if (q.type === 'dropdown') {
    return el('select', { class: 'tool-select a-select', disabled: disabled || null, onchange: (e) => set(e.target.value || null) },
      el('option', { value: '' }, 'Choose'), ...(q.options || []).map((opt) => el('option', { value: opt, selected: answers[q.id] === opt || null }, opt)))
  }
  if (q.type === 'scale') {
    const low = Number(q.low ?? 1)
    const high = Number(q.high ?? 5)
    const steps = []
    for (let n = low; n <= high; n++) steps.push(n)
    return el('div', { class: 'a-scale' },
      q.lowLabel ? el('span', { class: 'scale-label' }, q.lowLabel) : null,
      ...steps.map((n) => el('label', { class: 'scale-step' },
        el('span', {}, String(n)),
        el('input', { type: 'radio', name, disabled: disabled || null, checked: answers[q.id] === n || null, onchange: () => set(n) }))),
      q.highLabel ? el('span', { class: 'scale-label' }, q.highLabel) : null)
  }
  return el('input', { class: 'a-text', disabled: disabled || null, placeholder: 'Your answer', value: answers[q.id] || '', oninput: (e) => set(e.target.value) })
}

// ---- building ---------------------------------------------------------------------

function renderBuilder (v) {
  if (!v.root.querySelector(':scope > .form-tabs')) {
    v.tabs = el('div', { class: 'form-tabs seg', role: 'tablist' })
    v.body = el('div', { class: 'form-body' })
    v.root.replaceChildren(v.tabs, v.body)
  }
  const n = v.ydoc.getMap('responses').size
  v.tabs.replaceChildren(...[['questions', 'Questions'], ['answers', n ? `Answers (${n})` : 'Answers'], ['preview', 'Preview']].map(([id, label]) =>
    el('button', { type: 'button', role: 'tab', 'aria-pressed': String(v.tab === id), 'aria-selected': String(v.tab === id), onclick: () => { v.tab = id; v.body.replaceChildren(); render(v) } }, label)))
  if (v.tab === 'answers') { v.body.replaceChildren(answersView(v)); return }
  if (v.tab === 'preview') { v.body.replaceChildren(el('p', { class: 'form-banner' }, 'This is what people see. Answers can’t be sent from here.'), fillForm(v.ydoc, { answers: {} })); return }
  drawQuestions(v)
}

// Question cards are kept between renders and updated in place, so typing
// in one isn't disturbed by someone else's change to another.
function drawQuestions (v) {
  let page = v.body.querySelector('.form-page')
  if (!page) {
    page = el('div', { class: 'form-page' })
    v.cards = new Map()
    v.body.replaceChildren(page)
  }
  const form = readForm(v.ydoc)
  const head = page.querySelector('.form-head') || headCard(v)
  const desc = head.querySelector('textarea')
  if (document.activeElement !== desc) desc.value = form.description
  head.querySelector('input[type=checkbox]').checked = form.accepting
  const questions = readQuestions(v.ydoc)
  const keep = new Set(questions.map((q) => q.id))
  for (const [id, card] of v.cards) if (!keep.has(id)) { card.node.remove(); v.cards.delete(id) }
  const nodes = [head]
  for (const q of questions) {
    let card = v.cards.get(q.id)
    if (!card) { card = { node: el('div', { class: 'form-card q-edit', 'data-q': q.id }) }; v.cards.set(q.id, card) }
    updateCard(v, card, q)
    nodes.push(card.node)
  }
  nodes.push(page.querySelector('.form-add') || el('div', { class: 'form-add' }, addButton(v, null)))
  // Reorder only what moved, so focus stays put.
  nodes.forEach((node, i) => { if (page.children[i] !== node) page.insertBefore(node, page.children[i] || null) })
}

function headCard (v) {
  return el('div', { class: 'form-card form-head' },
    el('textarea', { class: 'form-desc-input', rows: '2', placeholder: 'Description (optional)', 'aria-label': 'Form description', oninput: (e) => v.ydoc.getMap(FORM).set('description', e.target.value) }),
    el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => v.ydoc.getMap(FORM).set('accepting', e.target.checked) }), 'Accepting answers'))
}

function updateCard (v, card, q) {
  // Rebuilt only when its shape changes; text is updated in place below.
  const sig = JSON.stringify({ type: q.type, options: (q.options || []).length, low: q.low, high: q.high })
  if (card.sig !== sig || !card.node.firstChild) {
    card.sig = sig
    card.node.replaceChildren(...cardContents(v, q))
  }
  const set = (sel, value) => { const n = card.node.querySelector(sel); if (n && document.activeElement !== n) n.value = value ?? '' }
  set('.q-title-input', q.title)
  set('.q-help-input', q.help)
  set('.q-type', q.type)
  set('.q-low-label', q.lowLabel)
  set('.q-high-label', q.highLabel)
  const req = card.node.querySelector('.q-required')
  if (req) req.checked = Boolean(q.required)
  card.node.querySelectorAll('.opt-input').forEach((input, i) => { if (document.activeElement !== input) input.value = (q.options || [])[i] ?? '' })
}

function cardContents (v, q) {
  const patch = (p) => updateQuestion(v.ydoc, q.id, p)
  const head = el('div', { class: 'q-head' },
    el('input', { class: 'q-title-input', placeholder: 'Question', 'aria-label': 'Question', oninput: (e) => patch({ title: e.target.value }) }),
    el('select', { class: 'tool-select q-type', 'aria-label': 'Question type', onchange: (e) => patch({ type: e.target.value }) },
      ...Object.entries(TYPES).map(([id, t]) => el('option', { value: id }, t.name))))
  const help = el('input', { class: 'q-help-input', placeholder: 'Help text (optional)', 'aria-label': 'Help text', oninput: (e) => patch({ help: e.target.value }) })
  let body
  if (TYPES[q.type]?.options) {
    const options = q.options || []
    // Always from the file, not from when this card was drawn: others may have changed them since.
    const current = () => [...(readQuestions(v.ydoc).find((x) => x.id === q.id)?.options || [])]
    const setOption = (i, value) => { const next = current(); next[i] = value; patch({ options: next }) }
    const removeOption = (i) => { const next = current(); next.splice(i, 1); patch({ options: next }) }
    const insertOption = (at) => { const next = current(); next.splice(at, 0, `Option ${next.length + 1}`); patch({ options: next }) }
    body = el('div', { class: 'q-options' },
      ...options.map((_, i) => el('div', { class: 'q-option' },
        el('span', { class: `opt-mark opt-${q.type}`, 'aria-hidden': 'true' }),
        el('input', { class: 'opt-input', 'aria-label': `Option ${i + 1}`, oninput: (e) => setOption(i, e.target.value), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); insertOption(i + 1); requestAnimationFrame(() => v.cards.get(q.id)?.node.querySelectorAll('.opt-input')[i + 1]?.select()) } } }),
        options.length > 1 ? el('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: 'Remove option', 'aria-label': `Remove option ${i + 1}`, onclick: () => removeOption(i) }, '×') : null)),
      el('button', { type: 'button', class: 'link-button', onclick: () => insertOption(current().length) }, 'Add option'))
  } else if (q.type === 'scale') {
    const num = (key, from, to) => el('select', { class: 'tool-select', 'aria-label': key === 'low' ? 'Lowest value' : 'Highest value', onchange: (e) => patch({ [key]: Number(e.target.value) }) },
      ...Array.from({ length: to - from + 1 }, (_, i) => from + i).map((n) => el('option', { value: String(n), selected: Number(q[key]) === n || null }, String(n))))
    body = el('div', { class: 'q-scale' },
      el('div', { class: 'q-scale-range' }, num('low', 0, 1), el('span', {}, 'to'), num('high', 2, 10)),
      el('input', { class: 'q-low-label', placeholder: 'Label for the lowest (optional)', oninput: (e) => patch({ lowLabel: e.target.value }) }),
      el('input', { class: 'q-high-label', placeholder: 'Label for the highest (optional)', oninput: (e) => patch({ highLabel: e.target.value }) }))
  } else {
    body = el('div', { class: 'q-sample' }, q.type === 'long' ? 'Long answer' : q.type === 'date' ? 'Date' : 'Short answer')
  }
  const foot = el('div', { class: 'q-foot' },
    el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'q-required', onchange: (e) => patch({ required: e.target.checked }) }), 'Required'),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: 'Move up', 'aria-label': 'Move up', onclick: () => moveQuestion(v.ydoc, q.id, -1) }, '↑'),
    el('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: 'Move down', 'aria-label': 'Move down', onclick: () => moveQuestion(v.ydoc, q.id, 1) }, '↓'),
    el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => duplicate(v, q) }, 'Duplicate'),
    el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => deleteQuestion(v.ydoc, q.id) }, 'Delete'))
  return [head, help, body, foot, el('div', { class: 'q-add-after' }, addButton(v, q.id))]
}

function duplicate (v, q) {
  const { id, ...rest } = q
  const copy = addQuestion(v.ydoc, { type: q.type, after: q.id })
  updateQuestion(v.ydoc, copy, rest)
}

function addButton (v, after) {
  return el('button', {
    type: 'button',
    class: 'btn btn-quiet form-add-button',
    onclick: (e) => openMenu(e.currentTarget, Object.entries(TYPES).map(([id, t]) => ({
      label: t.name,
      onSelect: () => {
        const qid = addQuestion(v.ydoc, { type: id, after })
        requestAnimationFrame(() => v.cards.get(qid)?.node.querySelector('.q-title-input')?.focus())
      }
    })), { label: 'Add a question' })
  }, '+ Add question')
}

function renderToolbar (v) {
  setToolbar(toolbarGroups([
    [labeledButton('addQuestion', 'Add question', PLUS, (b) => openMenu(b, Object.entries(TYPES).map(([id, t]) => ({ label: t.name, onSelect: () => { v.tab = 'questions'; addQuestion(v.ydoc, { type: id }) } })), { label: 'Add a question' }))],
    [toolButton('undo', 'Undo', '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4 2 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7"/></svg>', () => v.undo.undo(), { key: 'Mod-Z' }),
      toolButton('redo', 'Redo', '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m11 4 3 3-3 3"/><path d="M13.5 7H6a3.5 3.5 0 0 0 0 7h3"/></svg>', () => v.undo.redo(), { key: 'Mod-Shift-Z' })]
  ]))
}

// ---- answers ---------------------------------------------------------------------

function answersView (v) {
  const all = v.responses
  if (all == null) return el('div', { class: 'form-page' }, el('p', { class: 'form-banner' }, 'You can’t open the answers on this computer yet. Someone who can already read them needs to be online once.'))
  if (!all.length) return el('div', { class: 'form-page' }, el('div', { class: 'form-card' }, el('p', { class: 'q-title' }, 'No answers yet'), el('p', { class: 'q-help' }, 'Share the form with “Can answer”. Answers arrive when the person who answered and anyone who can edit are online at the same time, or through a relay.')))
  const questions = readQuestions(v.ydoc)
  return el('div', { class: 'form-page' },
    el('div', { class: 'form-card form-head' },
      el('p', { class: 'q-title' }, `${all.length} answer${all.length === 1 ? '' : 's'}`),
      el('p', { class: 'q-help' }, `Latest ${ago(all[all.length - 1].at)}. Export them as .csv from Export.`)),
    ...questions.map((q) => summaryCard(q, all)),
    el('div', { class: 'form-card' }, el('p', { class: 'q-title' }, 'Each answer'), ...all.slice().reverse().map((r) => el('details', { class: 'a-one' },
      el('summary', {}, r.name || 'Someone', el('span', { class: 'q-help' }, ` · ${new Date(r.at).toLocaleString()}`)),
      el('dl', {}, ...questions.flatMap((q) => [el('dt', {}, q.title || 'Untitled question'), el('dd', {}, show(r.answers[q.id]))]))))))
}

const show = (value) => (isBlank(value) ? '—' : Array.isArray(value) ? value.join(', ') : String(value))

function summaryCard (q, all) {
  const given = all.map((r) => r.answers[q.id]).filter((a) => !isBlank(a))
  const card = el('div', { class: 'form-card' }, el('p', { class: 'q-title' }, q.title || 'Untitled question'), el('p', { class: 'q-help' }, `${given.length} answer${given.length === 1 ? '' : 's'}`))
  if (TYPES[q.type]?.options || q.type === 'scale') {
    const choices = q.type === 'scale' ? Array.from({ length: Number(q.high ?? 5) - Number(q.low ?? 1) + 1 }, (_, i) => Number(q.low ?? 1) + i) : (q.options || [])
    const counts = new Map(choices.map((c) => [c, 0]))
    for (const a of given) for (const c of (Array.isArray(a) ? a : [a])) counts.set(c, (counts.get(c) || 0) + 1)
    const max = Math.max(1, ...counts.values())
    card.append(el('div', { class: 'bars' }, ...[...counts].map(([c, n]) => el('div', { class: 'bar-row' },
      el('span', { class: 'bar-label' }, String(c)),
      el('span', { class: 'bar-track' }, el('span', { class: 'bar-fill', style: `width:${(n / max) * 100}%` })),
      el('span', { class: 'bar-count' }, String(n))))))
  } else {
    card.append(el('ul', { class: 'a-list' }, ...given.slice(-30).reverse().map((a) => el('li', {}, String(a)))))
  }
  return card
}
