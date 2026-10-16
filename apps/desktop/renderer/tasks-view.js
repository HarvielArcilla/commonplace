// commonTasks window: lists of cards as a board (drag cards between lists)
// or as a checklist, and a panel for the card you open. Everything edits
// the file's Y.Doc through @commonplace/tasks/model.

import * as Y from 'yjs'
import {
  readLists, cardsIn, readCard, addList, renameList, deleteList, moveList, addCard, updateCard, deleteCard, moveCard,
  counts, LISTS, LIST_DATA, CARDS
} from '@commonplace/tasks/model'
import { $, el, openMenu, confirmAction } from './ui.js'
import { state } from './state.js'
import { toolButton, toolbarGroups, setToolbar, press } from './toolbar.js'
import { countBy, badges } from './comment-marks.js'

const ICON = {
  board: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2.5" width="3.5" height="11" rx="1"/><rect x="6.25" y="2.5" width="3.5" height="7" rx="1"/><rect x="10.5" y="2.5" width="3.5" height="9" rx="1"/></svg>',
  list: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M6 4h8M6 8h8M6 12h8"/><path d="m2 4 .8.8L4.2 3.3M2 8l.8.8 1.4-1.5M2 12l.8.8 1.4-1.5"/></svg>',
  addList: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><rect x="2" y="2.5" width="7" height="11" rx="1"/><path d="M12.5 6v5M10 8.5h5"/></svg>',
  hideDone: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="m5 8 2 2 4-4"/><path d="M2 14 14 2"/></svg>',
  undo: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4 2 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m11 4 3 3-3 3"/><path d="M13.5 7H6a3.5 3.5 0 0 0 0 7h3"/></svg>'
}
const VIEW_KEY = 'commonplace.tasksView'
const DRAG = 'application/x-commonplace-card'

export function mountTasks (o) {
  const v = {
    o,
    ydoc: o.ydoc,
    writable: true,
    layout: loadLayout(),
    hideDone: false,
    open: null, // card id in the panel
    undo: new Y.UndoManager([o.ydoc.getArray(LISTS), o.ydoc.getMap(LIST_DATA), o.ydoc.getMap(CARDS)], { trackedOrigins: new Set([null]) })
  }
  v.main = el('div', { class: 'tasks-main' })
  v.panel = el('aside', { class: 'card-panel', hidden: true, 'aria-label': 'Task' })
  v.root = el('div', { class: 'tasks-app' }, v.main, v.panel)
  $('#desk').replaceChildren(v.root)

  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); o.refreshMargin() }) }
  const roots = [o.ydoc.getArray(LISTS), o.ydoc.getMap(LIST_DATA), o.ydoc.getMap(CARDS)]
  roots.forEach((r) => r.observeDeep(schedule))
  o.awareness.on('change', schedule)
  const onKey = (e) => {
    if (!v.writable || e.target.closest?.('input, textarea, select, [contenteditable]')) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? v.undo.redo() : v.undo.undo() }
    if (e.key === 'Escape' && v.open) openCard(v, null)
  }
  document.addEventListener('keydown', onKey)
  v.destroy = () => {
    cancelAnimationFrame(frame)
    roots.forEach((r) => r.unobserveDeep(schedule))
    o.awareness.off('change', schedule)
    document.removeEventListener('keydown', onKey)
    v.undo.destroy()
  }
  renderToolbar(v)
  render(v)

  return {
    focus: () => {},
    setEditable (writable) { if (writable !== v.writable) { v.writable = writable; render(v) } },
    notes () {
      const { total, done } = counts(v.ydoc)
      return [{ text: total ? `${done} of ${total} done` : 'No tasks yet' }]
    },
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const shown = el('div', { class: 'tasks-app' }, el('div', { class: 'tasks-main' }, board({ ...v, ydoc, writable: false, open: null, preview: true })))
      $('#desk').append(shown)
      return { title: ydoc.getMap('meta').get('title') || '', close () { shown.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    async exportPayload () { return { payload: { names: memberNames(v) } } },
    comments: {
      current: () => { const c = v.open && readCard(v.ydoc, v.open); return c ? { anchor: { kind: 'card', id: c.id }, label: `“${c.title || 'Untitled task'}”` } : null },
      label: (a) => { const c = readCard(v.ydoc, a.id); return c ? `Task “${c.title || 'Untitled task'}”` : null },
      reveal: (a) => { if (readCard(v.ydoc, a.id)) openCard(v, a.id) },
      mark: (threads) => { v.commentCounts = countBy(threads, 'card'); badges(v.main, '.task-card[data-card]', 'data-card', v.commentCounts) }
    },
    exportFormats: { csv: 'Spreadsheet (.csv)', md: 'Checklist (.md)' },
    exportHints: { csv: 'One row per task; opens in commonSheets and Excel', md: 'A Markdown checklist, one section per list' },
    destroy: () => v.destroy()
  }
}

const loadLayout = () => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'board' } catch { return 'board' } }

function members (v) {
  const f = state.files.find((x) => x.docId === v.o.docId)
  const list = f?.members?.length ? f.members : [{ userId: state.me.userId, name: state.me.name }]
  return list.filter((m) => m.role !== 'respondent')
}
const memberNames = (v) => Object.fromEntries(members(v).map((m) => [m.userId, m.userId === state.me.userId ? state.me.name : m.name]))

// Who else has which card open (for a colored outline and their name).
function peersOn (v) {
  const out = new Map()
  for (const [clientId, s] of v.o.awareness.getStates()) {
    if (clientId === v.ydoc.clientID || !s.user || !s.card) continue
    out.set(s.card, s.user)
  }
  return out
}

// ---- drawing ---------------------------------------------------------------------

function render (v) {
  if (v.open && !readCard(v.ydoc, v.open)) openCard(v, null)
  const scroll = v.main.firstChild?.scrollLeft || 0
  const top = v.main.scrollTop
  // Don't redraw under someone typing a new card's title or a list name.
  if (v.main.contains(document.activeElement) && document.activeElement.matches('input')) return
  v.main.replaceChildren(v.layout === 'list' ? checklist(v) : board(v))
  if (v.main.firstChild) v.main.firstChild.scrollLeft = scroll
  v.main.scrollTop = top
  drawPanel(v)
  syncToolbar(v)
  badges(v.main, '.task-card[data-card]', 'data-card', v.commentCounts)
}

function board (v) {
  const peers = v.preview ? new Map() : peersOn(v)
  const lists = readLists(v.ydoc)
  return el('div', { class: 'board' },
    ...lists.map((l) => {
      const cards = cardsIn(v.ydoc, l.id).filter((c) => !v.hideDone || !c.done)
      const column = el('section', { class: 'board-list', 'aria-label': l.name || 'Untitled list' },
        el('header', { class: 'list-head' },
          el('h2', { class: 'list-name', ondblclick: () => v.writable && renameInline(v, l) }, l.name || 'Untitled list'),
          el('span', { class: 'list-count' }, String(cardsIn(v.ydoc, l.id).length)),
          v.writable ? el('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: 'List options', 'aria-label': `Options for ${l.name}`, onclick: (e) => listMenu(v, e.currentTarget, l) }, '⋯') : null),
        el('div', { class: 'list-cards' }, ...cards.map((c) => cardNode(v, c, peers.get(c.id)))),
        v.writable ? el('button', { type: 'button', class: 'add-card', onclick: (e) => newCardInline(v, l.id, e.currentTarget) }, '+ Add a task') : null)
      if (v.writable) wireDrop(v, column, l.id)
      return column
    }),
    v.writable ? el('button', { type: 'button', class: 'add-list', onclick: () => { const id = addList(v.ydoc, 'New list'); requestAnimationFrame(() => renameInline(v, { id, name: 'New list' })) } }, '+ Add a list') : null)
}

function cardNode (v, c, peer) {
  const node = el('article', {
    class: `task-card${c.done ? ' done' : ''}${v.open === c.id ? ' open' : ''}${peer ? ' peer' : ''}`,
    style: peer ? `--peer:${peer.color}` : null,
    'data-peer': peer?.name || null,
    tabindex: '0',
    draggable: v.writable ? 'true' : null,
    'data-card': c.id,
    onclick: (e) => { if (!e.target.closest('input')) openCard(v, c.id) },
    onkeydown: (e) => { if (e.key === 'Enter') openCard(v, c.id) },
    ondragstart: (e) => { e.dataTransfer.setData(DRAG, c.id); e.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging') },
    ondragend: () => node.classList.remove('dragging')
  },
  el('input', { type: 'checkbox', class: 'task-check', checked: c.done || null, disabled: !v.writable || null, 'aria-label': c.done ? 'Mark not done' : 'Mark done', onchange: (e) => updateCard(v.ydoc, c.id, { done: e.target.checked }) }),
  el('div', { class: 'task-body' },
    el('p', { class: 'task-title' }, c.title || 'Untitled task'),
    meta(v, c)))
  return node
}

function meta (v, c) {
  const bits = []
  if (c.due) {
    const today = new Date().toISOString().slice(0, 10)
    bits.push(el('span', { class: `chip due${!c.done && c.due < today ? ' late' : c.due === today ? ' today' : ''}` }, dueLabel(c.due)))
  }
  if (c.notes) bits.push(el('span', { class: 'chip', title: 'Has notes' }, '≡'))
  if (c.assignee) {
    const name = memberNames(v)[c.assignee] || 'Someone'
    bits.push(el('span', { class: 'chip who', title: `Assigned to ${name}` }, initials(name)))
  }
  return bits.length ? el('div', { class: 'task-meta' }, ...bits) : null
}

const initials = (name) => String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()

function dueLabel (iso) {
  const d = new Date(`${iso}T12:00:00`)
  const today = new Date()
  const days = Math.round((d - new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12)) / 864e5)
  if (days === 0) return 'Today'
  if (days === 1) return 'Tomorrow'
  if (days === -1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

function checklist (v) {
  const peers = peersOn(v)
  return el('div', { class: 'checklist' }, ...readLists(v.ydoc).map((l) => el('section', { class: 'check-group' },
    el('h2', { class: 'list-name' }, l.name || 'Untitled list', el('span', { class: 'list-count' }, String(cardsIn(v.ydoc, l.id).length))),
    ...cardsIn(v.ydoc, l.id).filter((c) => !v.hideDone || !c.done).map((c) => cardNode(v, c, peers.get(c.id))),
    v.writable ? el('button', { type: 'button', class: 'add-card', onclick: (e) => newCardInline(v, l.id, e.currentTarget) }, '+ Add a task') : null)))
}

// Dropping a card on a list: before the card it's dropped over, or at the end.
function wireDrop (v, column, listId) {
  column.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG)) return
    e.preventDefault()
    column.classList.add('drop-over')
    const over = cardUnder(column, e.clientY)
    column.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before'))
    over?.classList.add('drop-before')
  })
  column.addEventListener('dragleave', (e) => { if (!column.contains(e.relatedTarget)) { column.classList.remove('drop-over'); column.querySelectorAll('.drop-before').forEach((n) => n.classList.remove('drop-before')) } })
  column.addEventListener('drop', (e) => {
    const id = e.dataTransfer.getData(DRAG)
    column.classList.remove('drop-over')
    if (!id) return
    e.preventDefault()
    const before = cardUnder(column, e.clientY)?.dataset.card || null
    if (before !== id) moveCard(v.ydoc, id, listId, before)
  })
}

function cardUnder (column, y) {
  return [...column.querySelectorAll('.task-card:not(.dragging)')].find((n) => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2 }) || null
}

function newCardInline (v, listId, button) {
  const input = el('input', { class: 'new-card-input', placeholder: 'What needs doing?', 'aria-label': 'New task' })
  button.replaceWith(input)
  input.focus()
  let done = false
  const commit = (again) => {
    if (done) return // Enter, then the blur it causes
    done = true
    const title = input.value.trim()
    input.blur()
    if (title) addCard(v.ydoc, listId, title)
    render(v)
    if (title && again) requestAnimationFrame(() => [...v.main.querySelectorAll('.board-list, .check-group')][readLists(v.ydoc).findIndex((l) => l.id === listId)]?.querySelector('.add-card')?.click())
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(true) }
    if (e.key === 'Escape') { input.value = ''; commit(false) }
  })
  input.addEventListener('blur', () => { if (input.isConnected) commit(false) }, { once: true })
}

function renameInline (v, l) {
  const head = [...v.main.querySelectorAll('.board-list')][readLists(v.ydoc).findIndex((x) => x.id === l.id)]?.querySelector('.list-name')
  if (!head) return
  const input = el('input', { class: 'list-name-input', value: l.name, 'aria-label': 'List name' })
  head.replaceWith(input)
  input.select()
  let finished = false
  const done = () => { if (finished) return; finished = true; const name = input.value.trim(); input.blur(); if (name) renameList(v.ydoc, l.id, name); render(v) }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') { input.value = ''; done() } })
  input.addEventListener('blur', () => { if (input.isConnected) done() }, { once: true })
}

function listMenu (v, anchor, l) {
  const lists = readLists(v.ydoc)
  const i = lists.findIndex((x) => x.id === l.id)
  openMenu(anchor, [
    { label: 'Rename', onSelect: () => renameInline(v, l) },
    { label: 'Move left', disabled: i === 0, onSelect: () => moveList(v.ydoc, l.id, -1) },
    { label: 'Move right', disabled: i === lists.length - 1, onSelect: () => moveList(v.ydoc, l.id, 1) },
    { label: 'Add a list after', onSelect: () => { const id = addList(v.ydoc, 'New list', { after: l.id }); requestAnimationFrame(() => renameInline(v, { id, name: 'New list' })) } },
    { sep: true },
    {
      label: 'Delete list',
      danger: true,
      onSelect: async () => {
        const n = cardsIn(v.ydoc, l.id).length
        const other = lists.find((x) => x.id !== l.id)
        if (n && !(await confirmAction({ title: `Delete “${l.name}”?`, body: other ? `Its ${n} task${n === 1 ? '' : 's'} move to “${other.name}”.` : `Its ${n} task${n === 1 ? '' : 's'} are deleted too.`, confirm: 'Delete list' }))) return
        deleteList(v.ydoc, l.id)
      }
    }
  ], { label: 'List options' })
}

// ---- the card panel ---------------------------------------------------------------

function openCard (v, id) {
  v.open = id
  v.o.awareness.setLocalStateField('card', id)
  render(v)
  if (id) requestAnimationFrame(() => { const t = v.panel.querySelector('.panel-title'); if (t && !t.value) t.focus() })
}

function drawPanel (v) {
  const c = v.open && readCard(v.ydoc, v.open)
  v.panel.hidden = !c
  if (!c) { v.panel.replaceChildren(); v.panelFor = null; return }
  const ro = !v.writable || null
  if (v.panelFor !== c.id) {
    v.panelFor = c.id
    const patch = (p) => updateCard(v.ydoc, c.id, p)
    v.panel.replaceChildren(
      el('div', { class: 'panel-head' },
        el('h2', {}, 'Task'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-icon', title: 'Close', 'aria-label': 'Close', onclick: () => openCard(v, null) }, '×')),
      el('div', { class: 'card-fields' },
        el('textarea', { class: 'panel-title', rows: '2', placeholder: 'Task', 'aria-label': 'Task', readOnly: ro, oninput: (e) => patch({ title: e.target.value.replace(/\n/g, ' ') }) }),
        el('label', { class: 'check' }, el('input', { type: 'checkbox', class: 'panel-done', disabled: ro, onchange: (e) => patch({ done: e.target.checked }) }), 'Done'),
        el('label', { class: 'field' }, 'List', el('select', { class: 'panel-list', disabled: ro, onchange: (e) => moveCard(v.ydoc, c.id, e.target.value, null) })),
        el('label', { class: 'field' }, 'Due', el('input', { type: 'date', class: 'panel-due', readOnly: ro, onchange: (e) => patch({ due: e.target.value || null }) })),
        el('label', { class: 'field' }, 'Assigned to', el('select', { class: 'panel-who', disabled: ro, onchange: (e) => patch({ assignee: e.target.value || null }) })),
        el('label', { class: 'field' }, 'Notes', el('textarea', { class: 'panel-notes', rows: '6', readOnly: ro, placeholder: 'Details, links, steps…', oninput: (e) => patch({ notes: e.target.value }) })),
        v.writable ? el('button', { type: 'button', class: 'btn btn-quiet btn-danger panel-delete', onclick: () => { deleteCard(v.ydoc, c.id); openCard(v, null) } }, 'Delete task') : null,
        el('p', { class: 'fineprint-plain' }, `Added ${new Date(c.created || Date.now()).toLocaleDateString()}`)))
  }
  const set = (sel, value) => { const n = v.panel.querySelector(sel); if (n && document.activeElement !== n) n.value = value ?? '' }
  set('.panel-title', c.title)
  set('.panel-notes', c.notes)
  set('.panel-due', c.due)
  v.panel.querySelector('.panel-done').checked = Boolean(c.done)
  const listSel = v.panel.querySelector('.panel-list')
  listSel.replaceChildren(...readLists(v.ydoc).map((l) => el('option', { value: l.id, selected: l.id === c.list || null }, l.name || 'Untitled list')))
  const who = v.panel.querySelector('.panel-who')
  const names = memberNames(v)
  who.replaceChildren(el('option', { value: '' }, 'Nobody'), ...Object.entries(names).map(([id, name]) => el('option', { value: id, selected: id === c.assignee || null }, id === state.me.userId ? `${name} (you)` : name)))
}

// ---- toolbar ---------------------------------------------------------------------

function renderToolbar (v) {
  const setLayout = (layout) => { v.layout = layout; try { localStorage.setItem(VIEW_KEY, layout) } catch {} render(v) }
  setToolbar(toolbarGroups([
    [toolButton('board', 'Board', ICON.board, () => setLayout('board')), toolButton('list', 'Checklist', ICON.list, () => setLayout('list'))],
    [toolButton('addList', 'Add a list', ICON.addList, () => { setLayout('board'); const id = addList(v.ydoc, 'New list'); requestAnimationFrame(() => renameInline(v, { id, name: 'New list' })) }),
      toolButton('hideDone', 'Hide done tasks', ICON.hideDone, () => { v.hideDone = !v.hideDone; render(v) })],
    [toolButton('undo', 'Undo', ICON.undo, () => v.undo.undo(), { key: 'Mod-Z' }), toolButton('redo', 'Redo', ICON.redo, () => v.undo.redo(), { key: 'Mod-Shift-Z' })]
  ]))
}

function syncToolbar (v) {
  press('board', v.layout === 'board')
  press('list', v.layout === 'list')
  press('hideDone', v.hideDone)
}
