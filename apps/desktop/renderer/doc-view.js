// CommonDocs window: markdown and paged documents, their toolbars, links,
// math, tables, images, page setup and export.

import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import katex from 'katex'
import { createDocsEditor, activeFormats, setBlock, pageGeometry, readPage, normalizePage, PAGE_SIZES } from '@commonplace/docs/editor'
import { $, el, svg, toast, openMenu, closeMenu, dialog, selectField, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp, statusNotes, renderNotes } from './state.js'

const FONTS = [
  { label: 'Default', value: '' },
  { label: 'Georgia', value: 'Georgia, serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Palatino', value: '"Palatino Linotype", Palatino, serif' },
  { label: 'Garamond', value: 'Garamond, "EB Garamond", serif' },
  { label: 'Arial', value: 'Arial, Helvetica, sans-serif' },
  { label: 'Calibri', value: 'Calibri, Carlito, sans-serif' },
  { label: 'Verdana', value: 'Verdana, sans-serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' }
]
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60]
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
  $('[data-action="share"]').addEventListener('click', async () => {
    if (!state.open) return
    await cp.copyInvite(state.open.docId)
    toast('Invite link copied. Anyone with it can read and edit.')
  })
  $('[data-action="export"]').addEventListener('click', (e) => exportMenu(e.currentTarget))
  $('[data-action="page-setup"]').addEventListener('click', () => pageSetupDialog())
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

  // Record that this editing session belongs to me (for "written by").
  ydoc.getMap('authors').set(String(ydoc.clientID), { userId: state.me.userId, name: state.me.name })
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
    onUpdate: () => syncToolbar(),
    onEditMath: (m) => mathDialog(m),
    onOpenLink: (href) => cp.openLink(href),
    getPageSetup: () => readPage(ydoc),
    getZoom: () => o.zoom || 1,
    onLayout: ({ pages, geometry }) => { o.pages = pages; drawSheets(pages, geometry); renderDocMargin() }
  })

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
  const showTitle = () => { if (document.activeElement !== title) title.value = meta.get('title') || '' }
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

export async function closeDocument () {
  const o = state.open
  if (!o) return
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
  const g = pageGeometry(readPage(o.ydoc))
  const s = o.paper.style
  s.setProperty('--page-w', `${g.width}px`)
  s.setProperty('--page-h', `${g.height}px`)
  s.setProperty('--m-top', `${g.margins.top}px`)
  s.setProperty('--m-right', `${g.margins.right}px`)
  s.setProperty('--m-bottom', `${g.margins.bottom}px`)
  s.setProperty('--m-left', `${g.margins.left}px`)
  s.setProperty('--page-gap', `${g.gap}px`)
  fitPaper()
}

function fitPaper () {
  const o = state.open
  if (!o?.paper) return false
  const g = pageGeometry(readPage(o.ydoc))
  const room = $('#desk').clientWidth - 64
  const zoom = Math.max(0.5, Math.min(1, room / g.width))
  if (Math.abs(zoom - o.zoom) < 0.005) return false
  o.zoom = zoom
  o.paper.style.zoom = String(zoom)
  return true
}

function drawSheets (pages, g) {
  const o = state.open
  if (!o?.paper) return
  const sheets = o.paper.querySelector('.sheets')
  if (sheets.children.length !== pages || sheets.dataset.geo !== `${g.width}x${g.height}:${g.pageNumbers}`) {
    sheets.dataset.geo = `${g.width}x${g.height}:${g.pageNumbers}`
    sheets.replaceChildren(...Array.from({ length: pages }, (_, i) => el('div', {
      class: 'page-sheet',
      style: `top:${i * (g.height + g.gap)}px`
    }, g.pageNumbers ? el('span', { class: 'page-number', style: `bottom:${Math.max(8, g.margins.bottom / 2 - 8)}px` }, String(i + 1)) : null)))
  }
  o.paper.style.minHeight = `${pages * (g.height + g.gap) - g.gap}px`
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
    onclick: (e) => { if (state.open) run(state.open.editor, e.currentTarget) }
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
      el('select', { class: 'tool-select tool-font', 'data-cmd': 'font', 'aria-label': 'Font', onchange: (e) => { const v = e.target.value; const c = o.editor.chain().focus(); (v ? c.setFontFamily(v) : c.unsetFontFamily()).run() } },
        ...FONTS.map((f) => el('option', { value: f.value }, f.label))),
      el('select', { class: 'tool-select tool-size', 'data-cmd': 'size', 'aria-label': 'Font size', onchange: (e) => { const v = e.target.value; const c = o.editor.chain().focus(); (v ? c.setFontSize(v) : c.unsetFontSize()).run() } },
        el('option', { value: '' }, 'Size'), ...SIZES.map((n) => el('option', { value: `${n}pt` }, String(n)))))
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
    toolButton('undo', 'Undo your last change', icons.undo, (e) => e.chain().focus().undo().run(), { key: 'Mod-Z' }),
    toolButton('redo', 'Redo', icons.redo, (e) => e.chain().focus().redo().run(), { key: 'Mod-Shift-Z' })
  ])

  const children = []
  groups.forEach((g, i) => { if (i) children.push(sep()); children.push(...g) })
  bar.replaceChildren(...children)
  $('[data-action="page-setup"]').hidden = !paged
  syncToolbar()
}

function syncToolbar () {
  const o = state.open
  if (!o) return
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
  const font = $('[data-cmd="font"]')
  if (font && document.activeElement !== font) font.value = FONTS.some((x) => x.value === f.fontFamily) ? f.fontFamily : ''
  const size = $('[data-cmd="size"]')
  if (size && document.activeElement !== size) size.value = /pt$/.test(f.fontSize) && SIZES.includes(parseFloat(f.fontSize)) ? f.fontSize : ''
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
  openMenu(anchor, [
    ['left', 'Align left'], ['center', 'Center'], ['right', 'Align right'], ['justify', 'Justify']
  ].map(([value, label]) => ({ label, icon: ALIGN_ICONS[value], checked: current === value, onSelect: () => e.chain().focus().setTextAlign(value).run() })), { label: 'Alignment' })
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
    const payload = format === 'md' ? { markdown: o.editor.getMarkdown() } : format === 'docx' ? { json: o.editor.getJSON() } : {}
    if (format === 'pdf') document.body.classList.add('printing')
    const saved = await cp.exportFile(o.docId, format, payload)
    if (saved) toast(`Saved ${saved}`)
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

export function renderDocMargin () {
  const o = state.open
  if (!o) return
  const file = state.files.find((f) => f.docId === o.docId)
  const notes = file ? statusNotes(file, { detailed: true }) : []
  if (o.kind === 'paged') notes.unshift({ text: o.pages === 1 ? '1 page' : `${o.pages} pages` })
  $('#doc-margin').replaceChildren(el('div', { class: 'margin-inner' }, ...renderNotes(notes)))
}
