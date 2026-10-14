// Window UI for CommonDrive and CommonDocs. Talks only to window.commonplace
// (see src/preload.cjs). Bundled by build.mjs into renderer/dist/app.js.

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import { createDocsEditor, docsCommands } from '@commonplace/docs/editor'

const cp = window.commonplace
const $ = (sel) => document.querySelector(sel)

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']

const state = {
  me: null,
  files: [],
  open: null // { docId, ydoc, awareness, editor, cleanup: [] }
}

document.body.classList.toggle('mac', cp.platform === 'darwin')

// ---- small helpers ---------------------------------------------------------

function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'style') node.style.cssText = v
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c)
  return node
}

function ago (ts) {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined })
}

function listNames (people) {
  const names = people.map((p) => p.name)
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

let toastTimer
function toast (msg) {
  const t = $('#toast')
  t.textContent = msg
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, 2600)
}

// Status notes shown in the margin, for the list and for an open document.
function statusNotes (file, { detailed = false } = {}) {
  const notes = []
  const others = file.sync.peers.filter((p) => p.userId !== state.me?.userId)
  if (file.waitingForPeer) {
    notes.push({ text: 'Waiting for someone who has this file to come online', cls: 'warn' })
    return notes
  }
  if (!file.supported) {
    notes.push({ text: 'Made with a newer version of Commonplace', cls: 'warn' })
    return notes
  }
  if (others.length) {
    notes.push({ text: `Live with ${listNames(others)}`, cls: 'live', dot: true })
  } else if (file.sync.lastSyncedAt) {
    const who = file.sync.lastSyncedWith ? ` with ${file.sync.lastSyncedWith}` : ''
    notes.push({ text: `Synced${who} ${ago(file.sync.lastSyncedAt)}` })
  } else {
    notes.push({ text: file.role === 'owner' ? 'Only on this computer so far' : 'Not synced yet' })
  }
  if (file.role !== 'owner' && !file.sync.ownerOnline && file.owner) {
    notes.push({ text: `${file.owner.name || 'The owner'} (owner) is offline` })
  }
  if (file.sync.pending > 0 && file.sync.lastSyncedAt) {
    notes.push({ text: 'Some of your edits are only on this computer', cls: 'warn' })
  }
  if (detailed && !others.length && !file.waitingForPeer) {
    notes.push({ text: 'You can keep writing. Edits are saved here and reach the others when anyone with this file is online at the same time as you.' })
    if (file.sync.lastSyncedAt) notes.push({ text: 'Newer edits may exist on a computer that is offline right now.' })
  }
  return notes
}

function renderNotes (notes) {
  return notes.map((n) => el('span', { class: `note ${n.cls || ''}` }, n.text, n.dot ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null))
}

// ---- CommonDrive -----------------------------------------------------------

function renderDrive () {
  const list = $('#file-list')
  list.replaceChildren()
  $('#me-name').textContent = state.me?.name || ''
  $('#me-swatch').style.setProperty('--swatch', state.me?.color)

  if (!state.files.length) {
    list.append(el('div', { class: 'empty' },
      el('h2', {}, 'Your Drive is empty'),
      el('p', {}, 'Start a document, or paste an invite someone sent you. Files live on your computer and on your collaborators’ computers, nowhere else.'),
      el('div', { class: 'bar-actions' },
        el('button', { class: 'btn btn-primary', onclick: newDocument }, 'New document'),
        el('button', { class: 'btn', onclick: openJoinDialog }, 'Join with invite'))
    ))
    return
  }

  list.append(el('div', { class: 'ledger-head', 'aria-hidden': 'true' },
    el('span'), el('span', {}, 'Name'), el('span', {}, 'Owner'), el('span', {}, 'Last change'), el('span')))

  for (const f of state.files) {
    const openable = f.supported && !f.waitingForPeer
    const ownerName = f.role === 'owner' ? 'You' : (f.owner?.name || '—')
    const changed = f.lastEditedAt || f.sync.lastSyncedAt || f.addedAt
    const row = el('div', {
      class: 'row',
      role: 'button',
      tabindex: '0',
      'aria-disabled': openable ? null : 'true',
      'aria-label': `${f.title}. ${statusNotes(f).map((n) => n.text).join('. ')}`,
      onclick: (e) => { if (!e.target.closest('.row-menu') && openable) openDocument(f.docId) },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && openable && e.target === row) { e.preventDefault(); openDocument(f.docId) } }
    },
    el('div', { class: 'row-margin' }, renderNotes(statusNotes(f))),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, f.title || 'Untitled'),
      el('p', { class: 'row-preview' }, f.preview || (f.appName ? `Empty ${f.appName} file` : ''))),
    el('div', { class: 'row-owner' }, ownerName),
    el('div', { class: 'row-time' }, ago(changed)),
    el('div', { class: 'row-menu' },
      el('button', { class: 'btn btn-quiet', title: 'More', 'aria-label': `Options for ${f.title}`, onclick: () => fileMenu(f) }, '⋯'))
    )
    list.append(row)
  }
}

function fileMenu (f) {
  const dialog = el('dialog', { class: 'dialog' },
    el('form', { method: 'dialog' },
      el('h2', {}, f.title || 'Untitled'),
      el('p', {}, f.role === 'owner'
        ? 'You own this file. Removing it deletes your copy; anyone you shared it with keeps theirs.'
        : `Shared by ${f.owner?.name || 'someone'}. Removing it deletes your copy only.`),
      f.contributors.length ? el('p', {}, `Written by ${listNames(f.contributors)}.`) : null,
      el('div', { class: 'dialog-actions' },
        el('button', { class: 'btn btn-quiet btn-danger', value: 'remove' }, 'Remove from this computer'),
        el('button', { class: 'btn', value: 'invite', disabled: f.waitingForPeer ? null : null }, 'Copy invite link'),
        el('button', { class: 'btn btn-primary', value: 'close' }, 'Done'))))
  document.body.append(dialog)
  dialog.addEventListener('close', async () => {
    dialog.remove()
    if (dialog.returnValue === 'invite') { await cp.copyInvite(f.docId); toast('Invite link copied. Anyone with it can read and edit.') }
    if (dialog.returnValue === 'remove') {
      if (window.confirm(`Remove “${f.title}” from this computer? This can’t be undone here, though collaborators keep their copies.`)) {
        await cp.removeFile(f.docId)
        toast('Removed from this computer')
      }
    }
  })
  dialog.showModal()
}

async function newDocument () {
  const docId = await cp.createFile('docs', 'Untitled document')
  await openDocument(docId, { focusTitle: true })
}

function openJoinDialog (prefill = '') {
  const d = $('#join-dialog')
  $('#join-input').value = typeof prefill === 'string' ? prefill : ''
  $('#join-error').textContent = ''
  d.showModal()
  $('#join-input').focus()
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    await cp.joinWithInvite($('#join-input').value)
    $('#join-dialog').close()
    toast('Added to your Drive. It will fill in when someone who has it is online.')
  } catch (err) {
    $('#join-error').textContent = cleanError(err)
  }
})
$('#join-input').addEventListener('input', () => { $('#join-error').textContent = '' })
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()))

function cleanError (err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

// ---- profile ---------------------------------------------------------------

function openProfileDialog () {
  const d = $('#profile-dialog')
  $('#profile-name').value = state.me.hasChosenName ? state.me.name : ''
  const colors = $('#profile-colors')
  colors.querySelectorAll('label').forEach((l) => l.remove())
  for (const c of COLORS) {
    colors.append(el('label', { title: c },
      el('input', { type: 'radio', name: 'color', value: c, checked: c === state.me.color, 'aria-label': `Color ${c}` }),
      el('span', { class: 'swatch', style: `--swatch:${c}` })))
  }
  $('#profile-id').textContent = `Your ID: ${state.me.userId}`
  d.showModal()
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('#profile-name').value.trim()
  if (!name) return
  const color = $('#profile-form').querySelector('input[name=color]:checked')?.value
  state.me = await cp.setProfile({ name, color })
  $('#profile-dialog').close()
  renderDrive()
})
$('#profile-dialog').addEventListener('cancel', (e) => { if (!state.me?.hasChosenName) e.preventDefault() })

// ---- CommonDocs ------------------------------------------------------------

async function openDocument (docId, { focusTitle = false } = {}) {
  await closeDocument()
  const ydoc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const opened = await cp.openDoc(docId, ydoc.clientID)
  Y.applyUpdate(ydoc, opened.state, 'main')
  awarenessProtocol.applyAwarenessUpdate(awareness, opened.awareness, 'main')

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

  // Record that this editing session belongs to me (for "written by").
  ydoc.getMap('authors').set(String(ydoc.clientID), { userId: state.me.userId, name: state.me.name })
  awareness.setLocalStateField('user', { name: state.me.name, color: state.me.color, userId: state.me.userId })

  const editor = createDocsEditor({
    element: $('#editor'),
    ydoc,
    awareness,
    user: state.me,
    onUpdate: () => syncToolbar()
  })

  // Title lives in the shared container metadata.
  const meta = ydoc.getMap('meta')
  const title = $('#doc-title')
  const showTitle = () => { if (document.activeElement !== title) title.value = meta.get('title') || '' }
  meta.observe(showTitle)
  showTitle()
  title.oninput = () => meta.set('title', title.value)
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); editor.commands.focus('start') } }

  awareness.on('change', renderPresence)
  state.open = { docId, ydoc, awareness, editor, cleanup: [...cleanup, () => meta.unobserve(showTitle)] }

  $('#drive-view').hidden = true
  $('#doc-view').hidden = false
  renderToolbar()
  renderPresence()
  renderDocMargin()
  if (focusTitle) { title.focus(); title.select() } else editor.commands.focus('end')
}

async function closeDocument () {
  const o = state.open
  if (!o) return
  state.open = null
  o.awareness.setLocalState(null) // tells everyone my cursor left
  o.cleanup.forEach((fn) => fn())
  o.editor.destroy()
  o.awareness.destroy()
  o.ydoc.destroy()
  await cp.closeDoc(o.docId)
  $('#editor').replaceChildren()
}

function renderToolbar () {
  const bar = $('#toolbar')
  bar.replaceChildren()
  for (const c of docsCommands) {
    if (c.sep) { bar.append(el('span', { class: 'tool-sep', role: 'separator' })); continue }
    const shortcut = c.key ? ` (${c.key.replace('Mod', cp.platform === 'darwin' ? '⌘' : 'Ctrl').replace(/-/g, cp.platform === 'darwin' ? '' : '+')})` : ''
    bar.append(el('button', {
      class: 'tool',
      'data-cmd': c.id,
      title: c.label + shortcut,
      'aria-label': c.label,
      'aria-pressed': 'false',
      onmousedown: (e) => e.preventDefault(),
      onclick: () => { if (state.open) c.run(state.open.editor) }
    }, toolGlyph(c.id)))
  }
  syncToolbar()
}

function toolGlyph (id) {
  return {
    bold: el('b', {}, 'B'),
    italic: el('i', {}, 'I'),
    strike: el('s', {}, 'S'),
    h1: 'Heading',
    h2: 'Subheading',
    bullet: 'List',
    ordered: 'Numbered',
    quote: 'Quote',
    code: 'Code',
    undo: 'Undo',
    redo: 'Redo'
  }[id]
}

function syncToolbar () {
  if (!state.open) return
  for (const c of docsCommands) {
    if (c.sep) continue
    const b = $(`.tool[data-cmd="${c.id}"]`)
    if (b) b.setAttribute('aria-pressed', String(Boolean(c.active(state.open.editor))))
  }
}

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

function renderDocMargin () {
  if (!state.open) return
  const file = state.files.find((f) => f.docId === state.open.docId)
  const margin = $('#doc-margin')
  margin.replaceChildren(...(file ? renderNotes(statusNotes(file, { detailed: true })) : []))
}

$('[data-action="back"]').addEventListener('click', async () => {
  await closeDocument()
  $('#doc-view').hidden = true
  $('#drive-view').hidden = false
  renderDrive()
})
$('[data-action="share"]').addEventListener('click', async () => {
  if (!state.open) return
  await cp.copyInvite(state.open.docId)
  toast('Invite link copied. Anyone with it can read and edit.')
})
$('[data-action="new-doc"]').addEventListener('click', newDocument)
$('[data-action="join"]').addEventListener('click', () => openJoinDialog())
$('[data-action="profile"]').addEventListener('click', openProfileDialog)

// ---- boot ------------------------------------------------------------------

cp.onDriveChanged((files, me) => {
  state.files = files
  state.me = me
  if (state.open) renderDocMargin()
  else renderDrive()
})

cp.onInvite((url) => {
  if (state.open) toast('Got an invite. Go back to Drive to join it.')
  openJoinDialog(url)
})

// Keep "5 min ago" labels honest without a reload.
setInterval(() => { if (state.open) renderDocMargin(); else renderDrive() }, 30000)

;(async () => {
  state.me = await cp.me()
  state.files = await cp.listFiles()
  renderDrive()
  if (!state.me.hasChosenName) openProfileDialog()
})()
