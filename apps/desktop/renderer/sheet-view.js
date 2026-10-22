// commonSheets window: the grid, formula bar, sheet tabs and formatting.
// Everything edits the file's Y.Doc through @commonplace/sheets/model, so
// edits sync like any other file's; this module only draws and listens.

import * as Y from 'yjs'
import {
  readSheet, sheetList, setCell, styleRange, clearRange, insertRows, insertCols, deleteRows, deleteCols,
  setWidth, addSheet, renameSheet, deleteSheet, moveSheet, context, cellAt, SHEETS, SHEET_DATA
} from '@commonplace/sheets/model'
import { shiftFormula, a1, colName } from '@commonplace/sheets/formula'
import { RULES, describeRule } from '@commonplace/sheets/rules'
import { CHARTS } from '@commonplace/sheets/charts'
import { summaryOf, writeSummary, describeSummary } from '@commonplace/sheets/summary'
import { $, el, toast, openMenu, promptText, confirmAction } from './ui.js'
import { icons } from './icons.js'
import { state } from './state.js'
import { toolButton, toolbarGroups, setToolbar, press, swatchMenu, TEXT_COLORS, FILL_COLORS } from './toolbar.js'
import { sortMenu, freezeMenu, filterDialog, hiddenRows, filterNote, formatRulesDialog, checksDialog, pickMenu, summaryDialog, tableRange, usedRange, selRange } from './sheet-tools.js'
import { drawCharts, insertChart } from './sheet-charts.js'

const CLIP_TYPE = 'application/x-commonplace-cells'
const FORMATS = [['', 'Automatic'], ['number', 'Number'], ['percent', 'Percent'], ['currency', 'Currency'], ['date', 'Date'], ['text', 'Plain text']]
const ROW_H = 24

// ---- the view -------------------------------------------------------------------

export function mountSheet (o) {
  const v = createGrid({ ydoc: o.ydoc, awareness: o.awareness, host: $('#desk'), readonly: false, onChange: () => o.refreshMargin() })
  renderToolbar(v)
  v.onSelect = () => syncToolbar(v)
  return {
    focus: () => v.focus(),
    setEditable (writable) { v.setWritable(writable) },
    notes: () => [],
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const host = el('div', { class: 'sheet-preview-host' })
      $('#desk').append(host)
      const past = createGrid({ ydoc, host, readonly: true, sheetId: v.sheetId })
      return { title: ydoc.getMap('meta').get('title') || '', close () { past.destroy(); host.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    comments: sheetComments(v),
    exportPayload: async () => ({ payload: { sheetId: v.sheetId } }),
    exportFormats: { xlsx: 'Excel workbook (.xlsx)', csv: 'CSV, this sheet (.csv)' },
    exportHints: { xlsx: 'Keeps every sheet, formulas and formatting', csv: 'Values only, for other programs' },
    destroy () { v.destroy() }
  }
}

// ---- comments -----------------------------------------------------------------

// Threads are anchored to a cell by its row and column ids, so they stay on
// it when rows or columns are inserted.
function sheetComments (v) {
  const find = (a) => {
    const sheet = a?.kind === 'cell' ? readSheet(v.ydoc, a.sheet) : null
    if (!sheet) return null
    const r = sheet.rows.indexOf(a.row)
    const c = sheet.cols.indexOf(a.col)
    return r < 0 || c < 0 ? null : { sheet, r, c }
  }
  const name = (sheet, r, c) => `cell ${a1(r, c)}${sheetList(v.ydoc).length > 1 ? ` in ${sheet.name}` : ''}`
  return {
    current () {
      const s = v.sheet
      if (!s) return null
      return { anchor: { kind: 'cell', sheet: v.sheetId, row: s.rows[v.sel.r2], col: s.cols[v.sel.c2] }, label: name(s, v.sel.r2, v.sel.c2) }
    },
    label (a) { const f = find(a); return f ? name(f.sheet, f.r, f.c).replace(/^c/, 'C') : null },
    reveal (a) {
      const f = find(a)
      if (!f) return
      if (f.sheet.id !== v.sheetId) switchTo(v, f.sheet.id)
      select(v, f.r, f.c)
    },
    mark (threads) {
      v.commented = new Set(threads.filter((t) => t.anchor?.kind === 'cell').map((t) => `${t.anchor.sheet}:${t.anchor.row}:${t.anchor.col}`))
      drawCommentMarks(v)
    }
  }
}

function drawCommentMarks (v) {
  for (const x of v.commentCells || []) x.classList.remove('has-comment')
  v.commentCells = []
  const s = v.sheet
  if (!s || !v.commented?.size) return
  for (const key of v.commented) {
    const [sheet, row, col] = key.split(':')
    if (sheet !== v.sheetId) continue
    const cell = td(v, s.rows.indexOf(row), s.cols.indexOf(col))
    if (cell && s.rows.includes(row) && s.cols.includes(col)) { cell.classList.add('has-comment'); v.commentCells.push(cell) }
  }
}

// ---- the grid -------------------------------------------------------------------

// Draws one workbook into `host`. readonly: an earlier version.
function createGrid ({ ydoc, awareness = null, host, readonly, sheetId = null, onChange = () => {} }) {
  const v = {
    ydoc,
    awareness,
    readonly,
    writable: !readonly,
    sheetId: sheetId && sheetList(ydoc).some((s) => s.id === sheetId) ? sheetId : sheetList(ydoc)[0]?.id,
    sel: { r: 0, c: 0, r2: 0, c2: 0 },
    editing: null,
    sheet: null,
    shape: '',
    drawn: new Map(), // 'r:c' -> td that currently shows something
    marked: [],
    peers: [],
    filters: new Map(), // yours only: colId -> Set of hidden texts
    hidden: new Set(),
    onSelect: () => {},
    undo: readonly ? null : new Y.UndoManager([ydoc.getArray(SHEETS), ydoc.getMap(SHEET_DATA), ydoc.getMap(RULES), ydoc.getMap(CHARTS)], { trackedOrigins: new Set([null]) })
  }
  v.nameBox = el('input', { class: 'name-box', 'aria-label': 'Selected cell', spellcheck: 'false' })
  v.formula = el('input', { class: 'formula-input', 'aria-label': 'Cell contents', spellcheck: 'false', readonly: readonly || null })
  v.table = el('table', { class: 'grid', role: 'grid' })
  v.editor = el('textarea', { class: 'cell-editor', rows: '1', spellcheck: 'false', 'aria-label': 'Edit cell', hidden: true })
  v.scroll = el('div', { class: 'grid-scroll', tabindex: '0', 'aria-label': 'Spreadsheet' }, v.table, v.editor)
  v.more = el('button', { type: 'button', class: 'btn btn-quiet grid-more', onclick: () => { insertRows(ydoc, v.sheetId, v.sheet.rows.length, 100) } }, 'Add 100 more rows')
  v.tabs = el('div', { class: 'sheet-tabs', role: 'tablist', 'aria-label': 'Sheets' })
  v.notice = el('div', { class: 'sheet-notice', role: 'status', hidden: true })
  v.root = el('div', { class: `sheet-app${readonly ? ' readonly' : ''}` },
    el('div', { class: 'formula-bar' }, v.nameBox, el('span', { class: 'fx', 'aria-hidden': 'true' }, 'fx'), v.formula),
    v.notice, v.scroll, v.tabs)
  host.replaceChildren(v.root)

  v.focus = () => v.scroll.focus({ preventScroll: true })
  v.setWritable = (w) => {
    const next = !readonly && w
    if (next === v.writable) return
    v.writable = next
    v.formula.readOnly = !next
    render(v)
  }

  // Redraw on any change, at most once a frame.
  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); onChange() }) }
  v.refresh = schedule
  const data = ydoc.getMap(SHEET_DATA)
  const order = ydoc.getArray(SHEETS)
  const rules = ydoc.getMap(RULES)
  const charts = ydoc.getMap(CHARTS)
  data.observeDeep(schedule)
  order.observe(schedule)
  rules.observe(schedule)
  charts.observe(schedule)
  window.addEventListener('commonplace:theme', schedule)
  const onAwareness = () => drawPeers(v)
  awareness?.on('change', onAwareness)
  wire(v)
  v.destroy = () => {
    cancelAnimationFrame(frame)
    data.unobserveDeep(schedule)
    order.unobserve(schedule)
    rules.unobserve(schedule)
    charts.unobserve(schedule)
    window.removeEventListener('commonplace:theme', schedule)
    awareness?.off('change', onAwareness)
    v.unwire?.()
    v.undo?.destroy()
  }
  render(v)
  return v
}

const inSel = (s, r, c) => r >= Math.min(s.r, s.r2) && r <= Math.max(s.r, s.r2) && c >= Math.min(s.c, s.c2) && c <= Math.max(s.c, s.c2)
const range = selRange
const td = (v, r, c) => v.table.tBodies[0]?.rows[r]?.cells[c + 1] || null

function render (v) {
  if (!sheetList(v.ydoc).some((s) => s.id === v.sheetId)) { v.sheetId = sheetList(v.ydoc)[0]?.id; v.sel = { r: 0, c: 0, r2: 0, c2: 0 } }
  const sheet = readSheet(v.ydoc, v.sheetId)
  if (!sheet) return
  v.sheet = sheet
  const shape = `${sheet.id}|${sheet.rows.length}|${sheet.cols.length}|${sheet.widths.join(',')}|${sheet.freeze.rows},${sheet.freeze.cols}`
  if (shape !== v.shape) { buildTable(v, sheet); v.shape = shape; v.drawn.clear(); v.hidden = new Set() }
  // Cell contents: everything filled now, and anything that was filled before.
  const now = new Set()
  for (const [r, c] of sheet.filled()) {
    now.add(`${r}:${c}`)
    paintCell(td(v, r, c), sheet.get(r, c))
  }
  // Empty cells that should still show a checkbox or a dropdown.
  for (const { rule, at } of sheet.checks) {
    if (rule.check === 'number') continue
    for (let r = at.r0; r <= at.r1; r++) {
      for (let c = at.c0; c <= at.c1; c++) {
        const key = `${r}:${c}`
        if (now.has(key)) continue
        now.add(key)
        paintCell(td(v, r, c), null, sheet.checkAt(r, c)?.rule)
      }
    }
  }
  for (const [key, cell] of v.drawn) if (!now.has(key)) paintCell(cell, null)
  v.drawn = new Map([...now].map((k) => { const [r, c] = k.split(':').map(Number); return [k, td(v, r, c)] }))
  drawFilter(v)
  v.sel = clampSel(v.sel, sheet)
  drawSelection(v)
  drawTabs(v)
  drawPeers(v)
  drawCommentMarks(v)
  drawNotice(v)
  drawCharts(v)
  v.more.hidden = !v.writable
  if (!v.more.isConnected) v.scroll.append(v.more)
}

function clampSel (s, sheet) {
  const R = sheet.rows.length - 1
  const C = sheet.cols.length - 1
  const k = (n, max) => Math.max(0, Math.min(max, n))
  return { r: k(s.r, R), c: k(s.c, C), r2: k(s.r2, R), c2: k(s.c2, C) }
}

function buildTable (v, sheet) {
  v.chartCache?.clear()
  const colgroup = el('colgroup', {}, el('col', { style: 'width:46px' }), ...sheet.widths.map((w) => el('col', { style: `width:${w}px` })))
  const head = el('tr', {}, el('th', { class: 'corner', 'aria-hidden': 'true' }),
    ...sheet.cols.map((_, c) => el('th', { class: 'col-head', 'data-c': String(c), scope: 'col' }, colName(c), el('span', { class: 'col-resize', 'data-c': String(c), 'aria-hidden': 'true' }))))
  const body = el('tbody')
  const cells = sheet.cols.map(() => '<td></td>').join('')
  body.innerHTML = sheet.rows.map((_, r) => `<tr><th class="row-head" scope="row" data-r="${r}">${r + 1}</th>${cells}</tr>`).join('')
  v.table.replaceChildren(colgroup, el('thead', {}, head), body)
  v.table.style.width = `${46 + sheet.widths.reduce((a, b) => a + b, 0)}px`
  freezePanes(v, sheet)
}

// Frozen rows and columns stick below the column letters and beside the
// row numbers while the rest scrolls under them.
function freezePanes (v, sheet) {
  const { rows: fr, cols: fc } = sheet.freeze
  const lefts = [46]
  for (let c = 0; c < fc; c++) lefts.push(lefts[c] + sheet.widths[c])
  const body = v.table.tBodies[0]
  for (let r = 0; r < fr; r++) {
    const tr = body.rows[r]
    tr.classList.add('frozen-row')
    if (r === fr - 1) tr.classList.add('freeze-edge')
    for (const cell of tr.cells) cell.style.setProperty('--top', `${ROW_H * (r + 1)}px`)
  }
  for (let c = 0; c < fc; c++) {
    const head = v.table.tHead.rows[0].cells[c + 1]
    head.classList.add('frozen-col')
    head.style.setProperty('--left', `${lefts[c]}px`)
    for (const tr of body.rows) {
      const cell = tr.cells[c + 1]
      cell.classList.add('frozen-col')
      if (c === fc - 1) cell.classList.add('freeze-edge')
      cell.style.setProperty('--left', `${lefts[c]}px`)
    }
    if (c === fc - 1) head.classList.add('freeze-edge')
  }
}

// check: the validation rule on the cell, for empty cells (filled cells carry theirs).
function paintCell (cell, data, check = data?.check) {
  if (!cell) return
  const box = check?.check === 'checkbox'
  const text = box ? '' : data?.text ?? ''
  if (cell.textContent !== text) cell.textContent = text
  const s = data?.look || {}
  const kind = typeof data?.value
  const st = cell.style
  st.textAlign = s.al || (data?.value?.code ? 'center' : kind === 'number' ? 'right' : kind === 'boolean' || box ? 'center' : 'left')
  st.fontWeight = s.b ? '600' : ''
  st.fontStyle = s.i ? 'italic' : ''
  st.textDecoration = s.u ? 'underline' : ''
  st.color = s.fg || ''
  st.backgroundColor = s.bg || ''
  cell.classList.toggle('err', Boolean(data?.value?.code))
  cell.classList.toggle('checkbox', box)
  cell.classList.toggle('checked', box && data?.value === true)
  cell.classList.toggle('dropdown', check?.check === 'list')
  cell.classList.toggle('invalid', Boolean(data?.invalid))
  const tip = data?.invalid ? `Not allowed here: ${describeRule(check)}` : ''
  if (cell.title !== tip) cell.title = tip
}

// Rows your filter hides, and the mark on filtered column letters.
function drawFilter (v) {
  const next = hiddenRows(v)
  const body = v.table.tBodies[0]
  for (const r of v.hidden) if (!next.has(r) && body.rows[r]) body.rows[r].hidden = false
  for (const r of next) if (body.rows[r]) body.rows[r].hidden = true
  v.hidden = next
  const heads = v.table.tHead?.rows[0].cells
  if (heads) for (let c = 0; c < v.sheet.cols.length; c++) heads[c + 1]?.classList.toggle('filtered', v.filters.has(v.sheet.cols[c]))
}

// The line above the grid: your filter, or what a summary sheet comes from.
function drawNotice (v) {
  const filter = filterNote(v, v.hidden)
  const summary = summaryOf(v.ydoc, v.sheetId)
  const key = `${filter}|${summary ? describeSummary(v.ydoc, v.sheetId) : ''}|${v.writable}`
  if (v.notice.dataset.key === key) return
  v.notice.dataset.key = key
  const parts = []
  if (summary) {
    parts.push(el('span', {}, describeSummary(v.ydoc, v.sheetId)))
    if (v.writable) parts.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { if (!writeSummary(v.ydoc, v.sheetId)) toast('The cells this summary came from are gone.') } }, 'Update groups'))
  }
  if (filter) {
    parts.push(el('span', {}, filter))
    parts.push(el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: () => { v.filters.clear(); v.refresh() } }, 'Show all rows'))
  }
  v.notice.replaceChildren(...parts)
  v.notice.hidden = !parts.length
}

function drawSelection (v) {
  for (const x of v.marked) x.classList.remove('sel', 'focus', 'head-sel')
  v.marked = []
  const { r0, c0, r1, c1 } = range(v.sel)
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const cell = td(v, r, c)
      if (!cell) continue
      cell.classList.add('sel')
      v.marked.push(cell)
    }
    const rh = v.table.tBodies[0]?.rows[r]?.cells[0]
    if (rh) { rh.classList.add('head-sel'); v.marked.push(rh) }
  }
  for (let c = c0; c <= c1; c++) {
    const ch = v.table.tHead?.rows[0].cells[c + 1]
    if (ch) { ch.classList.add('head-sel'); v.marked.push(ch) }
  }
  const focus = td(v, v.sel.r2, v.sel.c2)
  focus?.classList.add('focus')
  v.nameBox.value = r0 === r1 && c0 === c1 ? a1(v.sel.r2, v.sel.c2) : `${a1(r0, c0)}:${a1(r1, c1)}`
  if (document.activeElement !== v.formula) v.formula.value = v.sheet?.get(v.sel.r2, v.sel.c2)?.input ?? ''
  if (v.awareness && v.sheet) {
    v.awareness.setLocalStateField('sheet', { sheet: v.sheetId, row: v.sheet.rows[v.sel.r2], col: v.sheet.cols[v.sel.c2] })
  }
  v.onSelect()
}

// Other people's selected cells, in their color.
function drawPeers (v) {
  if (!v.awareness || !v.sheet) return
  for (const x of v.peers) { x.classList.remove('peer'); x.style.removeProperty('--peer'); x.removeAttribute('data-peer') }
  v.peers = []
  for (const [clientId, s] of v.awareness.getStates()) {
    if (clientId === v.ydoc.clientID || !s.sheet || s.sheet.sheet !== v.sheetId || !s.user || s.user.userId === state.me?.userId) continue
    const cell = td(v, v.sheet.rows.indexOf(s.sheet.row), v.sheet.cols.indexOf(s.sheet.col))
    if (!cell) continue
    cell.classList.add('peer')
    cell.style.setProperty('--peer', s.user.color)
    cell.setAttribute('data-peer', s.user.name)
    v.peers.push(cell)
  }
}

function drawTabs (v) {
  const sheets = sheetList(v.ydoc)
  const key = sheets.map((s) => `${s.id}=${s.name}`).join('|') + `#${v.sheetId}#${v.writable}`
  if (v.tabs.dataset.key === key) return
  v.tabs.dataset.key = key
  v.tabs.replaceChildren(...sheets.map((s, i) => el('button', {
    type: 'button',
    class: 'sheet-tab',
    role: 'tab',
    'aria-selected': String(s.id === v.sheetId),
    onclick: () => switchTo(v, s.id),
    ondblclick: () => v.writable && renameTab(v, s),
    oncontextmenu: (e) => { e.preventDefault(); if (v.writable) tabMenu(v, e.currentTarget, s, i, sheets.length) }
  }, s.name)), v.writable ? el('button', { type: 'button', class: 'sheet-tab add', 'aria-label': 'Add a sheet', title: 'Add a sheet', onclick: () => switchTo(v, addSheet(v.ydoc, {})) }, '+') : null)
}

function switchTo (v, id) {
  commitEdit(v)
  v.sheetId = id
  v.sel = { r: 0, c: 0, r2: 0, c2: 0 }
  v.shape = ''
  render(v)
  v.focus()
}

async function renameTab (v, s) {
  const name = await promptText({ title: 'Rename sheet', label: 'Name', value: s.name, confirm: 'Rename' })
  if (name) renameSheet(v.ydoc, s.id, name)
}

function tabMenu (v, anchor, s, i, count) {
  openMenu(anchor, [
    { label: 'Rename…', onSelect: () => renameTab(v, s) },
    { label: 'Move left', disabled: i === 0, onSelect: () => moveSheet(v.ydoc, s.id, i - 1) },
    { label: 'Move right', disabled: i === count - 1, onSelect: () => moveSheet(v.ydoc, s.id, i + 1) },
    { sep: true },
    {
      label: 'Delete sheet…',
      danger: true,
      disabled: count <= 1,
      onSelect: async () => {
        if (await confirmAction({ title: `Delete “${s.name}”?`, body: 'Formulas on other sheets that use it will show #REF!. You can bring it back from the version history.', confirm: 'Delete sheet' })) deleteSheet(v.ydoc, s.id)
      }
    }
  ], { label: s.name })
}

// ---- moving and selecting ------------------------------------------------------------

function select (v, r, c, extend = false, dr = 0) {
  const s = v.sheet
  r = Math.max(0, Math.min(s.rows.length - 1, r))
  // Moving up or down steps over rows your filter hides.
  const inside = (n) => n >= 0 && n < s.rows.length
  if (dr) while (v.hidden.has(r) && inside(r + dr)) r += dr
  c = Math.max(0, Math.min(s.cols.length - 1, c))
  v.sel = extend ? { ...v.sel, r2: r, c2: c } : { r, c, r2: r, c2: c }
  drawSelection(v)
  td(v, r, c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

// ---- editing --------------------------------------------------------------------------

function startEdit (v, initial = null) {
  if (!v.writable) return
  const { r2: r, c2: c } = v.sel
  const cell = td(v, r, c)
  if (!cell) return
  const current = v.sheet.get(r, c)?.input ?? ''
  v.editing = { r, c, original: current }
  const box = cell.getBoundingClientRect()
  const outer = v.scroll.getBoundingClientRect()
  Object.assign(v.editor.style, {
    left: `${box.left - outer.left + v.scroll.scrollLeft}px`,
    top: `${box.top - outer.top + v.scroll.scrollTop}px`,
    minWidth: `${box.width}px`,
    height: `${box.height}px`
  })
  v.editor.value = initial ?? current
  v.editor.hidden = false
  v.editor.focus()
  v.editor.setSelectionRange(v.editor.value.length, v.editor.value.length)
  v.formula.value = v.editor.value
}

function commitEdit (v, move = null) {
  const e = v.editing
  if (!e) return
  v.editing = null
  const value = v.editor.value
  v.editor.hidden = true
  if (value !== e.original) setCell(v.ydoc, v.sheetId, e.r, e.c, value, context(v.ydoc, v.sheetId))
  if (move) select(v, e.r + move[0], e.c + move[1], false, move[0])
  v.focus()
}

function cancelEdit (v) {
  if (!v.editing) return
  v.editing = null
  v.editor.hidden = true
  drawSelection(v)
  v.focus()
}

// While typing a formula, clicking a cell puts its reference in.
function pointingAt (v) {
  const box = document.activeElement === v.formula ? v.formula : v.editing ? v.editor : null
  return box && box.value.startsWith('=') && /[=(,+\-*/^&<>:]\s*$/.test(box.value.slice(0, box.selectionStart)) ? box : null
}

function insertRef (box, ref) {
  const at = box.selectionStart
  box.value = box.value.slice(0, at) + ref + box.value.slice(box.selectionEnd)
  box.setSelectionRange(at + ref.length, at + ref.length)
  box.focus()
}

// ---- clipboard ------------------------------------------------------------------------

function copyRange (v, e, cut) {
  const { r0, c0, r1, c1 } = range(v.sel)
  const rows = []
  const inputs = []
  for (let r = r0; r <= r1; r++) {
    const texts = []
    const raw = []
    for (let c = c0; c <= c1; c++) {
      const cell = v.sheet.get(r, c)
      texts.push(cell?.text ?? '')
      raw.push({ input: cell?.input ?? '', style: cell?.style || null })
    }
    rows.push(texts.join('\t'))
    inputs.push(raw)
  }
  e.clipboardData.setData('text/plain', rows.join('\n'))
  e.clipboardData.setData(CLIP_TYPE, JSON.stringify({ r0, c0, inputs }))
  e.preventDefault()
  if (cut && v.writable) clearRange(v.ydoc, v.sheetId, { r0, c0, r1, c1 })
}

function pasteRange (v, e) {
  if (!v.writable) return
  e.preventDefault()
  const { r0, c0 } = range(v.sel)
  const ctx = context(v.ydoc, v.sheetId)
  let grid
  const internal = e.clipboardData.getData(CLIP_TYPE)
  if (internal) {
    const clip = JSON.parse(internal)
    // Formulas move with the paste, as they would in any spreadsheet.
    grid = clip.inputs.map((row) => row.map((x) => ({ ...x, input: shiftFormula(x.input, r0 - clip.r0, c0 - clip.c0) })))
  } else {
    const text = e.clipboardData.getData('text/plain').replace(/\r\n/g, '\n').replace(/\n$/, '')
    grid = text.split('\n').map((line) => line.split('\t').map((input) => ({ input, style: null })))
  }
  const need = r0 + grid.length - v.sheet.rows.length
  v.ydoc.transact(() => {
    if (need > 0) insertRows(v.ydoc, v.sheetId, v.sheet.rows.length, need)
    const fresh = need > 0 ? context(v.ydoc, v.sheetId) : ctx
    grid.forEach((row, i) => row.forEach((x, j) => {
      if (c0 + j >= fresh.sheets.find((s) => s.id === v.sheetId).cols.length) return
      setCell(v.ydoc, v.sheetId, r0 + i, c0 + j, x.input, fresh)
      if (x.style) styleRange(v.ydoc, v.sheetId, { r0: r0 + i, c0: c0 + j, r1: r0 + i, c1: c0 + j }, x.style)
    }))
  })
  v.sel = { r: r0, c: c0, r2: r0 + grid.length - 1, c2: c0 + (grid[0]?.length || 1) - 1 }
}

// ---- events -----------------------------------------------------------------------------

function wire (v) {
  const { scroll, table, editor, formula } = v
  let dragging = false

  table.addEventListener('mousedown', (e) => {
    const cell = e.target.closest('td')
    const colHead = e.target.closest('.col-head')
    const rowHead = e.target.closest('.row-head')
    if (e.target.classList.contains('col-resize')) { startResize(v, e, Number(e.target.dataset.c)); return }
    if (e.button !== 0) return
    if (cell) {
      const r = cell.parentElement.rowIndex - 1
      const c = cell.cellIndex - 1
      const box = pointingAt(v)
      if (box) { e.preventDefault(); insertRef(box, a1(r, c)); return }
      commitEdit(v)
      select(v, r, c, e.shiftKey)
      e.preventDefault()
      v.focus()
      if (!e.shiftKey && v.writable && cell.classList.contains('checkbox')) { toggleCheck(v, r, c); return }
      if (!e.shiftKey && cell.classList.contains('dropdown') && e.clientX > cell.getBoundingClientRect().right - 20) { openPick(v, r, c); return }
      dragging = true
    } else if (colHead) {
      commitEdit(v)
      const c = Number(colHead.dataset.c)
      v.sel = e.shiftKey ? { ...v.sel, r: 0, r2: v.sheet.rows.length - 1, c2: c } : { r: 0, c, r2: v.sheet.rows.length - 1, c2: c }
      drawSelection(v)
      v.focus()
    } else if (rowHead) {
      commitEdit(v)
      const r = Number(rowHead.dataset.r)
      v.sel = e.shiftKey ? { ...v.sel, c: 0, c2: v.sheet.cols.length - 1, r2: r } : { r, c: 0, r2: r, c2: v.sheet.cols.length - 1 }
      drawSelection(v)
      v.focus()
    }
  })
  table.addEventListener('mouseover', (e) => {
    if (!dragging) return
    const cell = e.target.closest('td')
    if (cell) select(v, cell.parentElement.rowIndex - 1, cell.cellIndex - 1, true)
  })
  const stopDrag = () => { dragging = false }
  window.addEventListener('mouseup', stopDrag)
  table.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('td')
    if (!cell || cell.classList.contains('checkbox')) return
    if (cell.classList.contains('dropdown')) openPick(v, v.sel.r2, v.sel.c2)
    else startEdit(v)
  })
  table.addEventListener('contextmenu', (e) => {
    const target = e.target.closest('td, .col-head, .row-head')
    if (!target || !v.writable) return
    e.preventDefault()
    if (target.tagName === 'TD' && !inSel(v.sel, target.parentElement.rowIndex - 1, target.cellIndex - 1)) select(v, target.parentElement.rowIndex - 1, target.cellIndex - 1)
    linesMenu(v, target)
  })

  scroll.addEventListener('keydown', (e) => {
    if (e.target !== scroll) return
    const mod = e.metaKey || e.ctrlKey
    const { r2, c2 } = v.sel
    const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }
    if (moves[e.key]) {
      e.preventDefault()
      const [dr, dc] = moves[e.key]
      if (mod) select(v, dr ? (dr < 0 ? 0 : v.sheet.rows.length - 1) : r2, dc ? (dc < 0 ? 0 : v.sheet.cols.length - 1) : c2, e.shiftKey)
      else if (e.altKey && dr > 0 && v.sheet.checkAt(r2, c2)?.rule.check === 'list') openPick(v, r2, c2)
      else select(v, r2 + dr, c2 + dc, e.shiftKey, dr)
    } else if (e.key === 'Tab') { e.preventDefault(); select(v, r2, c2 + (e.shiftKey ? -1 : 1)) } else if (e.key === ' ' && v.writable && td(v, r2, c2)?.classList.contains('checkbox')) { e.preventDefault(); toggleCheck(v, r2, c2) } else if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); startEdit(v) } else if ((e.key === 'Delete' || e.key === 'Backspace') && v.writable) { e.preventDefault(); clearRange(v.ydoc, v.sheetId, range(v.sel)) } else if (mod && e.key.toLowerCase() === 'z' && v.undo) { e.preventDefault(); e.shiftKey ? v.undo.redo() : v.undo.undo() } else if (mod && e.key.toLowerCase() === 'y' && v.undo) { e.preventDefault(); v.undo.redo() } else if (mod && ['b', 'i', 'u'].includes(e.key.toLowerCase()) && v.writable) { e.preventDefault(); toggleStyle(v, e.key.toLowerCase()) } else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); v.sel = { r: 0, c: 0, r2: v.sheet.rows.length - 1, c2: v.sheet.cols.length - 1 }; drawSelection(v) } else if (e.key.length === 1 && !mod && !e.altKey && v.writable) { e.preventDefault(); startEdit(v, e.key) }
  })

  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) { e.preventDefault(); commitEdit(v, [1, 0]) } else if (e.key === 'Tab') { e.preventDefault(); commitEdit(v, [0, e.shiftKey ? -1 : 1]) } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(v) }
  })
  editor.addEventListener('input', () => { formula.value = editor.value; editor.style.height = 'auto'; editor.style.height = `${Math.max(ROW_H, editor.scrollHeight)}px` })
  editor.addEventListener('blur', () => { setTimeout(() => { if (v.editing && document.activeElement !== editor && document.activeElement !== formula) commitEdit(v) }, 0) })

  // The formula bar edits the selected cell too.
  formula.addEventListener('focus', () => { if (v.writable && !v.editing) v.editing = { r: v.sel.r2, c: v.sel.c2, original: formula.value, inBar: true } })
  formula.addEventListener('input', () => { if (!v.editor.hidden) v.editor.value = formula.value })
  formula.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); v.editor.value = formula.value; commitEdit(v, [1, 0]) } else if (e.key === 'Escape') { e.preventDefault(); cancelEdit(v) }
  })
  formula.addEventListener('blur', () => { setTimeout(() => { if (v.editing?.inBar && document.activeElement !== formula) { v.editor.value = formula.value; commitEdit(v) } }, 0) })

  // Go to a cell by typing its name (B12, or A1:C4).
  v.nameBox.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const [a, b] = v.nameBox.value.toUpperCase().split(':').map((x) => /^([A-Z]{1,3})(\d+)$/.exec(x.trim()))
    if (!a) { drawSelection(v); return }
    const pos = (m) => ({ r: Number(m[2]) - 1, c: [...m[1]].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 })
    const p = pos(a)
    const q = b ? pos(b) : p
    v.sel = clampSel({ r: p.r, c: p.c, r2: q.r, c2: q.c }, v.sheet)
    drawSelection(v)
    v.focus()
  })

  const onCopy = (e) => { if (document.activeElement === scroll) copyRange(v, e, false) }
  const onCut = (e) => { if (document.activeElement === scroll) copyRange(v, e, true) }
  const onPaste = (e) => { if (document.activeElement === scroll) pasteRange(v, e) }
  document.addEventListener('copy', onCopy)
  document.addEventListener('cut', onCut)
  document.addEventListener('paste', onPaste)
  v.unwire = () => {
    window.removeEventListener('mouseup', stopDrag)
    document.removeEventListener('copy', onCopy)
    document.removeEventListener('cut', onCut)
    document.removeEventListener('paste', onPaste)
  }
}

function toggleCheck (v, r, c) {
  setCell(v.ydoc, v.sheetId, r, c, v.sheet.get(r, c)?.value === true ? 'FALSE' : 'TRUE')
}

function openPick (v, r, c) {
  const rule = v.sheet.checkAt(r, c)?.rule
  const cell = td(v, r, c)
  if (!rule || !cell) return
  if (!v.writable) return
  pickMenu(v, cell, r, c, rule, (value) => { setCell(v.ydoc, v.sheetId, r, c, value); v.focus() })
}

function startResize (v, e, c) {
  if (!v.writable) return
  e.preventDefault()
  const col = v.table.querySelector('colgroup').children[c + 1]
  const start = e.clientX
  const width = v.sheet.widths[c]
  const move = (ev) => { col.style.width = `${Math.max(32, width + ev.clientX - start)}px` }
  const up = (ev) => {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    setWidth(v.ydoc, v.sheetId, c, width + ev.clientX - start)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function linesMenu (v, anchor) {
  const { r0, c0, r1, c1 } = range(v.sel)
  const nr = r1 - r0 + 1
  const nc = c1 - c0 + 1
  const rows = nr === 1 ? 'row' : `${nr} rows`
  const cols = nc === 1 ? 'column' : `${nc} columns`
  openMenu(anchor, [
    { label: `Insert ${rows} above`, onSelect: () => insertRows(v.ydoc, v.sheetId, r0, nr) },
    { label: `Insert ${rows} below`, onSelect: () => insertRows(v.ydoc, v.sheetId, r1 + 1, nr) },
    { label: `Insert ${cols} left`, onSelect: () => insertCols(v.ydoc, v.sheetId, c0, nc) },
    { label: `Insert ${cols} right`, onSelect: () => insertCols(v.ydoc, v.sheetId, c1 + 1, nc) },
    { sep: true },
    { label: `Delete ${rows}`, danger: true, disabled: nr >= v.sheet.rows.length, onSelect: () => deleteRows(v.ydoc, v.sheetId, r0, nr) },
    { label: `Delete ${cols}`, danger: true, disabled: nc >= v.sheet.cols.length, onSelect: () => deleteCols(v.ydoc, v.sheetId, c0, nc) },
    { sep: true },
    { label: 'Clear contents', onSelect: () => clearRange(v.ydoc, v.sheetId, range(v.sel)) }
  ], { label: 'Rows and columns' })
}

// ---- formatting -----------------------------------------------------------------------

const focusStyle = (v) => cellAt(v.ydoc, v.sheetId, v.sel.r2, v.sel.c2)?.s || {}

function toggleStyle (v, key) {
  styleRange(v.ydoc, v.sheetId, range(v.sel), { [key]: !focusStyle(v)[key] })
}

function renderToolbar (v) {
  // Back to the grid afterwards, except for buttons that open a menu.
  const tool = (id, label, icon, run, { menu = false, ...opts } = {}) => toolButton(id, label, icon, (b) => { run(b); if (!menu) v.focus() }, opts)
  const style = (patch) => styleRange(v.ydoc, v.sheetId, range(v.sel), patch)
  const format = el('select', {
    class: 'tool-select',
    'data-cmd': 'format',
    'aria-label': 'Number format',
    onchange: (e) => { style({ nf: e.target.value || null }); v.focus() }
  }, ...FORMATS.map(([value, label]) => el('option', { value }, label)))
  const decimals = (d) => () => {
    const s = focusStyle(v)
    const value = v.sheet.get(v.sel.r2, v.sel.c2)?.value
    const current = s.dp ?? (s.nf === 'percent' ? 0 : s.nf ? 2 : (typeof value === 'number' ? (String(value).split('.')[1] || '').length : 0))
    style({ dp: Math.max(0, Math.min(10, current + d)), nf: s.nf || 'number' })
  }
  setToolbar([...toolbarGroups([
    [
      tool('undo', 'Undo', icons.undo, () => v.undo.undo(), { key: 'Mod-Z' }),
      tool('redo', 'Redo', icons.redo, () => v.undo.redo(), { key: 'Mod-Shift-Z' })
    ],
    [
      tool('bold', 'Bold', el('b', {}, 'B'), () => toggleStyle(v, 'b'), { key: 'Mod-B' }),
      tool('italic', 'Italic', el('i', {}, 'I'), () => toggleStyle(v, 'i'), { key: 'Mod-I' }),
      tool('underline', 'Underline', el('u', {}, 'U'), () => toggleStyle(v, 'u'), { key: 'Mod-U' }),
      tool('color', 'Text color', icons.color, (b) => swatchMenu(b, 'Text color', TEXT_COLORS, (c) => style({ fg: c }), () => style({ fg: null }), 'Default color'), { menu: true }),
      tool('fill', 'Fill color', icons.highlight, (b) => swatchMenu(b, 'Fill color', FILL_COLORS, (c) => style({ bg: c }), () => style({ bg: null }), 'No fill'), { menu: true })
    ],
    [
      tool('alignLeft', 'Align left', icons.alignLeft, () => style({ al: 'left' })),
      tool('alignCenter', 'Center', icons.alignCenter, () => style({ al: 'center' })),
      tool('alignRight', 'Align right', icons.alignRight, () => style({ al: 'right' }))
    ],
    [
      format,
      tool('fewer', 'Fewer decimal places', el('span', { class: 'tool-text' }, '.0'), decimals(-1)),
      tool('more', 'More decimal places', el('span', { class: 'tool-text' }, '.00'), decimals(1))
    ],
    [
      tool('lines', 'Insert or delete rows and columns', icons.table, (b) => linesMenu(v, b), { menu: true }),
      tool('sum', 'Sum the selected cells', el('span', { class: 'tool-text' }, 'Σ'), () => autoSum(v))
    ],
    [
      tool('sort', 'Sort', icons.sort, (b) => sortMenu(v, b), { menu: true }),
      tool('filter', 'Filter this column (only you see it)', icons.filter, () => filterDialog(v), { menu: true }),
      tool('freeze', 'Freeze rows and columns', icons.freeze, (b) => freezeMenu(v, b), { menu: true })
    ],
    [
      tool('rules', 'Conditional formatting', icons.condition, () => formatRulesDialog(v), { menu: true }),
      tool('checks', 'Dropdown, checkbox or allowed numbers', icons.dropdown, () => checksDialog(v), { menu: true })
    ],
    [
      tool('chart', 'Insert a chart', icons.chart, () => insertChart(v, chartRange(v), usedRange(v.sheet))),
      tool('summary', 'Summarize by group (pivot table)', icons.summary, () => summaryDialog(v, (id) => switchTo(v, id)), { menu: true })
    ]
  ])])
  syncToolbar(v)
}

// The cells a new chart draws: the selection, or all the data on the sheet.
function chartRange (v) {
  const sel = selRange(v.sel)
  return sel.r0 !== sel.r1 || sel.c0 !== sel.c1 ? sel : tableRange(v.sheet)
}

// Puts =SUM(...) of the selection in the cell just below it.
function autoSum (v) {
  const { r0, c0, r1, c1 } = range(v.sel)
  if (r0 === r1 && c0 === c1) { toast('Select the cells to add up, then choose Σ.'); return }
  const target = r1 + 1
  if (target >= v.sheet.rows.length) insertRows(v.ydoc, v.sheetId, v.sheet.rows.length, 1)
  for (let c = c0; c <= c1; c++) setCell(v.ydoc, v.sheetId, target, c, `=SUM(${a1(r0, c)}:${a1(r1, c)})`)
}

function syncToolbar (v) {
  if (!v.sheet) return
  const s = focusStyle(v)
  press('bold', s.b)
  press('italic', s.i)
  press('underline', s.u)
  press('alignLeft', s.al === 'left')
  press('alignCenter', s.al === 'center')
  press('alignRight', s.al === 'right')
  const format = document.querySelector('[data-cmd="format"]')
  if (format && document.activeElement !== format) format.value = s.nf || ''
}
