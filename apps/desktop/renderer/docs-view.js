// commonDocs: the editor for markdown and paged documents, their toolbar,
// links, math, tables, images and page setup. The document window
// (doc-view.js) hosts it through the view interface returned by mountDocs.

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import katex from 'katex'
import { createDocsEditor, activeFormats, setBlock, pageGeometry, readPage, normalizePage, PAGE_SIZES, isSuggesting, withoutSuggestions, suggestionList, wordCount, footnotesOf, fillPageLine } from '@commonplace/docs/editor'
import { $, el, svg, toast, openMenu, dialog, selectField, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp } from './state.js'
import { toolButton, sep, swatchMenu, showValue, setToolbar, TEXT_COLORS } from './toolbar.js'
import { attachReview, recordMySuggestions, newComment } from './comments-view.js'

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
const HIGHLIGHTS = [
  ['Yellow', '#fff3a3'], ['Green', '#d4efd9'], ['Blue', '#d6e4fb'], ['Pink', '#f8d7e3'], ['Gray', '#e6e7ea']
]

// ---- the view -------------------------------------------------------------------

const tool = (id, label, icon, run, opts) => toolButton(id, label, icon, (b) => { const e = state.open?.editor; if (e) run(e, b) }, opts)

// Builds the editor for an open document `o` (see doc-view.js) and returns
// its view: what the document window needs from any kind of file.
export function mountDocs (o, { initialContent } = {}) {
  const { kind, ydoc, awareness } = o
  const desk = $('#desk')
  const host = el('div', { class: 'editor', id: 'editor' })
  if (kind === 'paged') {
    o.paper = el('div', { class: 'paper' }, el('div', { class: 'sheets', 'aria-hidden': 'true' }), host)
    desk.replaceChildren(o.paper)
  } else {
    desk.replaceChildren(host)
  }
  o.editor = createDocsEditor({
    kind,
    element: host,
    ydoc,
    awareness,
    user: state.me,
    onUpdate: () => { if (state.open === o) { syncToolbar(); o.refreshMargin() } },
    onEditMath: (m) => { if (state.open === o) mathDialog(m) },
    onEditFootnote: (n) => { if (state.open === o && o.editor?.isEditable) footnoteDialog(n) },
    onOpenLink: (href) => cp.openLink(href),
    getPageSetup: () => readPage(ydoc),
    getZoom: () => o.zoom || 1,
    getMaxImageWidth: () => (kind === 'paged' ? pageGeometry(readPage(ydoc)).contentWidth : 680),
    onLayout: ({ pages, geometry }) => { if (state.open !== o) return; o.pages = pages; drawSheets(o.paper, pages, geometry); o.refreshMargin() },
    onNewSuggestion: (ids) => { if (state.open === o) recordMySuggestions(o, ids) }
  })
  attachReview(o)
  const onFindKey = (e) => {
    if (state.open !== o || !(e.metaKey || e.ctrlKey) || e.altKey) return
    const k = e.key.toLowerCase()
    if (k === 'f' && !e.shiftKey) { e.preventDefault(); openFind(o) } else if (k === 'h' || (k === 'f' && e.shiftKey)) { e.preventDefault(); openFind(o, { replace: true }) } else if (k === 'g') { e.preventDefault(); e.shiftKey ? o.editor.commands.findPrevious() : o.editor.commands.findNext(); syncFind(o) }
  }
  document.addEventListener('keydown', onFindKey, true)
  o.cleanup.push(() => { document.removeEventListener('keydown', onFindKey, true); o.find?.remove() })

  if (kind === 'paged') {
    applyPageGeometry()
    const pageMap = ydoc.getMap('page')
    const onPage = () => { applyPageGeometry(); o.editor.storage.pagination?.refresh() }
    pageMap.observe(onPage)
    // Shrink pages to fit narrow windows instead of scrolling sideways.
    const fit = new ResizeObserver(() => requestAnimationFrame(() => { if (state.open === o && fitPaper()) o.editor.storage.pagination?.refresh() }))
    fit.observe(desk)
    o.cleanup.push(() => pageMap.unobserve(onPage), () => fit.disconnect())
  }
  renderToolbar()
  if (initialContent?.value) {
    // Imported file: load it into the (empty) shared document once.
    setTimeout(() => o.editor.commands.setContent(initialContent.value, { contentType: initialContent.type === 'markdown' ? 'markdown' : 'html' }), 0)
  }

  return {
    comments: true,
    focus: () => o.editor.commands.focus('start'),
    setEditable (writable) { if (o.editor.isEditable !== writable) o.editor.setEditable(writable) },
    notes () {
      if (isSuggesting(o.editor)) return [{ text: 'Suggesting: your edits show as suggestions for others to accept.', cls: 'live' }]
      const words = wordCount(o.editor.state).words
      const count = { text: `${words.toLocaleString()} word${words === 1 ? '' : 's'}`, action: { label: 'Details', run: () => wordCountDialog(o) } }
      return kind === 'paged' ? [{ text: o.pages === 1 ? '1 page' : `${o.pages} pages` }, count] : [count]
    },
    // Marks the paragraphs that have an open conflict.
    showConflicts (conflicts) {
      const keys = conflicts.filter((c) => c.kind === 'block').map((c) => c.unit)
      const sig = keys.join(',')
      if (o.conflictSig !== sig) { o.conflictSig = sig; o.editor.commands.setConflicts(keys) }
    },
    preview: (update) => previewDocs(o, update),
    // Exports leave out suggestions nobody has accepted yet.
    async exportPayload (format) {
      const json = withoutSuggestions(o.editor)
      const note = suggestionList(o.editor).length ? 'without suggestions that haven\u2019t been accepted' : null
      if (format === 'md') return { payload: { markdown: withContents(withNotes(o.editor.storage.markdown.manager.serialize(json), json), json) }, note }
      if (format === 'docx') return { payload: { json }, note }
      return { payload: {}, note, print: () => { document.body.classList.add('printing'); return () => document.body.classList.remove('printing') } }
    },
    exportFormats: { md: 'Markdown (.md)', docx: 'Word document (.docx)', pdf: 'PDF' },
    exportHints: {
      md: kind === 'paged' ? 'Keeps text and structure; drops page layout and fonts' : null,
      docx: kind === 'paged' ? 'Keeps pages, margins, fonts and alignment' : 'Opens in Word, Pages and Google Docs',
      pdf: 'Exactly as the pages look here'
    },
    destroy () { o.editor.destroy(); o.editor = null }
  }
}

// An earlier version, read-only, in place of the live document.
function previewDocs (o, update) {
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
  return {
    title: ydoc.getMap('meta').get('title') || '',
    close () {
      editor.destroy()
      awareness.destroy()
      ydoc.destroy()
      ;(paper || host).remove()
      live.hidden = false
      o.editor?.storage.pagination?.refresh()
    }
  }
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

// The pages behind the text, with their header and footer lines.
function drawSheets (paper, pages, g) {
  const sheets = paper.querySelector('.sheets')
  const title = state.open?.ydoc.getMap('meta').get('title') || ''
  const geo = JSON.stringify([g.width, g.height, g.header, g.footer, title, pages])
  if (sheets.dataset.geo !== geo) {
    sheets.dataset.geo = geo
    const line = (text, i, where) => text ? el('span', { class: 'page-number', style: `${where}:${Math.max(8, g.margins[where] / 2 - 8)}px` }, fillPageLine(text, { page: i + 1, pages, title })) : null
    sheets.replaceChildren(...Array.from({ length: pages }, (_, i) => el('div', {
      class: 'page-sheet',
      style: `top:${i * (g.height + g.gap)}px`
    }, line(g.header, i, 'top'), line(g.footer, i, 'bottom'))))
  }
  paper.style.minHeight = `${pages * (g.height + g.gap) - g.gap}px`
}

// ---- toolbar ---------------------------------------------------------------------------

function renderToolbar () {
  const o = state.open
  const paged = o.kind === 'paged'

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
    tool('bold', 'Bold', el('b', {}, 'B'), (e) => e.chain().focus().toggleBold().run(), { key: 'Mod-B' }),
    tool('italic', 'Italic', el('i', {}, 'I'), (e) => e.chain().focus().toggleItalic().run(), { key: 'Mod-I' }),
    tool('underline', 'Underline', el('u', {}, 'U'), (e) => e.chain().focus().toggleUnderline().run(), { key: 'Mod-U' }),
    tool('strike', 'Strikethrough', el('s', {}, 'S'), (e) => e.chain().focus().toggleStrike().run()),
    paged
      ? tool('color', 'Text color', icons.color, (e, b) => colorMenu(b))
      : tool('code', 'Inline code', el('code', {}, '</>'), (e) => e.chain().focus().toggleCode().run(), { key: 'Mod-E' }),
    paged ? tool('highlight', 'Highlight', icons.highlight, (e, b) => highlightMenu(b)) : null
  ].filter(Boolean))
  groups.push([
    tool('link', 'Link', icons.link, () => linkDialog(), { key: 'Mod-K' }),
    tool('math', 'Math (LaTeX)', icons.math, () => mathDialog({ display: false, latex: '' }))
  ])
  if (paged) {
    groups[groups.length - 1].push(tool('align', 'Alignment', icons.alignLeft, (e, b) => alignMenu(b)))
  }
  groups.push([
    tool('bulletList', 'Bulleted list', icons.bullets, (e) => e.chain().focus().toggleBulletList().run()),
    tool('orderedList', 'Numbered list', icons.numbers, (e) => e.chain().focus().toggleOrderedList().run()),
    tool('blockquote', 'Quote', icons.quote, (e) => e.chain().focus().toggleBlockquote().run())
  ])
  groups.push([
    tool('table', 'Table', icons.table, (e, b) => tableMenu(b)),
    tool('image', 'Image', icons.image, () => insertImage()),
    tool('rule', 'Divider', icons.rule, (e) => e.chain().focus().setHorizontalRule().run()),
    tool('footnote', 'Footnote', icons.footnote, () => footnoteDialog({ text: '', pos: null }), { key: 'Mod-Alt-F' }),
    tool('toc', 'Table of contents', icons.toc, (e) => e.chain().focus().insertTableOfContents().run()),
    paged ? tool('pageBreak', 'Page break', icons.pageBreak, (e) => e.chain().focus().setPageBreak().run(), { key: 'Mod-Enter' }) : null
  ].filter(Boolean))
  groups.push([
    tool('comment', 'Comment on the selection', icons.comment, () => newComment(), { key: 'Mod-Alt-M' }),
    tool('find', 'Find and replace', icons.search, () => openFind(o, { replace: true }), { key: 'Mod-F' })
  ])
  groups.push([
    tool('undo', 'Undo your last change', icons.undo, (e) => e.chain().focus().undo().run(), { key: 'Mod-Z' }),
    tool('redo', 'Redo', icons.redo, (e) => e.chain().focus().redo().run(), { key: 'Mod-Shift-Z' })
  ])

  const children = []
  groups.forEach((g, i) => { if (i) children.push(sep()); children.push(...g) })
  children.push(el('span', { class: 'tool-spacer' }),
    el('select', {
      class: 'tool-select tool-mode',
      'data-cmd': 'mode',
      'aria-label': 'Editing or suggesting',
      title: 'Suggesting turns your edits into suggestions others can accept or reject',
      onchange: (e) => { o.editor.chain().focus().setSuggesting(e.target.value === 'suggesting').run(); o.refreshMargin() }
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
  setToolbar(children)
  $('[data-action="page-setup"]').hidden = !paged
  syncToolbar()
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

// ---- footnotes, contents, word count, find --------------------------------------------

async function footnoteDialog ({ text, pos }) {
  const e = state.open?.editor
  if (!e) return
  const editing = pos != null
  const input = el('textarea', { name: 'text', rows: '3', placeholder: 'The note’s text' }, text)
  const res = await dialog({
    title: editing ? 'Edit footnote' : 'Add a footnote',
    body: editing ? null : 'The note is numbered where your cursor is, and listed under Notes at the end.',
    fields: [input],
    confirm: editing ? 'Update' : 'Add',
    extraActions: editing ? [{ label: 'Delete', value: 'delete', danger: true }] : [],
    validate: (d) => (d.text.trim() ? null : 'Write the note first.')
  })
  if (res?.action === 'delete') {
    e.chain().focus().command(({ tr }) => { const node = tr.doc.nodeAt(pos); if (node) tr.delete(pos, pos + node.nodeSize); return true }).run()
  } else if (res?.action === 'confirm') {
    const value = res.data.text.trim().slice(0, 2000)
    if (editing) e.chain().focus().setFootnote(pos, value).run()
    else e.chain().focus().insertFootnote(value).run()
  }
}

// Markdown footnotes: [^1] where each note was, and the notes at the end.
function withNotes (markdown, json) {
  const notes = footnotesOf(json)
  if (!notes.length) return markdown
  let n = 0
  const body = markdown.replace(/\[\^cp-note\]/g, () => `[^${++n}]`)
  return `${body.trimEnd()}\n\n${notes.map((x) => `[^${x.n}]: ${x.text.replace(/\n+/g, ' ')}`).join('\n')}\n`
}

// Markdown has no table of contents: write the headings as a list.
function withContents (markdown, json) {
  const text = (n) => (n.text || '') + (n.content || []).map(text).join('')
  const list = (json.content || []).filter((n) => n.type === 'heading').map((n) => `${'  '.repeat((n.attrs?.level || 1) - 1)}- ${text(n).trim()}`).join('\n')
  return markdown.replace(/^\[\[toc\]\]$/gm, list ? `**Contents**\n\n${list}` : '')
}

function wordCountDialog (o) {
  const all = wordCount(o.editor.state)
  const sel = o.editor.state.selection.empty ? null : wordCount(o.editor.state, { selection: true })
  const row = (label, a, b) => [el('dt', {}, label), el('dd', {}, sel ? `${b.toLocaleString()} of ${a.toLocaleString()}` : a.toLocaleString())]
  dialog({
    title: 'Word count',
    body: sel ? 'In the selection, of the whole document.' : null,
    fields: [el('dl', { class: 'details' },
      ...row('Words', all.words, sel?.words),
      ...row('Characters (no spaces)', all.characters, sel?.characters),
      ...row('Paragraphs', all.paragraphs, sel?.paragraphs),
      ...(o.kind === 'paged' ? [el('dt', {}, 'Pages'), el('dd', {}, String(o.pages || 1))] : []))],
    confirm: 'Done',
    cancel: null
  })
}

// The find bar: matches highlight as you type; Enter goes to the next.
function openFind (o, { replace = false } = {}) {
  if (!o.find) {
    const query = el('input', { class: 'find-input', type: 'search', placeholder: 'Find', 'aria-label': 'Find', spellcheck: 'false' })
    const repl = el('input', { class: 'find-input', placeholder: 'Replace with', 'aria-label': 'Replace with', spellcheck: 'false' })
    const caseBox = el('input', { type: 'checkbox', 'aria-label': 'Match case' })
    const count = el('span', { class: 'find-count', 'aria-live': 'polite' })
    const search = () => { o.editor.commands.setSearch(query.value, { caseSensitive: caseBox.checked }); syncFind(o) }
    const next = () => { o.editor.commands.findNext(); syncFind(o) }
    const close = () => { o.editor.commands.setSearch(''); o.find.remove(); o.find = null; o.editor.commands.focus() }
    query.addEventListener('input', search)
    caseBox.addEventListener('change', search)
    query.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.shiftKey ? o.editor.commands.findPrevious() : next(); syncFind(o) } else if (e.key === 'Escape') close() })
    repl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doReplace() } else if (e.key === 'Escape') close() })
    const doReplace = () => { if (o.editor.isEditable) { o.editor.commands.replaceMatch(repl.value); syncFind(o) } }
    const doAll = () => {
      if (!o.editor.isEditable) return
      if (o.editor.commands.replaceAll(repl.value)) toast(`Replaced ${o.editor.storage.search.lastReplaced}`)
      syncFind(o)
    }
    const replaceRow = el('div', { class: 'find-row find-replace' }, repl,
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: doReplace }, 'Replace'),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: doAll }, 'Replace all'))
    o.find = el('div', { class: 'find-bar', role: 'search' },
      el('div', { class: 'find-row' }, query, count,
        el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': 'Previous match', title: 'Previous (Shift+Enter)', onclick: () => { o.editor.commands.findPrevious(); syncFind(o) } }, '↑'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': 'Next match', title: 'Next (Enter)', onclick: next }, '↓'),
        el('label', { class: 'find-case', title: 'Match case' }, caseBox, 'Aa'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': 'Close find', onclick: close }, '×')),
      replaceRow)
    o.find.query = query
    o.find.replaceRow = replaceRow
    o.find.count = count
    $('#desk').parentElement.append(o.find)
  }
  o.find.replaceRow.hidden = !(replace && o.editor.isEditable)
  const { from, to, empty } = o.editor.state.selection
  if (!empty && !o.find.query.value) { o.find.query.value = o.editor.state.doc.textBetween(from, to, ' ').slice(0, 200); o.find.query.dispatchEvent(new Event('input')) }
  o.find.query.focus()
  o.find.query.select()
}

function syncFind (o) {
  if (!o.find) return
  const s = o.editor.storage.search
  o.find.count.textContent = !s.query ? '' : s.matches.length ? `${s.current >= 0 ? s.current + 1 : 0} of ${s.matches.length}` : 'No matches'
  requestAnimationFrame(() => document.querySelector('.cp-found.current')?.scrollIntoView({ block: 'center' }))
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

// ---- page setup -------------------------------------------------------------------

export async function pageSetupDialog () {
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
      el('label', { class: 'field' }, 'Header', el('input', { name: 'header', value: s.header, maxlength: '200', placeholder: 'Nothing at the top' })),
      el('label', { class: 'field' }, 'Footer', el('input', { name: 'footer', value: s.footer, maxlength: '200', placeholder: 'Nothing at the bottom' })),
      el('p', { class: 'fineprint-plain' }, 'Write {page} for the page number, {pages} for how many there are, {title} and {date}. For example: Page {page} of {pages}.')
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
    header: d.header.trim(),
    footer: d.footer.trim()
  })
  o.ydoc.getMap('page').set('setup', next)
}
