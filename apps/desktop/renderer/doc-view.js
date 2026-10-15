// The window for an open file, whatever its kind: syncing it with the
// background process, the title, who's here, the margin, sharing, history,
// export and read-only access. What's inside comes from a view:
//
//   docs-view.js    markdown and paged documents
//   sheet-view.js   spreadsheets
//   slides-view.js  presentations
//
// A view is { focus, setEditable(bool), notes(), showConflicts(list),
// preview(update) -> { title, close }, exportPayload(format), exportFormats,
// exportHints, comments, destroy }.

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { $, el, toast, openMenu, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp, statusNotes, renderNotes } from './state.js'
import { shareDialog } from './share.js'
import { conflictsDialog } from './conflicts.js'
import { toggleHistory, closePanel } from './history-view.js'
import { toggleComments, newComment } from './comments-view.js'
import { mountDocs, pageSetupDialog } from './docs-view.js'
import { setToolbar, fitToolbar } from './toolbar.js'
import { mountSheet } from './sheet-view.js'
import { mountSlides } from './slides-view.js'

const VIEWS = { markdown: mountDocs, paged: mountDocs, sheet: mountSheet, slides: mountSlides }

let onClosed = () => {}
export function initDocView ({ onBack }) {
  onClosed = onBack
  $('[data-action="back"]').addEventListener('click', async () => { await closeDocument(); onClosed() })
  $('[data-action="share"]').addEventListener('click', () => { if (state.open) shareDialog(state.open.docId) })
  $('[data-action="export"]').addEventListener('click', (e) => exportMenu(e.currentTarget))
  $('[data-action="page-setup"]').addEventListener('click', () => pageSetupDialog())
  $('[data-action="history"]').addEventListener('click', () => toggleHistory())
  $('[data-action="comments"]').addEventListener('click', () => toggleComments())
  document.addEventListener('keydown', (e) => {
    if (state.open?.view?.comments && (e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); newComment() }
  })
}

// ---- open / close ---------------------------------------------------------------

export async function openDocument (docId, { focusTitle = false, initialContent = null } = {}) {
  await closeDocument()
  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const opened = await cp.openDoc(docId, ydoc.clientID)
  Y.applyUpdate(ydoc, opened.state, 'main')
  awarenessProtocol.applyAwarenessUpdate(awareness, opened.awareness, 'main')
  const kind = opened.file.kind || 'markdown'

  // Window -> background process.
  ydoc.on('update', (update, origin) => { if (origin !== 'main') cp.sendUpdate(docId, update) })
  awareness.on('update', ({ added, updated, removed }, origin) => {
    if (origin === 'main') return
    cp.sendAwareness(docId, awarenessProtocol.encodeAwarenessUpdate(awareness, added.concat(updated, removed)))
  })
  // Background process -> window.
  const cleanup = [
    cp.onDocUpdate((id, update) => { if (id === docId) Y.applyUpdate(ydoc, update, 'main') }),
    cp.onDocAwareness((id, update) => { if (id === docId) awarenessProtocol.applyAwarenessUpdate(awareness, update, 'main') })
  ]

  // Record that this editing session belongs to me (for "written by"), but
  // only once I actually change something: opening a file is not an edit.
  let authored = ydoc.getMap('authors').has(String(ydoc.clientID))
  ydoc.on('update', (_u, origin) => {
    if (authored || origin === 'main') return
    authored = true
    queueMicrotask(() => { if (!ydoc.isDestroyed) ydoc.getMap('authors').set(String(ydoc.clientID), { userId: state.me.userId }) })
  })
  awareness.setLocalStateField('user', { name: state.me.name, color: state.me.color, userId: state.me.userId })

  const desk = $('#desk')
  desk.className = `desk desk-${kind}`
  setToolbar([])
  const o = { docId, kind, ydoc, awareness, editor: null, paper: null, pages: 1, zoom: 1, cleanup, view: null }
  o.refreshMargin = () => { if (state.open === o) renderDocMargin() }
  state.open = o
  o.view = (VIEWS[kind] || mountDocs)(o, { initialContent })

  // Title lives in the shared container metadata.
  const meta = ydoc.getMap('meta')
  const title = $('#doc-title')
  const showTitle = () => { if (document.activeElement !== title && !o.closePreview) title.value = meta.get('title') || '' }
  meta.observe(showTitle)
  cleanup.push(() => meta.unobserve(showTitle))
  showTitle()
  title.oninput = () => meta.set('title', title.value)
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); o.view.focus() } }

  awareness.on('change', renderPresence)

  $('#drive-view').hidden = true
  $('#doc-view').hidden = false
  $('#doc-view').dataset.kind = kind
  $('[data-action="page-setup"]').hidden = kind !== 'paged'
  $('[data-action="comments"]').hidden = !o.view.comments
  renderPresence()
  renderDocMargin()
  if (focusTitle) { title.focus(); title.select() } else o.view.focus()
}

// Shows another state of this file (an old version) read-only in place of
// the live one. Returns a function that puts the live file back.
export function showPreview (update) {
  const o = state.open
  if (!o) return () => {}
  o.closePreview?.()
  const shown = o.view.preview(update)
  $('#doc-view').classList.add('previewing')
  const close = () => {
    if (o.closePreview !== close) return
    o.closePreview = null
    shown.close()
    $('#doc-view').classList.remove('previewing')
    $('#doc-title').value = o.ydoc.getMap('meta').get('title') || ''
    renderDocMargin()
  }
  o.closePreview = close
  $('#doc-title').readOnly = true
  $('#doc-title').value = shown.title
  renderDocMargin()
  return close
}

export async function closeDocument () {
  const o = state.open
  if (!o) return
  o.closePreview?.()
  closePanel()
  state.open = null
  o.awareness.setLocalState(null) // tells everyone my cursor left
  o.cleanup.forEach((fn) => fn())
  o.view?.destroy()
  o.awareness.destroy()
  o.ydoc.destroy()
  await cp.closeDoc(o.docId)
  $('#desk').replaceChildren()
  setToolbar([])
}

// ---- export ----------------------------------------------------------------------

function exportMenu (anchor) {
  const o = state.open
  if (!o) return
  const file = state.files.find((f) => f.docId === o.docId)
  const formats = (file?.exports || []).filter((f) => o.view.exportFormats[f])
  openMenu(anchor, formats.map((fmt) => ({ label: o.view.exportFormats[fmt], hint: o.view.exportHints?.[fmt], icon: icons.download, onSelect: () => exportAs(fmt) })), { align: 'end', label: 'Export' })
}

async function exportAs (format) {
  const o = state.open
  let unprint = null
  try {
    const { payload, note, print } = await o.view.exportPayload(format)
    if (print) unprint = print()
    const saved = await cp.exportFile(o.docId, format, payload)
    if (saved) toast(note ? `Saved ${saved}, ${note}` : `Saved ${saved}`)
  } catch (err) {
    toast(`Couldn’t export: ${cleanError(err)}`)
  } finally {
    unprint?.()
  }
}

// ---- presence and margin ------------------------------------------------------------

function renderPresence () {
  const box = $('#presence')
  box.replaceChildren()
  if (!state.open) return
  const seen = new Set([state.me.userId])
  for (const [clientId, s] of state.open.awareness.getStates()) {
    if (clientId === state.open.ydoc.clientID || !s.user || seen.has(s.user.userId)) continue
    seen.add(s.user.userId)
    const initials = (s.user.name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()
    box.append(el('span', { class: 'avatar', style: `--c:${s.user.color}`, title: `${s.user.name} is here` }, initials))
  }
}

// Viewers (and people who were removed) get a read-only file.
function applyAccess () {
  const o = state.open
  if (!o?.view) return
  const file = state.files.find((f) => f.docId === o.docId)
  const writable = Boolean(file) && (file.role === 'owner' || file.role === 'editor') && !file.access?.removed
  o.view.setEditable(writable)
  $('#doc-title').readOnly = !writable || Boolean(o.closePreview)
  if ($('#toolbar').hidden === writable) { $('#toolbar').hidden = !writable; if (writable) fitToolbar() }
  $('#doc-view').classList.toggle('read-only', !writable)
}

export function renderDocMargin () {
  const o = state.open
  if (!o?.view) return
  applyAccess()
  const file = state.files.find((f) => f.docId === o.docId)
  const notes = file ? statusNotes(file, { detailed: true }) : []
  if (o.closePreview) notes.unshift({ text: 'Showing an earlier version. Nothing here changes unless you restore it.', cls: 'warn' })
  else notes.unshift(...(o.view.notes?.() || []))
  const conflicts = file?.conflicts || []
  const review = conflicts.length
    ? el('button', { type: 'button', class: 'btn margin-action', onclick: () => conflictsDialog(o.docId) }, file.role === 'owner' ? 'Review conflicts' : 'See conflicts')
    : null
  const requests = file?.requests?.length
    ? el('button', { type: 'button', class: 'btn margin-action', onclick: () => shareDialog(o.docId) }, 'Review requests')
    : null
  $('#doc-margin').replaceChildren(el('div', { class: 'margin-inner' }, ...renderNotes(notes), review, requests))
  o.view.showConflicts?.(conflicts)
}
