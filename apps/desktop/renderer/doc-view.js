// CommonDocs window: markdown and paged documents, their toolbars, links,
// math, tables, images, page setup and export.

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import katex from 'katex'
import { createDocsEditor, activeFormats, setBlock, pageGeometry, readPage, normalizePage, PAGE_SIZES, isSuggesting, withoutSuggestions, suggestionList } from '@commonplace/docs/editor'
import { $, el, svg, toast, openMenu, closeMenu, dialog, selectField, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp, statusNotes, renderNotes } from './state.js'
import { shareDialog } from './share.js'
import { conflictsDialog } from './conflicts.js'
import { toggleHistory, closePanel } from './history-view.js'
import { attachReview, recordMySuggestions, toggleComments, newComment } from './comments-view.js'

// Fonts that ship with both macOS and Windows (plus Office's), so a document
// looks the same on everyone's computer.
const FONTS = [
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Palatino', value: '"Palatino Linotype", Palatino, serif' },
  { label: 'Garamond', value: 'Garamond, "EB Garamond", serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Carlito, sans-serif' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' }
]
const SIZES = [8, 9, 10, 10.5, 11, 12, 13, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72]
const ZOOMS = [50, 75, 90, 100, 110, 125, 150, 200]
const ZOOM_KEY = 'commonplace.doc.zoom'
const loadZoom = () => { try { return localStorage.getItem(ZOOM_KEY) || 'fit' } catch { return 'fit' } }
const saveZoom = (v) => { try { localStorage.setItem(ZOOM_KEY, v) } catch {} }
const TEXT_COLORS = [
  ['Ink', '#1f2430'], ['Slate', '#5c6270'], ['Blue', '#284b8c'], ['Green', '#2f6b4f'],
  ['Red', '#9b2c2c'], ['Rust', '#b4532a'], ['Ochre', '#a2741b'], ['Plum', '#6b3f8c']
]
const HIGHLIGHTS = [
  ['Yellow', '#fff3a3'], ['Green', '#d4efd9'], ['Blue', '#d6e4fb'], ['Pink', '#f8d7e3'], ['Gray', '#e6e7ea']
]

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
    if (state.open && (e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') { e.preventDefault(); newComment() }
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
  // only once I actually change something: opening a document is not an edit.
  let authored = ydoc.getMap('authors').has(String(ydoc.clientID))
  ydoc.on('update', (_u, origin) => {
    if (authored || origin === 'main') return
    authored = true
    queueMicrotask(() => { if (!ydoc.isDestroyed) ydoc.getMap('authors').set(String(ydoc.clientID), { userId: state.me.userId }) })
  })
  awareness.setLocalStateField('user', { name: state.me.name, color: state.me.color, userId: state.me.userId })

  // Build the writing surface for this kind of document.
  const desk = $('#desk')
  desk.className = `desk desk-${kind}`
  const host = el('div', { class: 'editor', id: 'editor' })
  let paper = null
  if (kind === 'paged') {
    paper = el('div', { class: 'paper' }, el('div', { class: 'sheets', 'aria-hidden': 'true' }), host)
    desk.replaceChildren(paper)
  } else {
    desk.replaceChildren(host)
  }

  const pageMap = ydoc.getMap('page')
  const o = { docId, kind, ydoc, awareness, editor: null, paper, pages: 1, zoom: 1, cleanup }
  state.open = o

  o.editor = createDocsEditor({
    kind,
    element: host,
    ydoc,
    awareness,
    user: state.me,
    onUpdate: () => { if (state.open === o) syncToolbar() },
    onEditMath: (m) => { if (state.open === o) mathDialog(m) },
    onOpenLink: (href) => cp.openLink(href),
    getPageSetup: () => readPage(ydoc),
    getZoom: () => o.zoom || 1,
    getMaxImageWidth: () => (kind === 'paged' ? pageGeometry(readPage(ydoc)).contentWidth : 680),
    onLayout: ({ pages, geometry }) => { if (state.open !== o) return; o.pages = pages; drawSheets(o.paper, pages, geometry); renderDocMargin() },
    onNewSuggestion: (ids) => { if (state.open === o) recordMySuggestions(o, ids) }
  })
  attachReview(o)

  if (kind === 'paged') {
    applyPageGeometry()
    const onPage = () => { applyPageGeometry(); o.editor.storage.pagination?.refresh() }
    pageMap.observe(onPage)
    // Shrink pages to fit narrow windows instead of scrolling sideways.
    const fit = new ResizeObserver(() => requestAnimationFrame(() => { if (state.open === o && fitPaper()) o.editor.storage.pagination?.refresh() }))
    fit.observe(desk)
    cleanup.push(() => pageMap.unobserve(onPage), () => fit.disconnect())
  }

  // Title lives in the shared container metadata.
  const meta = ydoc.getMap('meta')
  const title = $('#doc-title')
  const showTitle = () => { if (document.activeElement !== title && !o.closePreview) title.value = meta.get('title') || '' }
  meta.observe(showTitle)
  cleanup.push(() => meta.unobserve(showTitle))
  showTitle()
  title.oninput = () => meta.set('title', title.value)
  title.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); o.editor.commands.focus('start') } }

  awareness.on('change', renderPresence)

  $('#drive-view').hidden = true
  $('#doc-view').hidden = false
  $('#doc-view').dataset.kind = kind
  renderToolbar()
  renderPresence()
  renderDocMargin()

  if (initialContent?.value) {
    // Imported file: load it into the (empty) shared document once.
    await new Promise((r) => setTimeout(r, 0))
    o.editor.commands.setContent(initialContent.value, { contentType: initialContent.type === 'markdown' ? 'markdown' : 'html' })
  }
  if (focusTitle) { title.focus(); title.select() } else o.editor.commands.focus('start')
}

// Shows another state of this document (an old version) read-only in place
// of the live one. Returns a function that puts the live document back.
export function showPreview (update) {
  const o = state.open
  if (!o) return () => {}
  o.closePreview?.()
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, update)
  const awareness = new awarenessProtocol.Awareness(ydoc)
  const desk = $('#desk')
  const live = desk.firstElementChild
  const host = el('div', { class: 'editor' })
  let paper = null
  if (o.kind === 'paged') {
    paper = el('div', { class: 'paper', style: `zoom:${o.zoom || 1}` }, el('div', { class: 'sheets', 'aria-hidden': 'true' }), host)
    setPaperGeometry(paper, readPage(ydoc))
  }
  live.hidden = true
  desk.append(paper || host)
  const editor = createDocsEditor({
    kind: o.kind,
    element: host,
    ydoc,
    awareness,
    user: state.me,
    editable: false,
    onOpenLink: (href) => cp.openLink(href),
    getPageSetup: () => readPage(ydoc),
    getZoom: () => o.zoom || 1,
    getMaxImageWidth: () => (o.kind === 'paged' ? pageGeometry(readPage(ydoc)).contentWidth : 680),
    onLayout: ({ pages, geometry }) => { if (paper) drawSheets(paper, pages, geometry) }
  })
  $('#doc-view').classList.add('previewing')
  o.closePreview = () => {}
  renderDocMargin()
  $('#doc-title').readOnly = true
  $('#doc-title').value = ydoc.getMap('meta').get('title') || ''
  const close = () => {
    if (o.closePreview !== close) return
    o.closePreview = null
    editor.destroy()
    awareness.destroy()
    ydoc.destroy()
    ;(paper || host).remove()
    live.hidden = false
    $('#doc-view').classList.remove('previewing')
    $('#doc-title').value = o.ydoc.getMap('meta').get('title') || ''
    renderDocMargin()
    o.editor?.storage.pagination?.refresh()
  }
  o.closePreview = close
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
  o.editor?.destroy()
  o.awareness.destroy()
  o.ydoc.destroy()
  await cp.closeDoc(o.docId)
  $('#desk').replaceChildren()
}

// ---- paged layout -------------------------------------------------------------------

function applyPageGeometry () {
  const o = state.open
  if (!o?.paper) return
  setPaperGeometry(o.paper, readPage(o.ydoc))
  fitPaper()
}

function setPaperGeometry (paper, setup) {
  const g = pageGeometry(setup)
  const s = paper.style
  s.setProperty('--page-w', `${g.width}px`)
  s.setProperty('--page-h', `${g.height}px`)
  s.setProperty('--m-top', `${g.margins.top}px`)
  s.setProperty('--m-right', `${g.margins.right}px`)
  s.setProperty('--m-bottom', `${g.margins.bottom}px`)
  s.setProperty('--m-left', `${g.margins.left}px`)
  s.setProperty('--page-gap', `${g.gap}px`)
}

// Pages are drawn at real size: 96 pixels per inch and text in points, so
// 12 pt text on a Letter page has the same proportions as on paper. Zoom
// scales both together. "Fit" uses 100% unless the window is too narrow.
function fitPaper () {
  const o = state.open
  if (!o?.paper) return false
  const g = pageGeometry(readPage(o.ydoc))
  const pref = loadZoom()
  // The visible width, not the desk's: the desk grows with the page.
  const room = $('.sheet').clientWidth - $('#doc-margin').offsetWidth - 64
  const zoom = pref === 'fit' ? Math.max(0.3, Math.min(1, room / g.width)) : Number(pref) / 100
  syncZoomControl(pref, zoom)
  if (Math.abs(zoom - o.zoom) < 0.005) return false
  o.zoom = zoom
  o.paper.style.zoom = String(zoom)
  return true
}

function syncZoomControl (pref, zoom) {
  const sel = $('[data-cmd="zoom"]')
  if (!sel) return
  const fit = sel.querySelector('option[value="fit"]')
  if (fit) fit.textContent = `Fit (${Math.round(zoom * 100)}%)`
  if (document.activeElement !== sel) sel.value = pref
}

function drawSheets (paper, pages, g) {
  const sheets = paper.querySelector('.sheets')
  if (sheets.children.length !== pages || sheets.dataset.geo !== `${g.width}x${g.height}:${g.pageNumbers}`) {
    sheets.dataset.geo = `${g.width}x${g.height}:${g.pageNumbers}`
    sheets.replaceChildren(...Array.from({ length: pages }, (_, i) => el('div', {
      class: 'page-sheet',
      style: `top:${i * (g.height + g.gap)}px`
    }, g.pageNumbers ? el('span', { class: 'page-number', style: `bottom:${Math.max(8, g.margins.bottom / 2 - 8)}px` }, String(i + 1)) : null)))
  }
  paper.style.minHeight = `${pages * (g.height + g.gap) - g.gap}px`
}

// ---- toolbar ---------------------------------------------------------------------------

function toolButton (id, label, icon, run, { key } = {}) {
  const mac = cp.platform === 'darwin'
  const shortcut = key ? ` (${key.replace('Mod', mac ? '⌘' : 'Ctrl').replace('Shift', mac ? '⇧' : 'Shift').replace(/-/g, mac ? '' : '+')})` : ''
  return el('button', {
    type: 'button',
    class: 'tool',
    'data-cmd': id,
    title: label + shortcut,
    'aria-label': label,
    'aria-pressed': 'false',
    onmousedown: (e) => e.preventDefault(),
    onclick: (e) => { if (state.open?.editor) run(state.open.editor, e.currentTarget) }
  }, typeof icon === 'string' && icon.startsWith('<svg') ? svg(icon) : icon)
}

const sep = () => el('span', { class: 'tool-sep', role: 'separator' })

function renderToolbar () {
  const o = state.open
  const paged = o.kind === 'paged'
  const bar = $('#toolbar')

  const blockSelect = el('select', { class: 'tool-select', 'data-cmd': 'block', 'aria-label': 'Text style', onchange: (e) => setBlock(o.editor, e.target.value) },
    el('option', { value: 'p' }, 'Normal text'),
    el('option', { value: 'h1' }, 'Heading 1'),
    el('option', { value: 'h2' }, 'Heading 2'),
    el('option', { value: 'h3' }, 'Heading 3'),
    el('option', { value: 'code' }, 'Code block'))

  const groups = [[blockSelect]]
  if (paged) {
    groups[0].push(
      el('select', { class: 'tool-select tool-font', 'data-cmd': 'font', 'aria-label': 'Font', onchange: (e) => { const v = e.target.value; if (v && v !== 'mixed') o.editor.chain().focus().setFontFamily(v).run() } },
        ...FONTS.map((f) => el('option', { value: f.value }, f.label))),
      el('select', { class: 'tool-select tool-size', 'data-cmd': 'size', 'aria-label': 'Font size', onchange: (e) => { const v = e.target.value; if (v && v !== 'mixed') o.editor.chain().focus().setFontSize(`${v}pt`).run() } },
        ...SIZES.map((n) => el('option', { value: String(n) }, String(n)))))
  }
  groups.push([
    toolButton('bold', 'Bold', el('b', {}, 'B'), (e) => e.chain().focus().toggleBold().run(), { key: 'Mod-B' }),
    toolButton('italic', 'Italic', el('i', {}, 'I'), (e) => e.chain().focus().toggleItalic().run(), { key: 'Mod-I' }),
    toolButton('underline', 'Underline', el('u', {}, 'U'), (e) => e.chain().focus().toggleUnderline().run(), { key: 'Mod-U' }),
    toolButton('strike', 'Strikethrough', el('s', {}, 'S'), (e) => e.chain().focus().toggleStrike().run()),
    paged
      ? toolButton('color', 'Text color', icons.color, (e, b) => colorMenu(b))
      : toolButton('code', 'Inline code', el('code', {}, '</>'), (e) => e.chain().focus().toggleCode().run(), { key: 'Mod-E' }),
    paged ? toolButton('highlight', 'Highlight', icons.highlight, (e, b) => highlightMenu(b)) : null
  ].filter(Boolean))
  groups.push([
    toolButton('link', 'Link', icons.link, () => linkDialog(), { key: 'Mod-K' }),
    toolButton('math', 'Math (LaTeX)', icons.math, () => mathDialog({ display: false, latex: '' }))
  ])
  if (paged) {
    groups[groups.length - 1].push(toolButton('align', 'Alignment', icons.alignLeft, (e, b) => alignMenu(b)))
  }
  groups.push([
    toolButton('bulletList', 'Bulleted list', icons.bullets, (e) => e.chain().focus().toggleBulletList().run()),
    toolButton('orderedList', 'Numbered list', icons.numbers, (e) => e.chain().focus().toggleOrderedList().run()),
    toolButton('blockquote', 'Quote', icons.quote, (e) => e.chain().focus().toggleBlockquote().run())
  ])
  groups.push([
    toolButton('table', 'Table', icons.table, (e, b) => tableMenu(b)),
    toolButton('image', 'Image', icons.image, () => insertImage()),
    toolButton('rule', 'Divider', icons.rule, (e) => e.chain().focus().setHorizontalRule().run()),
    paged ? toolButton('pageBreak', 'Page break', icons.pageBreak, (e) => e.chain().focus().setPageBreak().run(), { key: 'Mod-Enter' }) : null
  ].filter(Boolean))
  groups.push([
    toolButton('comment', 'Comment on the selection', icons.comment, () => newComment(), { key: 'Mod-Alt-M' })
  ])
  groups.push([
    toolButton('undo', 'Undo your last change', icons.undo, (e) => e.chain().focus().undo().run(), { key: 'Mod-Z' }),
    toolButton('redo', 'Redo', icons.redo, (e) => e.chain().focus().redo().run(), { key: 'Mod-Shift-Z' })
  ])

  const children = []
  groups.forEach((g, i) => { if (i) children.push(sep()); children.push(...g) })
  children.push(el('span', { class: 'tool-spacer' }),
    el('select', {
      class: 'tool-select tool-mode',
      'data-cmd': 'mode',
      'aria-label': 'Editing or suggesting',
      title: 'Suggesting turns your edits into suggestions others can accept or reject',
      onchange: (e) => { o.editor.chain().focus().setSuggesting(e.target.value === 'suggesting').run(); renderDocMargin() }
    }, el('option', { value: 'editing' }, 'Editing'), el('option', { value: 'suggesting' }, 'Suggesting')))
  if (paged) {
    children.push(
      el('select', {
        class: 'tool-select tool-zoom',
        'data-cmd': 'zoom',
        'aria-label': 'Zoom',
        onchange: (e) => { saveZoom(e.target.value); if (fitPaper()) state.open?.editor.storage.pagination?.refresh() }
      }, el('option', { value: 'fit' }, 'Fit'), ...ZOOMS.map((z) => el('option', { value: String(z) }, `${z}%`))))
  }
  bar.replaceChildren(...children)
  $('[data-action="page-setup"]').hidden = !paged
  syncToolbar()
}

// Selects a value, adding a temporary option for values outside the list
// (a size like 15.5 pasted from elsewhere, a font from an imported file).
function showValue (select, value, label) {
  select.querySelectorAll('option[data-extra]').forEach((x) => x.remove())
  if (![...select.options].some((x) => x.value === value)) {
    select.append(el('option', { value, 'data-extra': 'true', disabled: value === 'mixed' || null }, label))
  }
  select.value = value
}

function syncToolbar () {
  const o = state.open
  if (!o?.editor || o.editor.isDestroyed) return
  const f = activeFormats(o.editor)
  const press = (id, on) => { const b = $(`.tool[data-cmd="${id}"]`); if (b) b.setAttribute('aria-pressed', String(Boolean(on))) }
  for (const k of ['bold', 'italic', 'underline', 'strike', 'code', 'link', 'bulletList', 'orderedList', 'blockquote', 'table']) press(k, f[k])
  press('color', f.color)
  press('highlight', f.highlight)
  const align = $('.tool[data-cmd="align"]')
  if (align && align.dataset.align !== f.align) {
    align.dataset.align = f.align
    align.replaceChildren(svg(ALIGN_ICONS[f.align]))
  }
  const block = $('[data-cmd="block"]')
  if (block && document.activeElement !== block) block.value = f.block
  // Font and size always show what the text really uses, defaults included.
  const font = $('[data-cmd="font"]')
  if (font && document.activeElement !== font) {
    const known = FONTS.find((x) => x.label.toLowerCase() === String(f.font).toLowerCase())
    showValue(font, f.font === 'mixed' ? 'mixed' : (known?.value || f.font), f.font === 'mixed' ? 'Mixed' : f.font)
  }
  const size = $('[data-cmd="size"]')
  if (size && document.activeElement !== size) showValue(size, String(f.size), f.size === 'mixed' ? 'Mixed' : String(f.size))
  const zoomSel = $('[data-cmd="zoom"]')
  if (zoomSel) syncZoomControl(loadZoom(), o.zoom || 1)
  const mode = $('[data-cmd="mode"]')
  if (mode && document.activeElement !== mode) mode.value = isSuggesting(o.editor) ? 'suggesting' : 'editing'
}

function swatchMenu (anchor, label, colors, apply, clear, clearLabel) {
  const grid = el('div', { class: 'swatch-grid', role: 'group', 'aria-label': label },
    ...colors.map(([name, hex]) => el('button', { type: 'button', class: 'swatch-btn', title: name, 'aria-label': name, style: `--swatch:${hex}`, onclick: () => { closeMenu(); apply(hex) } })))
  openMenu(anchor, [{ custom: grid }, { sep: true }, { label: clearLabel, onSelect: clear }], { label })
}

const ALIGN_ICONS = { left: icons.alignLeft, center: icons.alignCenter, right: icons.alignRight, justify: icons.alignJustify }

function alignMenu (anchor) {
  const e = state.open.editor
  const current = activeFormats(e).align
  const mac = cp.platform === 'darwin'
  openMenu(anchor, [
    ...[['left', 'Align left'], ['center', 'Center'], ['right', 'Align right'], ['justify', 'Justify']]
      .map(([value, label]) => ({ label, icon: ALIGN_ICONS[value], checked: current === value, onSelect: () => e.chain().focus().setTextAlign(value).run() })),
    { sep: true },
    { label: 'Increase indent', hint: 'Tab', onSelect: () => e.chain().focus().indent().run() },
    { label: 'Decrease indent', hint: mac ? '\u21e7 Tab' : 'Shift+Tab', onSelect: () => e.chain().focus().outdent().run() }
  ], { label: 'Alignment and indent' })
}

function colorMenu (anchor) {
  const e = state.open.editor
  swatchMenu(anchor, 'Text color', TEXT_COLORS, (c) => e.chain().focus().setColor(c).run(), () => e.chain().focus().unsetColor().run(), 'Default color')
}

function highlightMenu (anchor) {
  const e = state.open.editor
  swatchMenu(anchor, 'Highlight', HIGHLIGHTS, (c) => e.chain().focus().setHighlight({ color: c }).run(), () => e.chain().focus().unsetHighlight().run(), 'No highlight')
}

function tableMenu (anchor) {
  const e = state.open.editor
  if (!e.isActive('table')) {
    e.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
    return
  }
  const run = (fn) => () => fn(e.chain().focus()).run()
  openMenu(anchor, [
    { label: 'Add row above', onSelect: run((c) => c.addRowBefore()) },
    { label: 'Add row below', onSelect: run((c) => c.addRowAfter()) },
    { label: 'Add column left', onSelect: run((c) => c.addColumnBefore()) },
    { label: 'Add column right', onSelect: run((c) => c.addColumnAfter()) },
    { sep: true },
    { label: 'Header row on or off', onSelect: run((c) => c.toggleHeaderRow()) },
    { label: 'Merge or split cells', onSelect: run((c) => c.mergeOrSplit()) },
    { sep: true },
    { label: 'Delete row', danger: true, onSelect: run((c) => c.deleteRow()) },
    { label: 'Delete column', danger: true, onSelect: run((c) => c.deleteColumn()) },
    { label: 'Delete table', danger: true, onSelect: run((c) => c.deleteTable()) }
  ], { label: 'Table' })
}

async function insertImage () {
  try {
    const img = await cp.pickImage()
    if (!img) return
    const size = await new Promise((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve({ width: probe.naturalWidth, height: probe.naturalHeight })
      probe.onerror = () => resolve({})
      probe.src = img.src
    })
    // Fit wide images to the text column; docx export uses these sizes.
    const max = state.open.kind === 'paged' ? pageGeometry(readPage(state.open.ydoc)).contentWidth : 680
    let { width, height } = size
    if (width > max) { height = Math.round(height * max / width); width = max }
    state.open.editor.chain().focus().setImage({ src: img.src, alt: img.alt, width, height }).run()
  } catch (err) {
    toast(cleanError(err))
  }
}

// ---- link and math dialogs ---------------------------------------------------------

async function linkDialog () {
  const e = state.open.editor
  const current = e.getAttributes('link').href || ''
  const { from, to, empty } = e.state.selection
  const selected = e.state.doc.textBetween(from, to, ' ')
  const url = el('input', { name: 'url', value: current, placeholder: 'https://example.com', autocomplete: 'off', spellcheck: 'false' })
  const text = el('input', { name: 'text', value: selected, placeholder: 'Text to show', autocomplete: 'off' })
  const res = await dialog({
    title: current ? 'Edit link' : 'Add link',
    body: 'Links open in your browser with Ctrl+click (⌘+click on a Mac).',
    fields: [el('label', { class: 'field' }, 'Link', url), empty && !current ? el('label', { class: 'field' }, 'Text', text) : null].filter(Boolean),
    confirm: current ? 'Update link' : 'Add link',
    extraActions: current ? [{ label: 'Remove link', value: 'remove', danger: true }] : [],
    validate: (d) => (normalizeUrl(d.url) ? null : 'Enter a web address or an email address.')
  })
  if (res?.action === 'remove') { e.chain().focus().extendMarkRange('link').unsetLink().run(); return }
  if (res?.action !== 'confirm') { e.commands.focus(); return }
  const href = normalizeUrl(res.data.url)
  if (empty && !current) {
    const label = res.data.text?.trim() || href.replace(/^mailto:/, '')
    e.chain().focus().insertContent({ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }).run()
  } else {
    e.chain().focus().extendMarkRange('link').setLink({ href }).run()
  }
}

function normalizeUrl (raw) {
  const v = String(raw || '').trim()
  if (!v) return null
  if (/^(https?:|mailto:)/i.test(v)) return v
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`
  if (/^[^\s]+\.[^\s]{2,}/.test(v)) return `https://${v}`
  return null
}

async function mathDialog ({ display, latex, pos }) {
  const e = state.open.editor
  const editing = pos != null
  const preview = el('div', { class: 'math-preview', 'aria-live': 'polite' })
  const input = el('textarea', { name: 'latex', rows: '3', spellcheck: 'false', placeholder: 'e.g. \\frac{a}{b} or \\int_0^1 x^2\\,dx' }, latex)
  const block = el('input', { type: 'checkbox', name: 'display', checked: display || null })
  const render = () => {
    try {
      katex.render(input.value || '\\square', preview, { displayMode: block.checked, throwOnError: true })
      preview.classList.remove('math-error')
    } catch (err) {
      preview.textContent = err.message.replace(/^KaTeX parse error: /, '')
      preview.classList.add('math-error')
    }
  }
  input.addEventListener('input', render)
  block.addEventListener('change', render)
  render()
  const res = await dialog({
    title: editing ? 'Edit math' : 'Insert math',
    body: 'Write LaTeX. You can also type $$x^2$$ inline, or $$$x^2$$$ on its own line.',
    fields: [input, el('label', { class: 'check' }, block, 'Show on its own line'), preview],
    confirm: editing ? 'Update' : 'Insert',
    extraActions: editing ? [{ label: 'Delete', value: 'delete', danger: true }] : [],
    validate: (d) => (d.latex.trim() ? null : 'Write some LaTeX first.'),
    wide: true
  })
  if (res?.action === 'delete') {
    e.chain().focus().command(({ tr }) => { const node = tr.doc.nodeAt(pos); if (node) tr.delete(pos, pos + node.nodeSize); return true }).run()
    return
  }
  if (res?.action !== 'confirm') { e.commands.focus(); return }
  const value = res.data.latex.trim()
  const wantBlock = Boolean(res.data.display)
  const c = e.chain().focus()
  if (editing && wantBlock === display) {
    (display ? c.updateBlockMath({ latex: value, pos }) : c.updateInlineMath({ latex: value, pos })).run()
  } else {
    if (editing) c.command(({ tr }) => { const node = tr.doc.nodeAt(pos); if (node) tr.delete(pos, pos + node.nodeSize); return true }).setTextSelection(pos)
    ;(wantBlock ? c.insertBlockMath({ latex: value }) : c.insertInlineMath({ latex: value })).run()
  }
}

// ---- page setup and export -----------------------------------------------------------

async function pageSetupDialog () {
  const o = state.open
  const s = readPage(o.ydoc)
  const num = (name, value) => el('label', { class: 'field field-inline' }, name[0].toUpperCase() + name.slice(1),
    el('span', { class: 'unit' }, el('input', { type: 'number', name, value: String(s.margins[name]), min: '0.25', max: '3', step: '0.05' }), 'in'))
  const res = await dialog({
    title: 'Page setup',
    body: 'Changes apply for everyone working on this document.',
    fields: [
      selectField({ label: 'Paper size', name: 'size', value: s.size, options: Object.entries(PAGE_SIZES).map(([value, p]) => ({ value, label: p.label })) }),
      el('fieldset', { class: 'radio-row' }, el('legend', {}, 'Orientation'),
        ...['portrait', 'landscape'].map((v) => el('label', { class: 'check' }, el('input', { type: 'radio', name: 'orientation', value: v, checked: s.orientation === v || null }), v[0].toUpperCase() + v.slice(1)))),
      el('fieldset', { class: 'margins' }, el('legend', {}, 'Margins'), num('top', s.margins.top), num('bottom', s.margins.bottom), num('left', s.margins.left), num('right', s.margins.right)),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'pageNumbers', checked: s.pageNumbers || null }), 'Page numbers at the bottom')
    ],
    confirm: 'Apply',
    validate: (d) => (['top', 'right', 'bottom', 'left'].every((k) => Number(d[k]) >= 0.25 && Number(d[k]) <= 3) ? null : 'Margins must be between 0.25 and 3 inches.')
  })
  if (res?.action !== 'confirm') return
  const d = res.data
  const next = normalizePage({
    size: d.size,
    orientation: d.orientation,
    margins: { top: Number(d.top), right: Number(d.right), bottom: Number(d.bottom), left: Number(d.left) },
    pageNumbers: d.pageNumbers
  })
  o.ydoc.getMap('page').set('setup', next)
}

function exportMenu (anchor) {
  const o = state.open
  if (!o) return
  const file = state.files.find((f) => f.docId === o.docId)
  const formats = file?.exports?.length ? file.exports : (o.kind === 'paged' ? ['docx', 'pdf', 'md'] : ['md', 'docx'])
  const label = { md: 'Markdown (.md)', docx: 'Word document (.docx)', pdf: 'PDF' }
  const hint = {
    md: o.kind === 'paged' ? 'Keeps text and structure; drops page layout and fonts' : null,
    docx: o.kind === 'paged' ? 'Keeps pages, margins, fonts and alignment' : 'Opens in Word, Pages and Google Docs',
    pdf: 'Exactly as the pages look here'
  }
  openMenu(anchor, formats.map((fmt) => ({ label: label[fmt], hint: hint[fmt], icon: icons.download, onSelect: () => exportAs(fmt) })), { align: 'end', label: 'Export' })
}

async function exportAs (format) {
  const o = state.open
  try {
    // Exports leave out suggestions nobody has accepted yet.
    const json = withoutSuggestions(o.editor)
    const payload = format === 'md' ? { markdown: o.editor.storage.markdown.manager.serialize(json) } : format === 'docx' ? { json } : {}
    const pending = suggestionList(o.editor).length
    if (format === 'pdf') document.body.classList.add('printing')
    const saved = await cp.exportFile(o.docId, format, payload)
    if (saved) toast(pending ? `Saved ${saved}, without suggestions that haven\u2019t been accepted` : `Saved ${saved}`)
  } catch (err) {
    toast(`Couldn’t export: ${cleanError(err)}`)
  } finally {
    document.body.classList.remove('printing')
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

// Viewers (and people who were removed) get a read-only document.
function applyAccess () {
  const o = state.open
  if (!o?.editor) return
  const file = state.files.find((f) => f.docId === o.docId)
  const writable = Boolean(file) && (file.role === 'owner' || file.role === 'editor') && !file.access?.removed
  if (o.editor.isEditable !== writable) o.editor.setEditable(writable)
  $('#doc-title').readOnly = !writable || Boolean(o.closePreview)
  $('#toolbar').hidden = !writable
  $('#doc-view').classList.toggle('read-only', !writable)
}

export function renderDocMargin () {
  const o = state.open
  if (!o) return
  applyAccess()
  const file = state.files.find((f) => f.docId === o.docId)
  const notes = file ? statusNotes(file, { detailed: true }) : []
  if (o.kind === 'paged' && !o.closePreview) notes.unshift({ text: o.pages === 1 ? '1 page' : `${o.pages} pages` })
  if (o.closePreview) notes.unshift({ text: 'Showing an earlier version. Nothing here changes unless you restore it.', cls: 'warn' })
  else if (o.editor && isSuggesting(o.editor)) notes.unshift({ text: 'Suggesting: your edits show as suggestions for others to accept.', cls: 'live' })
  const conflicts = file?.conflicts || []
  const review = conflicts.length
    ? el('button', { type: 'button', class: 'btn margin-action', onclick: () => conflictsDialog(o.docId) }, file.role === 'owner' ? 'Review conflicts' : 'See conflicts')
    : null
  const requests = file?.requests?.length
    ? el('button', { type: 'button', class: 'btn margin-action', onclick: () => shareDialog(o.docId) }, 'Review requests')
    : null
  $('#doc-margin').replaceChildren(el('div', { class: 'margin-inner' }, ...renderNotes(notes), review, requests))
  // Mark the paragraphs in question.
  const keys = conflicts.filter((c) => c.kind === 'block').map((c) => c.unit)
  const sig = keys.join(',')
  if (o.editor && o.conflictSig !== sig) {
    o.conflictSig = sig
    o.editor.commands.setConflicts(keys)
  }
}
