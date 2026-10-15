// CommonDrive: list and icon views, personal folders, filters and sorting.

import { $, el, svg, ago, listNames, plural, toast, openMenu, dialog, promptText, confirmAction, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp, statusNotes, renderNotes, savePrefs } from './state.js'
import { shareDialog, setSyncMode, moveInDialog } from './share.js'
import { conflictsDialog } from './conflicts.js'

let handlers = { openDocument: async () => {}, openJoinDialog: () => {} }
export function initDrive (h) {
  handlers = h
  $('[data-action="new"]').addEventListener('click', (e) => openNewMenu(e.currentTarget))
  $('[data-action="join"]').addEventListener('click', () => handlers.openJoinDialog())
  for (const b of document.querySelectorAll('[data-view]')) b.addEventListener('click', () => { state.prefs.mode = b.dataset.view; savePrefs(); renderDrive() })
  for (const b of document.querySelectorAll('[data-filter]')) b.addEventListener('click', () => { state.prefs.filter = b.dataset.filter; savePrefs(); renderDrive() })
  $('#type-filter').addEventListener('change', (e) => { state.prefs.type = e.target.value; savePrefs(); renderDrive() })
  $('#sort').addEventListener('change', (e) => { state.prefs.sort = e.target.value; savePrefs(); renderDrive() })
  $('#search').addEventListener('input', (e) => { state.query = e.target.value; renderDrive() })
  $('#search').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.target.value = ''; state.query = ''; renderDrive() } })
}

// ---- data helpers ------------------------------------------------------------

const folderById = (id) => state.folders.find((f) => f.id === id) || null

function folderPath (id) {
  const path = []
  for (let f = folderById(id); f; f = folderById(f.parentId)) path.unshift(f)
  return path
}

function descendantIds (id) {
  const out = new Set([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of state.folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) { out.add(f.id); grew = true }
  }
  return out
}

function folderStats (id) {
  const ids = descendantIds(id)
  const files = state.files.filter((f) => ids.has(f.folderId))
  return {
    items: files.length + state.folders.filter((f) => f.parentId === id).length,
    lastActivityAt: files.reduce((m, f) => Math.max(m, f.lastActivityAt || 0), 0),
    live: files.filter((f) => f.sync.live).length
  }
}

function matchesFilters (f) {
  const { filter, type } = state.prefs
  if (filter === 'mine' && f.role !== 'owner') return false
  if (filter === 'shared' && f.role === 'owner') return false
  if (type !== 'all' && f.kind !== type) return false
  return true
}

function visibleItems () {
  const q = state.query.trim().toLowerCase()
  const searching = q.length > 0
  const inFolder = (f) => (f.folderId || null) === (state.folderId || null)
  let files = state.files.filter((f) => (searching ? true : inFolder(f)) && matchesFilters(f))
  if (searching) files = files.filter((f) => `${f.title} ${f.preview}`.toLowerCase().includes(q))
  let folders = searching || state.prefs.filter !== 'all' || state.prefs.type !== 'all'
    ? []
    : state.folders.filter((f) => (f.parentId || null) === (state.folderId || null))
  if (searching) folders = state.folders.filter((f) => f.name.toLowerCase().includes(q))

  const by = state.prefs.sort
  const name = (a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, { sensitivity: 'base', numeric: true })
  const ownerName = (f) => (f.role === 'owner' ? '' : (f.owner?.name || '￿'))
  if (by === 'name') files.sort(name)
  else if (by === 'owner') files.sort((a, b) => ownerName(a).localeCompare(ownerName(b)) || name(a, b))
  else files.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  folders.sort(name)
  return { files, folders, searching }
}

// ---- rendering --------------------------------------------------------------

export function renderDrive () {
  if (state.folderId && !folderById(state.folderId)) state.folderId = null
  renderCrumbs()
  renderControls()
  $('#me-name').textContent = state.me?.name || ''
  $('#me-swatch').style.setProperty('--swatch', state.me?.color)

  const list = $('#file-list')
  list.replaceChildren()
  list.className = `ledger ledger-${state.prefs.mode}`
  const { files, folders, searching } = visibleItems()

  if (!state.files.length && !state.folders.length) {
    list.append(emptyState())
    return
  }
  if (!files.length && !folders.length) {
    list.append(el('div', { class: 'empty' },
      el('h2', {}, searching ? 'No matches' : state.folderId ? 'This folder is empty' : 'Nothing matches these filters'),
      el('p', {}, searching ? 'Try a different word, or clear the search.' : state.folderId ? 'Drag files here from another folder, or start a new document while you’re in it.' : 'Change the filters above to see more.')))
    return
  }
  if (state.prefs.mode === 'grid') renderGrid(list, files, folders, searching)
  else renderList(list, files, folders, searching)
}

function renderCrumbs () {
  const nav = $('#crumbs')
  nav.replaceChildren()
  const path = folderPath(state.folderId)
  const crumbs = [{ id: null, name: 'CommonDrive' }, ...path]
  crumbs.forEach((c, i) => {
    const last = i === crumbs.length - 1
    if (i > 0) nav.append(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'))
    if (last) {
      const title = el('h1', { class: 'crumb current' }, c.name)
      if (c.id) {
        const more = el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': `Options for folder ${c.name}`, onclick: (e) => folderMenu(e.currentTarget, folderById(c.id)) }, svg(icons.more))
        nav.append(title, more)
      } else nav.append(title)
    } else {
      const b = el('button', { type: 'button', class: 'crumb', onclick: () => goTo(c.id) }, c.name)
      dropTarget(b, c.id)
      nav.append(b)
    }
  })
}

function renderControls () {
  for (const b of document.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String(b.dataset.view === state.prefs.mode))
  for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(b.dataset.filter === state.prefs.filter))
  const type = $('#type-filter')
  if (type.options.length !== state.apps.length + 1) {
    type.replaceChildren(el('option', { value: 'all' }, 'All types'), ...state.apps.map((a) => el('option', { value: a.kind }, a.name)))
  }
  type.value = state.prefs.type
  $('#sort').value = state.prefs.sort
}

function emptyState () {
  return el('div', { class: 'empty' },
    el('h2', {}, 'Your Drive is empty'),
    el('p', {}, 'Start a document, import a .md or .docx file, or paste an invite someone sent you. Files live on your computer and on your collaborators’ computers, nowhere else.'),
    el('div', { class: 'bar-actions' },
      ...state.apps.map((a) => el('button', { class: a.kind === 'paged' ? 'btn' : 'btn btn-primary', onclick: () => newDocument(a.type) }, `New ${a.name.toLowerCase()}`)),
      el('button', { class: 'btn', onclick: importFile }, 'Import a file'),
      el('button', { class: 'btn btn-quiet', onclick: () => handlers.openJoinDialog() }, 'Join with invite')),
    el('p', { class: 'empty-move' }, 'Moving from another computer? ',
      el('button', { type: 'button', class: 'link-button', onclick: moveInDialog }, 'Bring your Drive here')))
}

// ---- list view ----------------------------------------------------------------

function renderList (list, files, folders, searching) {
  list.append(el('div', { class: 'ledger-head', 'aria-hidden': 'true' },
    el('span'), el('span', {}, 'Name'), el('span', {}, 'Owner'), el('span', {}, 'Last change'), el('span')))

  for (const f of folders) {
    const stats = folderStats(f.id)
    const row = el('div', {
      class: 'row row-folder',
      role: 'button',
      tabindex: '0',
      'aria-label': `Folder ${f.name}, ${plural(stats.items, 'item')}`,
      onclick: (e) => { if (!e.target.closest('.row-menu')) goTo(f.id) },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target === row) { e.preventDefault(); goTo(f.id) } }
    },
    el('div', { class: 'row-margin' }, renderNotes([{ text: stats.items ? plural(stats.items, 'item') : 'Empty' }, stats.live ? { text: `${stats.live} live now`, cls: 'live', dot: true } : null].filter(Boolean))),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, svg(icons.folder), el('span', {}, f.name)),
      searching && f.parentId ? el('p', { class: 'row-preview' }, `In ${folderPath(f.parentId).map((p) => p.name).join(' / ')}`) : null),
    el('div', { class: 'row-owner' }, 'You'),
    el('div', { class: 'row-time' }, ago(stats.lastActivityAt || f.createdAt)),
    el('div', { class: 'row-menu' },
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': `Options for folder ${f.name}`, onclick: (e) => folderMenu(e.currentTarget, f) }, svg(icons.more))))
    draggable(row, { kind: 'folder', id: f.id })
    dropTarget(row, f.id)
    list.append(row)
  }

  for (const f of files) {
    const openable = f.supported && !f.waitingForPeer
    const ownerName = f.role === 'owner' ? 'You' : (f.owner?.name || '—')
    const where = searching && f.folderId ? `In ${folderPath(f.folderId).map((p) => p.name).join(' / ')}` : null
    const row = el('div', {
      class: 'row',
      role: 'button',
      tabindex: '0',
      'aria-disabled': openable ? null : 'true',
      'aria-label': `${f.title}, ${f.appName || 'file'}. ${statusNotes(f).map((n) => n.text).join('. ')}`,
      onclick: (e) => { if (!e.target.closest('.row-menu') && openable) handlers.openDocument(f.docId) },
      onkeydown: (e) => { if ((e.key === 'Enter' || e.key === ' ') && openable && e.target === row) { e.preventDefault(); handlers.openDocument(f.docId) } }
    },
    el('div', { class: 'row-margin' }, renderNotes(statusNotes(f))),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, svg(f.kind === 'paged' ? icons.paged : icons.markdown), el('span', {}, f.title || 'Untitled')),
      el('p', { class: 'row-preview' }, where || f.preview || (f.appName ? `Empty ${f.appName.toLowerCase()}` : ''))),
    el('div', { class: 'row-owner' }, ownerName),
    el('div', { class: 'row-time', title: f.lastChangedBy ? `Changed by ${f.lastChangedBy}` : null },
      ago(f.lastChangeAt || f.addedAt), f.lastChangedBy ? el('span', { class: 'row-by' }, f.lastChangedBy) : null),
    el('div', { class: 'row-menu' },
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': `Options for ${f.title}`, onclick: (e) => fileMenu(e.currentTarget, f) }, svg(icons.more))))
    draggable(row, { kind: 'file', id: f.docId })
    list.append(row)
  }
}

// ---- icon view ------------------------------------------------------------------

function renderGrid (list, files, folders, searching) {
  const live = files.filter((f) => (f.sync.here || []).length).length
  const waiting = files.filter((f) => f.waitingForPeer).length
  const unsynced = files.filter((f) => f.sync.pending > 0 && f.sync.lastSyncedAt).length
  const summary = [
    { text: [folders.length ? plural(folders.length, 'folder') : null, plural(files.length, 'file')].filter(Boolean).join(', ') },
    live ? { text: `Someone is in ${live === 1 ? '1 file' : `${live} files`} now`, cls: 'live', dot: true } : null,
    waiting ? { text: `${waiting} waiting for a peer`, cls: 'warn' } : null,
    unsynced ? { text: `${plural(unsynced, 'file')} with edits only on this computer`, cls: 'warn' } : null
  ].filter(Boolean)
  const grid = el('div', { class: 'tiles', role: 'list' })
  list.append(el('div', { class: 'grid-wrap' }, el('aside', { class: 'grid-margin' }, renderNotes(summary)), grid))

  for (const f of folders) {
    const stats = folderStats(f.id)
    const tile = el('div', {
      class: 'tile tile-folder',
      role: 'listitem',
      tabindex: '0',
      'aria-label': `Folder ${f.name}, ${plural(stats.items, 'item')}`,
      onclick: (e) => { if (!e.target.closest('.tile-menu')) goTo(f.id) },
      onkeydown: (e) => { if (e.key === 'Enter' && e.target === tile) goTo(f.id) }
    },
    el('div', { class: 'thumb thumb-folder', 'aria-hidden': 'true' }, el('span', { class: 'thumb-count' }, stats.items ? plural(stats.items, 'item') : 'Empty')),
    el('div', { class: 'tile-meta' },
      el('p', { class: 'tile-title' }, f.name),
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon tile-menu', 'aria-label': `Options for folder ${f.name}`, onclick: (e) => folderMenu(e.currentTarget, f) }, svg(icons.more))),
    stats.live ? el('span', { class: 'note live tile-note' }, `${stats.live} live now`) : null)
    draggable(tile, { kind: 'folder', id: f.id })
    dropTarget(tile, f.id)
    grid.append(tile)
  }

  for (const f of files) {
    const openable = f.supported && !f.waitingForPeer
    const first = statusNotes(f)[0]
    const tile = el('div', {
      class: `tile${openable ? '' : ' tile-disabled'}`,
      role: 'listitem',
      tabindex: '0',
      'aria-label': `${f.title}, ${f.appName || 'file'}. ${statusNotes(f).map((n) => n.text).join('. ')}`,
      onclick: (e) => { if (!e.target.closest('.tile-menu') && openable) handlers.openDocument(f.docId) },
      onkeydown: (e) => { if (e.key === 'Enter' && openable && e.target === tile) handlers.openDocument(f.docId) }
    },
    thumbnail(f),
    el('div', { class: 'tile-meta' },
      el('p', { class: 'tile-title' }, svg(f.kind === 'paged' ? icons.paged : icons.markdown), el('span', {}, f.title || 'Untitled')),
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon tile-menu', 'aria-label': `Options for ${f.title}`, onclick: (e) => fileMenu(e.currentTarget, f) }, svg(icons.more))),
    first ? el('span', { class: `note tile-note ${first.cls || ''}` }, first.text, first.dot ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null) : null,
    searching && f.folderId ? el('span', { class: 'tile-where' }, `In ${folderById(f.folderId)?.name}`) : null)
    draggable(tile, { kind: 'file', id: f.docId })
    grid.append(tile)
  }
}

// Miniature of the first page. Paged docs show as a sheet; markdown as a ruled card.
function thumbnail (f) {
  const text = f.preview || ''
  if (f.waitingForPeer) return el('div', { class: 'thumb thumb-waiting', 'aria-hidden': 'true' }, el('span', {}, 'Not here yet'))
  if (f.kind === 'paged') {
    return el('div', { class: 'thumb thumb-paged', 'aria-hidden': 'true' },
      el('div', { class: 'thumb-sheet' }, el('p', {}, text.slice(0, 380) || ' ')))
  }
  return el('div', { class: 'thumb thumb-markdown', 'aria-hidden': 'true' }, el('p', {}, text.slice(0, 300) || ' '))
}

// ---- drag and drop -----------------------------------------------------------

const DRAG_TYPE = 'application/x-commonplace-item'

function draggable (node, item) {
  node.draggable = true
  node.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(item))
    e.dataTransfer.effectAllowed = 'move'
    node.classList.add('dragging')
  })
  node.addEventListener('dragend', () => node.classList.remove('dragging'))
}

function dropTarget (node, folderId) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    node.classList.add('drop-over')
  })
  node.addEventListener('dragleave', () => node.classList.remove('drop-over'))
  node.addEventListener('drop', async (e) => {
    node.classList.remove('drop-over')
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    e.preventDefault()
    const item = JSON.parse(raw)
    if (item.kind === 'file') {
      await cp.moveFile(item.id, folderId)
      toast(`Moved to ${folderById(folderId)?.name || 'CommonDrive'}`)
    } else if (item.id !== folderId) {
      const ok = await cp.moveFolder(item.id, folderId)
      toast(ok ? `Moved to ${folderById(folderId)?.name || 'CommonDrive'}` : 'A folder can’t go inside itself.')
    }
  })
}

// ---- commands -----------------------------------------------------------------

export function goTo (folderId) {
  state.folderId = folderId || null
  state.query = ''
  $('#search').value = ''
  renderDrive()
}

function openNewMenu (anchor) {
  openMenu(anchor, [
    ...state.apps.map((a) => ({ label: a.name, hint: a.description, icon: a.kind === 'paged' ? icons.paged : icons.markdown, onSelect: () => newDocument(a.type) })),
    { sep: true },
    { label: 'Folder', icon: icons.folder, onSelect: newFolder },
    { label: 'Import a file…', hint: '.md opens as markdown, .docx as a paged document', icon: icons.import, onSelect: importFile }
  ], { align: 'end', label: 'Create' })
}

async function newDocument (type) {
  const app = state.apps.find((a) => a.type === type)
  const docId = await cp.createFile(type, app?.kind === 'paged' ? 'Untitled document' : 'Untitled notes', state.folderId)
  await handlers.openDocument(docId, { focusTitle: true })
}

async function newFolder () {
  const name = await promptText({ title: 'New folder', label: 'Name', confirm: 'Create folder', body: 'Folders organize your own Drive. They aren’t shared with anyone.' })
  if (name) await cp.createFolder(name, state.folderId)
}

async function importFile () {
  try {
    const res = await cp.importFile(state.folderId)
    if (!res) return
    await handlers.openDocument(res.docId, { initialContent: res.content })
    toast(res.warnings ? 'Imported. Some formatting couldn’t be carried over.' : 'Imported')
  } catch (err) {
    toast(`Couldn’t import that file: ${cleanError(err)}`)
  }
}

function folderMenu (anchor, f) {
  openMenu(anchor, [
    { label: 'Open', onSelect: () => goTo(f.id) },
    { label: 'Rename…', onSelect: async () => { const name = await promptText({ title: 'Rename folder', label: 'Name', value: f.name, confirm: 'Rename' }); if (name) cp.renameFolder(f.id, name) } },
    { label: 'Move to…', onSelect: () => moveDialog({ kind: 'folder', id: f.id, name: f.name, current: f.parentId }) },
    { sep: true },
    {
      label: 'Delete folder…',
      danger: true,
      onSelect: async () => {
        const parent = folderById(f.parentId)?.name || 'CommonDrive'
        if (await confirmAction({ title: `Delete “${f.name}”?`, body: `Only the folder is deleted. Everything inside it moves to ${parent}.`, confirm: 'Delete folder' })) {
          if (state.folderId === f.id) state.folderId = f.parentId || null
          await cp.deleteFolder(f.id)
        }
      }
    }
  ], { label: `Folder ${f.name}` })
}

function fileMenu (anchor, f) {
  const openable = f.supported && !f.waitingForPeer
  openMenu(anchor, [
    { label: 'Open', disabled: !openable, onSelect: () => handlers.openDocument(f.docId) },
    { label: 'Share\u2026', icon: icons.invite, disabled: f.waitingForPeer, onSelect: () => shareDialog(f.docId) },
    { label: 'Sync in the background', hint: f.syncMode === 'open' ? 'Off: syncs only while the file is open' : 'On: syncs whenever Commonplace is running', checked: f.syncMode !== 'open', onSelect: () => setSyncMode(f.docId, f.syncMode === 'open' ? 'always' : 'open') },
    { label: 'Move to…', icon: icons.folder, onSelect: () => moveDialog({ kind: 'file', id: f.docId, name: f.title, current: f.folderId }) },
    f.conflicts?.length ? { label: f.role === 'owner' ? 'Review conflicts\u2026' : 'See conflicts\u2026', onSelect: () => conflictsDialog(f.docId) } : null,
    { label: 'Details', onSelect: () => detailsDialog(f) },
    { sep: true },
    {
      label: 'Remove from this computer…',
      danger: true,
      onSelect: async () => {
        const body = f.role === 'owner'
          ? 'This deletes your copy. Anyone you shared it with keeps theirs.'
          : `Shared by ${f.owner?.name || 'someone'}. This deletes your copy only.`
        if (await confirmAction({ title: `Remove “${f.title}”?`, body, confirm: 'Remove' })) {
          await cp.removeFile(f.docId)
          toast('Removed from this computer')
        }
      }
    }
  ], { label: f.title })
}

function detailsDialog (f) {
  const rows = [
    ['Type', f.appName || 'Unknown'],
    ['Owner', f.role === 'owner' ? 'You' : (f.owner?.name || 'Unknown')],
    ['Your access', { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }[f.role] || (f.access.removed ? 'Removed' : 'Not yet confirmed')],
    ['Written by', f.contributors.length ? listNames(f.contributors) : 'Nobody yet'],
    ['Folder', f.folderId ? folderPath(f.folderId).map((p) => p.name).join(' / ') : 'CommonDrive'],
    ['Last change', [ago(f.lastChangeAt || f.addedAt), f.lastChangedBy ? `by ${f.lastChangedBy}` : null].filter(Boolean).join(' ') || '—'],
    ['Sync', statusNotes(f).map((n) => n.text).join('. ')]
  ]
  dialog({ title: f.title || 'Untitled', body: el('dl', { class: 'details' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), confirm: 'Done', cancel: null })
}

async function moveDialog ({ kind, id, name, current }) {
  const blocked = kind === 'folder' ? descendantIds(id) : new Set()
  const options = [{ id: '', label: 'CommonDrive', depth: 0 }]
  const walk = (parentId, depth) => {
    for (const f of state.folders.filter((x) => (x.parentId || null) === parentId).sort((a, b) => a.name.localeCompare(b.name))) {
      if (blocked.has(f.id)) continue
      options.push({ id: f.id, label: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 1)
  const list = el('fieldset', { class: 'folder-picker' }, el('legend', { class: 'sr-only' }, 'Destination'),
    ...options.map((o) => el('label', { class: 'folder-option', style: `padding-left:${8 + o.depth * 18}px` },
      el('input', { type: 'radio', name: 'target', value: o.id, checked: (o.id || null) === (current || null) || null }),
      svg(icons.folder), el('span', {}, o.label))))
  const res = await dialog({ title: `Move “${name}”`, fields: [list], confirm: 'Move here' })
  if (res?.action !== 'confirm') return
  const target = res.data.target || null
  if (kind === 'file') await cp.moveFile(id, target)
  else if (!(await cp.moveFolder(id, target))) { toast('A folder can’t go inside itself.'); return }
  toast(`Moved to ${folderById(target)?.name || 'CommonDrive'}`)
}
