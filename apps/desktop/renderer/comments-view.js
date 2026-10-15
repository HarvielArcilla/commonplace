// Comments and suggestions panel: threads anchored to text, replies,
// resolving, and accepting or rejecting suggested changes, in the order they
// appear in the document.

import { addThread, reply, editMessage, deleteMessage, setResolved, readThreads, recordSuggestions, suggestionAuthor } from '@commonplace/docs/comments'
import { commentAnchors, suggestionList } from '@commonplace/docs/editor'
import { el, ago, toast } from './ui.js'
import { state } from './state.js'
import { openPanel, closePanel, openPanelName } from './panel.js'

let view = null // { o, body, drafts: Map, composing: { quote } | null, active, showResolved }

const canEdit = () => {
  const f = state.files.find((x) => x.docId === state.open?.docId)
  return Boolean(f) && (f.role === 'owner' || f.role === 'editor') && !f.access?.removed
}

const nameOf = (ydoc, userId) => (userId === state.me.userId ? 'You' : ydoc.getMap('people').get(userId)?.name || 'Someone')
const colorOf = (ydoc, userId) => (userId === state.me.userId ? state.me.color : ydoc.getMap('people').get(userId)?.color || '#777777')

// ---- wiring per open document ----------------------------------------------------

// Called once per opened document: keeps highlights and the header count
// current, and re-renders the panel when threads or suggestions change.
export function attachReview (o) {
  const refresh = () => {
    if (state.open !== o) return
    applyHighlights(o)
    updateCount(o)
    if (view?.o === o) scheduleRender()
  }
  const comments = o.ydoc.getMap('comments')
  const suggestions = o.ydoc.getMap('suggestions')
  comments.observeDeep(refresh)
  suggestions.observe(refresh)
  o.editor.on('update', refresh)
  o.cleanup.push(() => { comments.unobserveDeep(refresh); suggestions.unobserve(refresh); o.editor.off('update', refresh) })
  refresh()
}

export function recordMySuggestions (o, ids) {
  recordSuggestions(o.ydoc, ids, state.me.userId)
}

function updateCount (o) {
  const open = readThreads(o.ydoc).filter((t) => !t.resolved).length + suggestionList(o.editor).length
  const badge = document.querySelector('#comment-count')
  badge.hidden = !open
  badge.textContent = String(open)
}

// Resolved comments keep their anchor but lose their highlight; the
// selected one is drawn stronger.
function applyHighlights (o) {
  let style = document.querySelector('#comment-style')
  if (!style) { style = el('style', { id: 'comment-style' }); document.head.append(style) }
  const rules = readThreads(o.ydoc).filter((t) => t.resolved).map((t) => `.cp-comment[data-comment="${CSS.escape(t.id)}"]{background:none;border-bottom-color:transparent}`)
  if (view?.active) rules.push(`.cp-comment[data-comment="${CSS.escape(view.active)}"]{background:var(--comment-strong)}`)
  style.textContent = rules.join('\n')
}

// ---- panel -------------------------------------------------------------------

export function toggleComments () {
  if (openPanelName() === 'comments') { closePanel(); return }
  openComments()
}

export function openComments ({ composing = null } = {}) {
  const o = state.open
  if (!o) return
  if (openPanelName() !== 'comments') {
    const body = openPanel('comments', { title: 'Comments', onClose: () => { view = null; if (state.open === o) applyHighlights(o) } })
    view = { o, body, drafts: new Map(), composing: null, active: null, showResolved: false }
  }
  if (composing) view.composing = composing
  render()
}

// Starts a comment on the selected text.
export function newComment () {
  const o = state.open
  if (!o) return
  if (!canEdit()) { toast('Only people who can edit this file can comment.'); return }
  const { from, to, empty } = o.editor.state.selection
  if (empty) { toast('Select the text you want to comment on.'); return }
  openComments({ composing: { quote: o.editor.state.doc.textBetween(from, to, ' ').slice(0, 300), from, to } })
  queueMicrotask(() => view?.body.querySelector('.composer textarea')?.focus())
}

let renderTimer = null
function scheduleRender () {
  clearTimeout(renderTimer)
  renderTimer = setTimeout(render, 120)
}

function render () {
  const v = view
  if (!v || state.open !== v.o) return
  // Keep whatever is being typed in the panel.
  for (const box of v.body.querySelectorAll('textarea[data-draft]')) v.drafts.set(box.dataset.draft, box.value)
  const focused = document.activeElement?.dataset?.draft
  const { o } = v
  const writable = canEdit()
  const anchors = commentAnchors(o.editor)
  const threads = readThreads(o.ydoc)
  const items = []
  for (const t of threads.filter((x) => !x.resolved)) items.push({ kind: 'thread', pos: anchors.get(t.id)?.from ?? Infinity, t })
  for (const s of suggestionList(o.editor)) items.push({ kind: 'suggestion', pos: s.from, s })
  items.sort((a, b) => a.pos - b.pos)

  const out = []
  if (v.composing) out.push(composer(v))
  if (!items.length && !v.composing) {
    out.push(el('p', { class: 'panel-note' }, writable
      ? 'Select some text and choose Comment to start a discussion. Switch to Suggesting to propose edits others can accept.'
      : 'No comments or suggestions yet.'))
  }
  for (const item of items) out.push(item.kind === 'thread' ? threadCard(v, item.t, anchors.get(item.t.id), writable) : suggestionCard(v, item.s, writable))

  const resolved = threads.filter((x) => x.resolved)
  if (resolved.length) {
    out.push(el('button', { type: 'button', class: 'panel-toggle', 'aria-expanded': String(v.showResolved), onclick: () => { v.showResolved = !v.showResolved; render() } },
      `${v.showResolved ? 'Hide' : 'Show'} ${resolved.length} resolved`))
    if (v.showResolved) for (const t of resolved) out.push(threadCard(v, t, anchors.get(t.id), writable))
  }
  v.body.replaceChildren(...out)
  for (const box of v.body.querySelectorAll('textarea[data-draft]')) box.value = v.drafts.get(box.dataset.draft) || ''
  if (focused) v.body.querySelector(`textarea[data-draft="${CSS.escape(focused)}"]`)?.focus()
}

function composer (v) {
  const box = el('textarea', { rows: '3', 'data-draft': 'new', placeholder: 'Add a comment', 'aria-label': 'New comment' })
  const submit = () => {
    const text = box.value.trim()
    if (!text) return
    const { o } = v
    const { from, to, quote } = v.composing
    const id = addThread(o.ydoc, { quote, userId: state.me.userId, text })
    o.editor.chain().setTextSelection({ from, to }).addComment(id).run()
    v.composing = null
    v.drafts.delete('new')
    v.active = id
    render()
  }
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit() } else if (e.key === 'Escape') { v.composing = null; render() } })
  return el('div', { class: 'review-card composer' },
    el('p', { class: 'review-quote' }, `“${v.composing.quote}”`),
    box,
    el('div', { class: 'review-actions' },
      el('button', { type: 'button', class: 'btn btn-primary', onclick: submit }, 'Comment'),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { v.composing = null; v.drafts.delete('new'); render() } }, 'Cancel')))
}

function select (v, id, anchor) {
  v.active = id
  applyHighlights(v.o)
  if (anchor) {
    v.o.editor.chain().setTextSelection({ from: anchor.from, to: anchor.to }).scrollIntoView().run()
  }
  for (const c of v.body.querySelectorAll('.review-card')) c.classList.toggle('active', c.dataset.id === id)
}

function threadCard (v, t, anchor, writable) {
  const { o } = v
  const messages = t.messages.map((m, i) => {
    const mine = m.userId === state.me.userId
    return el('div', { class: 'message' },
      el('p', { class: 'message-head' },
        el('span', { class: 'message-dot', style: `--c:${colorOf(o.ydoc, m.userId)}`, 'aria-hidden': 'true' }),
        el('strong', {}, nameOf(o.ydoc, m.userId)),
        el('span', { class: 'message-time', title: new Date(m.at).toLocaleString() }, ago(m.at), m.editedAt ? ' (edited)' : '')),
      el('p', { class: 'message-text' }, m.text),
      mine && writable ? el('div', { class: 'message-tools' },
        el('button', { type: 'button', class: 'link-button', onclick: (e) => { e.stopPropagation(); editInPlace(v, t, m) } }, 'Edit'),
        el('button', { type: 'button', class: 'link-button', onclick: (e) => { e.stopPropagation(); deleteMessage(o.ydoc, t.id, m.id, { userId: state.me.userId }); if (i === 0 && t.messages.length === 1) o.editor.commands.removeComment(t.id) } }, 'Delete')) : null)
  })
  const replyBox = writable && !t.resolved ? el('textarea', { rows: '1', 'data-draft': `reply:${t.id}`, placeholder: 'Reply', 'aria-label': 'Reply' }) : null
  const sendReply = () => {
    const text = replyBox.value.trim()
    if (!text) return
    reply(o.ydoc, t.id, { userId: state.me.userId, text })
    v.drafts.delete(`reply:${t.id}`)
    replyBox.value = ''
  }
  replyBox?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply() } })
  return el('div', {
    class: `review-card thread${t.resolved ? ' resolved' : ''}${v.active === t.id ? ' active' : ''}`,
    'data-id': t.id,
    onclick: (e) => { if (!e.target.closest('button, textarea')) select(v, t.id, anchor) }
  },
  el('p', { class: 'review-quote' }, anchor ? `“${anchor.text.slice(0, 160)}”` : el('em', {}, `The text “${t.quote.slice(0, 80)}” was deleted`)),
  ...messages,
  t.resolved ? el('p', { class: 'review-note' }, `Resolved by ${nameOf(o.ydoc, t.resolvedBy)} ${ago(t.resolvedAt)}`) : null,
  replyBox,
  writable ? el('div', { class: 'review-actions' },
    t.resolved
      ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => setResolved(o.ydoc, t.id, false, { userId: state.me.userId }) }, 'Reopen')
      : el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { setResolved(o.ydoc, t.id, true, { userId: state.me.userId }); if (v.active === t.id) v.active = null } }, 'Resolve')) : null)
}

function editInPlace (v, t, m) {
  const card = v.body.querySelector(`.review-card[data-id="${CSS.escape(t.id)}"]`)
  const msg = [...card.querySelectorAll('.message')][t.messages.findIndex((x) => x.id === m.id)]
  const box = el('textarea', { rows: '3', 'data-draft': `edit:${m.id}`, 'aria-label': 'Edit comment' })
  box.value = m.text
  const save = () => { editMessage(v.o.ydoc, t.id, m.id, { userId: state.me.userId, text: box.value }); v.drafts.delete(`edit:${m.id}`) }
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save() } else if (e.key === 'Escape') render() })
  msg.querySelector('.message-text').replaceWith(box)
  msg.querySelector('.message-tools')?.remove()
  box.focus()
}

function suggestionCard (v, s, writable) {
  const { o } = v
  const who = suggestionAuthor(o.ydoc, s.id)
  const parts = []
  if (s.inserted) parts.push(el('p', { class: 'suggest-line' }, el('span', { class: 'suggest-kind' }, 'Add'), el('ins', {}, s.inserted.slice(0, 200))))
  if (s.deleted) parts.push(el('p', { class: 'suggest-line' }, el('span', { class: 'suggest-kind' }, 'Delete'), el('del', {}, s.deleted.slice(0, 200))))
  if (!s.inserted && !s.deleted) parts.push(el('p', { class: 'suggest-line' }, el('span', { class: 'suggest-kind' }, s.kinds.includes('modification') ? 'Formatting change' : 'Change')))
  const run = (cmd) => (e) => { e.stopPropagation(); o.editor.chain().focus()[cmd](s.id).run() }
  return el('div', {
    class: `review-card suggestion${v.active === s.id ? ' active' : ''}`,
    'data-id': s.id,
    onclick: (e) => { if (!e.target.closest('button')) { v.active = s.id; o.editor.chain().setTextSelection(s.from).scrollIntoView().run(); render() } }
  },
  el('p', { class: 'message-head' },
    el('span', { class: 'message-dot', style: `--c:${colorOf(o.ydoc, who?.userId)}`, 'aria-hidden': 'true' }),
    el('strong', {}, who ? nameOf(o.ydoc, who.userId) : 'Someone'),
    el('span', { class: 'message-time' }, who ? `suggested ${ago(who.at)}` : 'suggested')),
  ...parts,
  writable ? el('div', { class: 'review-actions' },
    el('button', { type: 'button', class: 'btn btn-primary', onclick: run('acceptSuggestion') }, 'Accept'),
    el('button', { type: 'button', class: 'btn btn-quiet', onclick: run('rejectSuggestion') }, 'Reject')) : null)
}
