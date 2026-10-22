// commonDrive: list and icon views, personal folders, filters and sorting.

import { $, el, svg, ago, listNames, plural, toast, openMenu, dialog, promptText, confirmAction, cleanError } from './ui.js'
import { icons, kindIcon } from './icons.js'
import { state, cp, statusNotes, renderNotes, marginMark, savePrefs, editorRole, ROLE_LABEL } from './state.js'
import { shareDialog, setSyncMode, moveInDialog } from './share.js'
import { restoreDialog } from './recovery-view.js'
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
  // Files dragged in from the computer are uploaded into the folder on screen.
  const drive = $('#drive-view')
  drive.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    drive.classList.add('drop-files')
  })
  drive.addEventListener('dragleave', (e) => { if (!drive.contains(e.relatedTarget)) drive.classList.remove('drop-files') })
  drive.addEventListener('drop', (e) => {
    drive.classList.remove('drop-files')
    if (!e.dataTransfer.files.length || e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    uploadFiles(e.dataTransfer.files)
  })
}

// From the picker, or files dropped onto the Drive.
async function uploadFiles (dropped) {
  try {
    const res = dropped ? await cp.uploadDropped(dropped, state.folderId) : await cp.uploadFiles(state.folderId)
    if (!res) return
    if (res.done.length) toast(res.done.length === 1 ? 'Uploaded 1 file' : `Uploaded ${res.done.length} files`)
    if (res.failed.length) toast(`Couldn’t upload ${res.failed.join('; ')}`)
  } catch (err) { toast(cleanError(err)) }
}

// ---- data relays ------------------------------------------------------------

const folderById = (id) => state.folders.find((f) => f.id === id) || null
// Files proper: shared folders are documents too, but show as folders.
// Files in the trash show only in the trash.
const docs = () => state.files.filter((f) => f.kind !== 'folder' && !f.trashedAt)
const trashed = () => state.files.filter((f) => f.kind !== 'folder' && f.trashedAt)
const inTrash = () => state.prefs.filter === 'trash'
const folderIcon = (f) => (f?.shared ? icons.sharedFolder : icons.folder)
const canChange = (f) => !f?.shared || editorRole(f.role)

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
  const files = docs().filter((f) => ids.has(f.folderId))
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
  if (filter === 'starred' && !f.starred) return false
  if (type !== 'all' && f.kind !== type) return false
  return true
}

function visibleItems () {
  const q = state.query.trim().toLowerCase()
  const searching = q.length > 0
  // Starred files and the trash are gathered from every folder.
  const everywhere = searching || ['starred', 'trash'].includes(state.prefs.filter)
  const inFolder = (f) => (f.folderId || null) === (state.folderId || null)
  let files = (inTrash() ? trashed() : docs()).filter((f) => (everywhere || inFolder(f)) && matchesFilters(f))
  if (searching) files = files.filter((f) => `${f.title} ${f.preview}`.toLowerCase().includes(q))
  let folders = everywhere || state.prefs.filter !== 'all' || state.prefs.type !== 'all'
    ? []
    : state.folders.filter((f) => (f.parentId || null) === (state.folderId || null))
  if (searching) folders = state.folders.filter((f) => f.name.toLowerCase().includes(q))

  const by = state.prefs.sort
  const name = (a, b) => (a.title || a.name).localeCompare(b.title || b.name, undefined, { sensitivity: 'base', numeric: true })
  const ownerName = (f) => (f.role === 'owner' ? '' : (f.owner?.name || '￿'))
  if (by === 'name') files.sort(name)
  else if (by === 'owner') files.sort((a, b) => ownerName(a).localeCompare(ownerName(b)) || name(a, b))
  else files.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0))
  if (inTrash()) files.sort((a, b) => b.trashedAt - a.trashedAt)
  folders.sort(name)
  return { files, folders, searching: everywhere }
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

  if (inTrash()) list.append(trashBar(files))
  if (!docs().length && !state.folders.length && !inTrash()) {
    list.append(emptyState())
    return
  }
  if (!files.length && !folders.length) {
    const [title, hint] = state.query.trim()
      ? ['No matches', 'Try a different word, or clear the search.']
      : inTrash() ? ['The trash is empty', 'Files you remove from your Drive wait here, so you can bring them back.']
        : state.prefs.filter === 'starred' ? ['No starred files', 'Star a file from its menu to find it here, whatever folder it’s in.']
          : state.folderId ? ['This folder is empty', 'Drag files here from another folder, or start a new document while you’re in it.']
            : ['Nothing matches these filters', 'Change the filters above to see more.']
    list.append(el('div', { class: 'empty' }, el('h2', {}, title), el('p', {}, hint)))
    return
  }
  if (state.prefs.mode === 'grid') renderGrid(list, files, folders, searching)
  else renderList(list, files, folders, searching)
}

function trashBar (files) {
  const days = state.trashDays || 30
  return el('div', { class: 'trash-bar' },
    el('span', {}, `Files here keep syncing until they’re deleted from this computer, by hand or after ${plural(days, 'day')}. Others you shared them with keep theirs.`),
    files.length ? el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: emptyTrash }, 'Empty trash') : null)
}

async function emptyTrash () {
  const n = trashed().length
  if (!await confirmAction({ title: `Delete ${plural(n, 'file')} from this computer?`, body: 'They are deleted on each of your computers. Anyone you shared them with keeps theirs. This can’t be undone.', confirm: 'Delete' })) return
  await cp.emptyTrash()
  toast(`Deleted ${plural(n, 'file')}`)
}

const star = (f) => (f.starred ? el('span', { class: 'star', title: 'Starred', 'aria-label': 'Starred' }, '★') : null)

function renderCrumbs () {
  const nav = $('#crumbs')
  nav.replaceChildren()
  const path = folderPath(state.folderId)
  const crumbs = [{ id: null, name: 'commonDrive' }, ...path]
  crumbs.forEach((c, i) => {
    const last = i === crumbs.length - 1
    if (i > 0) nav.append(el('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'))
    if (last) {
      const title = el('h1', { class: 'crumb current' }, c.name)
      if (c.id) {
        const more = el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': `Options for folder ${c.name}`, onclick: (e) => folderMenu(e.currentTarget, folderById(c.id)) }, svg(icons.more))
        nav.append(title, more)
        if (c.shared) nav.append(el('button', { type: 'button', class: 'btn btn-quiet crumb-share', onclick: () => shareDialog(c.id) }, svg(icons.sharedFolder), el('span', {}, sharedNote(c).text)))
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
    el('p', {}, 'Start something new, import a file, or paste an invite someone sent you. Files live on your computer and on your collaborators’ computers, nowhere else.'),
    el('div', { class: 'app-tiles' }, ...state.apps.map((a) => el('button', { type: 'button', class: 'app-tile', onclick: () => newDocument(a.type) },
      svg(kindIcon(a.kind)), el('span', { class: 'app-tile-name' }, a.name), el('span', { class: 'app-tile-hint' }, a.description)))),
    el('div', { class: 'bar-actions' },
      el('button', { class: 'btn', onclick: importFile }, 'Import a file'),
      el('button', { class: 'btn', onclick: () => uploadFiles() }, 'Upload files'),
      el('button', { class: 'btn', onclick: () => templateGallery() }, 'Start from a template'),
      el('button', { class: 'btn btn-quiet', onclick: () => handlers.openJoinDialog() }, 'Join with invite')),
    el('p', { class: 'empty-move' }, 'Moving from another computer? ',
      el('button', { type: 'button', class: 'link-button', onclick: moveInDialog }, 'Bring your Drive here'),
      ' or ',
      el('button', { type: 'button', class: 'link-button', onclick: restoreDialog }, 'restore from a backup'), '.'))
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
    (() => {
      const notes = [{ text: stats.items ? plural(stats.items, 'item') : 'Empty' }, sharedNote(f), stats.live ? { text: `${stats.live} live now`, cls: 'live', dot: true } : null].filter(Boolean)
      return el('div', { class: 'row-margin' }, ...renderNotes(notes), marginMark(notes))
    })(),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, svg(folderIcon(f)), el('span', {}, f.name)),
      searching && f.parentId ? el('p', { class: 'row-preview' }, `In ${folderPath(f.parentId).map((p) => p.name).join(' / ')}`) : null),
    el('div', { class: 'row-owner' }, f.shared && f.role !== 'owner' ? f.owner?.name || 'Someone' : 'You'),
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
    el('div', { class: 'row-margin' }, ...renderNotes(statusNotes(f)), marginMark(statusNotes(f))),
    el('div', { class: 'row-main' },
      el('p', { class: 'row-title' }, svg(kindIcon(f.kind)), el('span', {}, f.title || 'Untitled'), star(f)),
      el('p', { class: 'row-preview' }, f.trashedAt ? `Moved to the trash ${ago(f.trashedAt)}` : where || f.preview || (f.appName ? `Empty ${f.appName.toLowerCase()}` : ''))),
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
  list.append(el('div', { class: 'grid-wrap' }, el('aside', { class: 'grid-margin' }, ...renderNotes(summary), marginMark(summary)), grid))

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
    el('div', { class: `thumb thumb-folder${f.shared ? ' shared' : ''}`, 'aria-hidden': 'true' }, el('span', { class: 'thumb-count' }, stats.items ? plural(stats.items, 'item') : 'Empty')),
    el('div', { class: 'tile-meta' },
      el('p', { class: 'tile-title' }, f.shared ? svg(icons.sharedFolder) : null, el('span', {}, f.name)),
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon tile-menu', 'aria-label': `Options for folder ${f.name}`, onclick: (e) => folderMenu(e.currentTarget, f) }, svg(icons.more))),
    stats.live ? el('span', { class: 'note live tile-note' }, `${stats.live} live now`) : f.shared ? el('span', { class: 'note tile-note' }, sharedNote(f).text) : null)
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
      el('p', { class: 'tile-title' }, svg(kindIcon(f.kind)), el('span', {}, f.title || 'Untitled'), star(f)),
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
  if (f.kind === 'sheet') {
    const grid = f.thumb?.grid || []
    return el('div', { class: 'thumb thumb-grid', 'aria-hidden': 'true' },
      el('table', {}, el('tbody', {}, ...Array.from({ length: 6 }, (_, r) => el('tr', {}, ...Array.from({ length: 4 }, (_, c) => el('td', {}, grid[r]?.[c] || '')))))))
  }
  if (f.kind === 'slides') {
    const t = f.thumb
    const k = 168 / 960
    return el('div', { class: 'thumb thumb-slides', 'aria-hidden': 'true' },
      el('div', { class: 'thumb-slide', style: `background:${t?.bg || '#fff'};font-family:${t?.font || 'inherit'}` },
        ...(t?.boxes || []).map((b) => el('div', {
          class: `thumb-box thumb-box-${b.type}`,
          style: `left:${b.x * k}px;top:${b.y * k}px;width:${b.w * k}px;height:${b.h * k}px;font-size:${Math.max(4, b.size * k)}px;text-align:${b.align};${b.bold ? 'font-weight:700;' : ''}${b.fill ? `background:${b.fill};` : ''}`
        }, b.text))),
      t?.count > 1 ? el('span', { class: 'thumb-count-badge' }, `${t.count} slides`) : null)
  }
  if (f.kind === 'tasks') {
    const lists = f.thumb?.lists || []
    return el('div', { class: 'thumb thumb-tasks', 'aria-hidden': 'true' }, ...lists.slice(0, 3).map((l) => el('div', { class: 'tt-list' },
      el('span', { class: 'tt-name' }, l.name),
      ...l.cards.slice(0, 3).map((c) => el('span', { class: `tt-card${c.done ? ' done' : ''}` }, c.title || ' ')))))
  }
  if (f.kind === 'calendar') {
    const t = f.thumb
    if (!t) return el('div', { class: 'thumb thumb-cal', 'aria-hidden': 'true' })
    const cells = [...Array(t.startsOn).fill(null), ...Array.from({ length: t.days }, (_, i) => i + 1)]
    return el('div', { class: 'thumb thumb-cal', 'aria-hidden': 'true' },
      el('span', { class: 'tc-month' }, new Date(t.year, t.month, 1).toLocaleDateString(undefined, { month: 'long' })),
      el('div', { class: 'tc-grid' }, ...cells.map((d) => el('span', { class: `tc-day${d === t.today ? ' today' : ''}${d && t.busy[d] ? ' busy' : ''}`, style: d && t.busy[d] ? `--ev:${t.busy[d]}` : null }, d ? String(d) : ''))))
  }
  if (f.kind === 'whiteboard') return boardThumb(f.thumb?.shapes || [])
  if (f.kind === 'file') {
    const t = f.thumb
    if (t?.image) return el('div', { class: 'thumb thumb-image', 'aria-hidden': 'true' }, el('img', { src: t.image, alt: '' }))
    return el('div', { class: `thumb thumb-file${t?.risky ? ' risky' : ''}`, 'aria-hidden': 'true' }, el('span', { class: 'tfile-ext' }, (t?.ext || 'file').toUpperCase().slice(0, 5)))
  }
  if (f.kind === 'form') {
    const t = f.thumb || { questions: [] }
    return el('div', { class: 'thumb thumb-form', 'aria-hidden': 'true' },
      el('div', { class: 'tf-sheet' }, ...t.questions.slice(0, 3).map((q) => el('div', { class: 'tf-q' },
        el('span', { class: 'tf-title' }, q.title),
        ...(q.options.length ? q.options.slice(0, 2).map((o) => el('span', { class: 'tf-opt' }, o)) : [el('span', { class: 'tf-line' })])))),
      t.responses ? el('span', { class: 'thumb-count-badge' }, `${t.responses} answer${t.responses === 1 ? '' : 's'}`) : null)
  }
  return el('div', { class: 'thumb thumb-markdown', 'aria-hidden': 'true' }, el('p', {}, text.slice(0, 300) || ' '))
}

// A whiteboard in miniature (the model has already scaled it to 160 x 100).
function boardThumb (shapes) {
  const ns = 'http://www.w3.org/2000/svg'
  const svgNode = document.createElementNS(ns, 'svg')
  svgNode.setAttribute('viewBox', '-6 -6 172 112')
  const add = (tag, attrs) => { const n = document.createElementNS(ns, tag); for (const [k, val] of Object.entries(attrs)) n.setAttribute(k, val); svgNode.append(n) }
  for (const s of shapes) {
    const color = s.color || '#8a8f9b'
    if (s.type === 'pen' && s.points?.length > 2) add('polyline', { points: s.points.map((n, i) => n + (i % 2 ? s.y : s.x)).join(' '), fill: 'none', stroke: color, 'stroke-width': 1.2 })
    else if (s.type === 'arrow' || s.type === 'line') add('line', { x1: s.x, y1: s.y, x2: s.x + s.w, y2: s.y + s.h, stroke: color, 'stroke-width': 1.2 })
    else if (s.type === 'ellipse') add('ellipse', { cx: s.x + s.w / 2, cy: s.y + s.h / 2, rx: Math.abs(s.w / 2), ry: Math.abs(s.h / 2), fill: color, stroke: '#1f2430', 'stroke-width': 0.6 })
    else if (s.type === 'text') add('rect', { x: s.x, y: s.y + s.h * 0.3, width: s.w * 0.7, height: Math.max(1.5, s.h * 0.25), fill: color, opacity: 0.5 })
    else add('rect', { x: s.x, y: s.y, width: s.w, height: s.h, rx: 1, fill: color, ...(s.type === 'rect' ? { stroke: '#1f2430', 'stroke-width': 0.6 } : {}) })
  }
  return el('div', { class: 'thumb thumb-board', 'aria-hidden': 'true' }, svgNode)
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
    if (item.id !== folderId) moveTo(item, folderId)
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
    ...state.apps.map((a) => ({ label: a.name, hint: a.description, icon: kindIcon(a.kind), onSelect: () => newDocument(a.type) })),
    { sep: true },
    { label: 'From a template…', icon: icons.template, onSelect: () => templateGallery() },
    { sep: true },
    { label: 'Folder', hint: 'Just for organizing your Drive', icon: icons.folder, onSelect: newFolder },
    { label: 'Shared folder', hint: 'Everyone in it gets what’s inside', icon: icons.sharedFolder, onSelect: newSharedFolder },
    { label: 'Import a file…', hint: '.docx, .md, .xlsx, .csv, .pptx or .ics', icon: icons.import, onSelect: importFile },
    { label: 'Upload files…', hint: 'Any kind, up to 100 MB each', icon: icons.upload, onSelect: () => uploadFiles() }
  ], { align: 'end', label: 'Create' })
}

async function newDocument (type) {
  const app = state.apps.find((a) => a.type === type)
  const title = { paged: 'Untitled document', sheet: 'Untitled spreadsheet', slides: 'Untitled presentation', tasks: 'Untitled tasks', calendar: 'Untitled calendar', whiteboard: 'Untitled whiteboard', form: 'Untitled form' }[app?.kind] || 'Untitled notes'
  const docId = await cp.createFile(type, title, state.folderId)
  await handlers.openDocument(docId, { focusTitle: true })
}

// ---- templates and copies ----------------------------------------------------------

async function templateGallery () {
  let list
  try { list = await cp.listTemplates() } catch (err) { toast(cleanError(err)); return }
  const d = el('dialog', { class: 'dialog dialog-wide templates' })
  const pick = async (t) => {
    d.close()
    try {
      const docId = await cp.createFromTemplate(t.id, state.folderId)
      await handlers.openDocument(docId, { focusTitle: true })
    } catch (err) { toast(cleanError(err)) }
  }
  const card = (t) => el('div', { class: 'template' },
    el('button', { type: 'button', class: 'template-pick', onclick: () => pick(t), 'aria-label': `${t.name}: ${t.description}` },
      thumbnail({ kind: t.kind, thumb: t.thumb, preview: t.preview }),
      el('span', { class: 'template-name' }, t.name),
      el('span', { class: 'template-desc' }, t.description || t.appName)),
    t.mine ? el('button', { type: 'button', class: 'link-button template-remove', onclick: async () => { if (await confirmAction({ title: `Delete the template “${t.name}”?`, body: 'Files made from it stay as they are.', confirm: 'Delete' })) { await cp.removeTemplate(t.id); d.close(); templateGallery() } } }, 'Delete') : null)
  const groups = []
  const mine = list.filter((t) => t.mine)
  if (mine.length) groups.push(['Your templates', mine])
  for (const app of state.apps) {
    const items = list.filter((t) => !t.mine && t.type === app.type)
    if (items.length) groups.push([app.name, items])
  }
  d.append(el('form', { method: 'dialog' },
    el('h2', {}, 'Start from a template'),
    el('p', { class: 'fineprint-plain' }, 'Templates are part of commonplace and work offline. Save any file of yours as a template from its menu in commonDrive.'),
    el('div', { class: 'template-groups' }, ...groups.map(([name, items]) => el('section', {},
      el('h3', {}, name),
      el('div', { class: 'template-grid' }, ...items.map(card))))),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn btn-quiet', value: 'cancel' }, 'Cancel'))))
  document.body.append(d)
  d.addEventListener('close', () => d.remove())
  d.showModal()
}

async function copyFile (f) {
  try {
    await cp.copyFile(f.docId)
    toast(`Made “Copy of ${f.title || 'Untitled'}”`)
  } catch (err) { toast(cleanError(err)) }
}

async function saveTemplate (f) {
  const name = await promptText({ title: 'Save as template', label: 'Template name', value: f.title, confirm: 'Save template', body: 'The content is saved on this computer, without the people, comments or history. Your templates appear under New → From a template.' })
  if (!name) return
  try { await cp.saveAsTemplate(f.docId, name, ''); toast(`Saved the template “${name}”`) } catch (err) { toast(cleanError(err)) }
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
    toast(`Imported${res.note ? ` ${res.note}` : ''}${res.warningText ? `. ${res.warningText}` : res.warnings ? '. Some formatting couldn’t be carried over.' : ''}`)
  } catch (err) {
    toast(`Couldn’t import that file: ${cleanError(err)}`)
  }
}

function folderMenu (anchor, f) {
  if (f.shared) return sharedFolderMenu(anchor, f)
  openMenu(anchor, [
    { label: 'Open', onSelect: () => goTo(f.id) },
    { label: 'Share…', icon: icons.share, onSelect: () => shareFolder(f) },
    { label: 'Rename…', onSelect: async () => { const name = await promptText({ title: 'Rename folder', label: 'Name', value: f.name, confirm: 'Rename' }); if (name) cp.renameFolder(f.id, name) } },
    { label: 'Move to…', onSelect: () => moveDialog({ kind: 'folder', id: f.id, name: f.name, current: f.parentId }) },
    { sep: true },
    {
      label: 'Delete folder…',
      danger: true,
      onSelect: async () => {
        const parent = folderById(f.parentId)?.name || 'commonDrive'
        if (await confirmAction({ title: `Delete “${f.name}”?`, body: `Only the folder is deleted. Everything inside it moves to ${parent}.`, confirm: 'Delete folder' })) {
          if (state.folderId === f.id) state.folderId = f.parentId || null
          await cp.deleteFolder(f.id)
        }
      }
    }
  ], { label: `Folder ${f.name}` })
}

function sharedFolderMenu (anchor, f) {
  openMenu(anchor, [
    { label: 'Open', onSelect: () => goTo(f.id) },
    { label: 'Share…', icon: icons.share, onSelect: () => shareDialog(f.id) },
    canChange(f) ? { label: 'Rename…', onSelect: async () => { const name = await promptText({ title: 'Rename shared folder', label: 'Name', value: f.name, confirm: 'Rename', body: 'Everyone in the folder sees the new name.' }); if (name) cp.renameFolder(f.id, name) } } : null,
    { label: 'Move to…', onSelect: () => moveDialog({ kind: 'folder', id: f.id, name: f.name, current: f.parentId }) },
    f.removed ? { label: `Bring back ${plural(f.removed, 'file')} you removed`, onSelect: async () => { await cp.restoreRemoved(f.id); toast('They’ll come back from the folder') } } : null,
    { sep: true },
    {
      label: 'Remove from my Drive…',
      danger: true,
      onSelect: async () => {
        const mine = docs().filter((x) => x.folderId === f.id && x.role === 'owner').length
        const body = [
          'The folder leaves your Drive; everyone else keeps it.',
          mine ? `Your ${plural(mine, 'file')} in it come out of it first, so people who had ${mine === 1 ? 'it' : 'them'} only through the folder lose access.` : null,
          'Other files you got through it that you never opened leave too.'
        ].filter(Boolean).join(' ')
        if (await confirmAction({ title: `Remove “${f.name}” from your Drive?`, body, confirm: 'Remove' })) {
          if (state.folderId === f.id) state.folderId = f.parentId || null
          await cp.removeFile(f.id)
        }
      }
    }
  ].filter(Boolean), { label: `Shared folder ${f.name}` })
}

function sharedNote (f) {
  if (!f.shared) return null
  const others = (f.people || 1) - 1
  return { text: others ? `Shared with ${others === 1 ? '1 person' : `${others} people`}` : 'Shared folder, just you so far' }
}

async function newSharedFolder () {
  const name = await promptText({ title: 'New shared folder', label: 'Name', confirm: 'Create folder', body: 'Invite people to it, and they get everything inside: what you put there, and what the others do.' })
  if (!name) return
  try {
    const id = await cp.createSharedFolder(name, state.folderId)
    await refreshLists()
    shareDialog(id)
  } catch (err) { toast(cleanError(err)) }
}

async function shareFolder (f) {
  const ok = await confirmAction({
    title: `Share “${f.name}”?`,
    body: 'It becomes a shared folder, with its subfolders. Everyone you invite gets every file you own inside it. Files other people own stay in it for you only.',
    confirm: 'Make it shared',
    danger: false
  })
  if (!ok) return
  try {
    const id = await cp.shareFolder(f.id)
    if (state.folderId === f.id) state.folderId = id
    await refreshLists()
    shareDialog(id)
  } catch (err) { toast(cleanError(err)) }
}

async function refreshLists () {
  state.files = await cp.listFiles()
  state.folders = await cp.listFolders()
  renderDrive()
}

function fileMenu (anchor, f) {
  const openable = f.supported && !f.waitingForPeer
  if (f.trashedAt) {
    openMenu(anchor, [
      { label: 'Open', disabled: !openable, onSelect: () => handlers.openDocument(f.docId) },
      { label: 'Put back', onSelect: async () => { await cp.untrashFile(f.docId); toast(`Put “${f.title}” back`) } },
      { sep: true },
      {
        label: 'Delete from this computer…',
        danger: true,
        onSelect: async () => {
          const body = f.role === 'owner'
            ? 'This deletes your copy, on each of your computers. Anyone you shared it with keeps theirs. This can’t be undone.'
            : `Shared by ${f.owner?.name || 'someone'}. This deletes your copy only, on each of your computers.`
          if (await confirmAction({ title: `Delete “${f.title}”?`, body, confirm: 'Delete' })) { await cp.removeFile(f.docId); toast('Deleted') }
        }
      }
    ], { label: f.title })
    return
  }
  openMenu(anchor, [
    { label: 'Open', disabled: !openable, onSelect: () => handlers.openDocument(f.docId) },
    { label: 'Share\u2026', icon: icons.invite, disabled: f.waitingForPeer, onSelect: () => shareDialog(f.docId) },
    { label: 'Sync in the background', hint: f.syncMode === 'open' ? 'Off: syncs only while the file is open' : 'On: syncs whenever commonplace is running', checked: f.syncMode !== 'open', onSelect: () => setSyncMode(f.docId, f.syncMode === 'open' ? 'always' : 'open') },
    { label: 'Move to…', icon: icons.folder, onSelect: () => moveDialog({ kind: 'file', id: f.docId, name: f.title, current: f.folderId }) },
    f.conflicts?.length ? { label: f.role === 'owner' ? 'Review conflicts\u2026' : 'See conflicts\u2026', onSelect: () => conflictsDialog(f.docId) } : null,
    { label: 'Make a copy', disabled: !openable || f.kind === 'file', onSelect: () => copyFile(f) },
    { label: 'Save as template…', disabled: !openable || f.kind === 'file', onSelect: () => saveTemplate(f) },
    { label: f.starred ? 'Remove star' : 'Add star', onSelect: () => cp.starFile(f.docId, !f.starred) },
    { label: 'Details', onSelect: () => detailsDialog(f) },
    { sep: true },
    { label: 'Move to the trash', danger: true, onSelect: () => trashFile(f) }
  ], { label: f.title })
}

export async function trashFile (f) {
  await cp.trashFile(f.docId)
  toast(`Moved “${f.title || 'Untitled'}” to the trash`, { label: 'Undo', run: () => cp.untrashFile(f.docId) })
}

function detailsDialog (f) {
  const rows = [
    ['Type', f.appName || 'Unknown'],
    ['Owner', f.role === 'owner' ? 'You' : (f.owner?.name || 'Unknown')],
    ['Your access', ROLE_LABEL[f.role] || (f.access.removed ? 'Removed' : 'Not yet confirmed')],
    ['Written by', f.contributors.length ? listNames(f.contributors) : 'Nobody yet'],
    ['Folder', f.folderId ? folderPath(f.folderId).map((p) => p.name).join(' / ') : 'commonDrive'],
    ['Last change', [ago(f.lastChangeAt || f.addedAt), f.lastChangedBy ? `by ${f.lastChangedBy}` : null].filter(Boolean).join(' ') || '—'],
    ['Sync', statusNotes(f).map((n) => n.text).join('. ')]
  ]
  dialog({ title: f.title || 'Untitled', body: el('dl', { class: 'details' }, rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])), confirm: 'Done', cancel: null })
}

async function moveDialog ({ kind, id, name, current }) {
  const blocked = kind === 'folder' ? descendantIds(id) : new Set()
  const options = [{ id: '', label: 'commonDrive', depth: 0 }]
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
      svg(folderIcon(folderById(o.id))), el('span', {}, o.label))))
  const res = await dialog({ title: `Move “${name}”`, fields: [list], confirm: 'Move here' })
  if (res?.action !== 'confirm') return
  moveTo({ kind, id }, res.data.target || null)
}

// Moving into a shared folder shares; moving out of one unshares.
async function moveTo ({ kind, id }, target) {
  const dest = folderById(target)
  const item = kind === 'file' ? state.files.find((f) => f.docId === id) : folderById(id)
  const from = folderById(kind === 'file' ? item?.folderId : item?.parentId)
  if ((from?.id || null) === (target || null)) return
  const mine = kind === 'folder' || item?.role === 'owner'
  if (dest?.shared && mine) {
    const ok = await confirmAction({ title: `Share with everyone in “${dest.name}”?`, body: `Everyone in the folder gets “${item?.title || item?.name}”: the folder’s editors can edit it, its viewers can view it.`, confirm: 'Move and share', danger: false })
    if (!ok) return
  } else if (from?.shared && mine && !dest?.shared) {
    const ok = await confirmAction({ title: `Take it out of “${from.name}”?`, body: 'People who had it only through the folder lose access. People you invited to it yourself keep theirs.', confirm: 'Move', danger: false })
    if (!ok) return
  }
  try {
    const res = kind === 'file' ? await cp.moveFile(id, target) : await cp.moveFolder(id, target)
    if (res === false) toast('A folder can’t go inside itself.')
    else toast(res?.localOnly ? res.message : `Moved to ${dest?.name || 'commonDrive'}`)
  } catch (err) { toast(cleanError(err)) }
}
