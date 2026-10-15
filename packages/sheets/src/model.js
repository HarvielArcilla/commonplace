// commonSheets data model, on top of the file's Y.Doc. No DOM code: the
// background process uses it for previews, conflicts and import/export.
//
//   ydoc.getArray('sheets')     sheet ids, in tab order
//   ydoc.getMap('sheetData')    sheetId -> Y.Map {
//                                 name:   string
//                                 rows:   Y.Array of row ids
//                                 cols:   Y.Array of column ids
//                                 cells:  Y.Map  'rowId:colId' -> { v, s? }
//                                 widths: Y.Map  colId -> pixels
//                               }
//
// A cell's v is what was typed (formulas in storage form, see formula.js);
// s is its style: { b, i, u, al, nf, dp, fg, bg }. Rows and columns are
// addressed by id, so inserting a row on one computer while someone edits
// a cell further down on another lands both edits in the right place.

import * as Y from 'yjs'
import { evaluator, toStored, toDisplay, literal, isError, formatGeneral, dateFromSerial, colName } from './formula.js'

export const SHEETS = 'sheets'
export const SHEET_DATA = 'sheetData'
export const DEFAULT_ROWS = 100
export const DEFAULT_COLS = 26
export const DEFAULT_WIDTH = 100

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)
const ids = (n) => Array.from({ length: n }, newId)

export function initSheets (ydoc, { rows = DEFAULT_ROWS, cols = DEFAULT_COLS, name = 'Sheet 1' } = {}) {
  ydoc.transact(() => { addSheet(ydoc, { name, rows, cols }) })
}

export function addSheet (ydoc, { name, rows = DEFAULT_ROWS, cols = DEFAULT_COLS, at } = {}) {
  const id = newId()
  const sheet = new Y.Map()
  ydoc.transact(() => {
    ydoc.getMap(SHEET_DATA).set(id, sheet)
    sheet.set('name', name || nextSheetName(ydoc))
    const r = new Y.Array()
    const c = new Y.Array()
    sheet.set('rows', r)
    sheet.set('cols', c)
    sheet.set('cells', new Y.Map())
    sheet.set('widths', new Y.Map())
    r.push(ids(rows))
    c.push(ids(cols))
    const order = ydoc.getArray(SHEETS)
    order.insert(at == null ? order.length : Math.min(at, order.length), [id])
  })
  return id
}

function nextSheetName (ydoc) {
  const names = new Set(sheetList(ydoc).map((s) => s.name))
  for (let i = names.size + 1; ; i++) if (!names.has(`Sheet ${i}`)) return `Sheet ${i}`
}

// Sheets in tab order, each with its current row and column ids.
export function sheetList (ydoc) {
  const data = ydoc.getMap(SHEET_DATA)
  const seen = new Set()
  const out = []
  for (const id of ydoc.getArray(SHEETS).toArray()) {
    const m = data.get(id)
    if (!m || seen.has(id)) continue // two people added the same sheet back
    seen.add(id)
    out.push({ id, name: m.get('name') || 'Sheet', rows: m.get('rows').toArray(), cols: m.get('cols').toArray() })
  }
  return out
}

export const sheetMap = (ydoc, id) => ydoc.getMap(SHEET_DATA).get(id) || null

export function renameSheet (ydoc, id, name) {
  const clean = String(name || '').trim().slice(0, 80)
  if (clean) sheetMap(ydoc, id)?.set('name', clean)
}

export function deleteSheet (ydoc, id) {
  const order = ydoc.getArray(SHEETS)
  if (sheetList(ydoc).length <= 1) return false
  ydoc.transact(() => {
    for (let i = order.length - 1; i >= 0; i--) if (order.get(i) === id) order.delete(i, 1)
    ydoc.getMap(SHEET_DATA).delete(id)
  })
  return true
}

export function moveSheet (ydoc, id, to) {
  const order = ydoc.getArray(SHEETS)
  const from = order.toArray().indexOf(id)
  if (from < 0 || from === to) return
  ydoc.transact(() => { order.delete(from, 1); order.insert(Math.min(to, order.length), [id]) })
}

// ---- cells ----------------------------------------------------------------------

export const cellKey = (rowId, colId) => `${rowId}:${colId}`

export function context (ydoc, sheetId) {
  return { sheetId, sheets: sheetList(ydoc) }
}

// The stored cell at a position, or null.
export function cellAt (ydoc, sheetId, r, c) {
  const m = sheetMap(ydoc, sheetId)
  if (!m) return null
  const row = m.get('rows').get(r)
  const col = m.get('cols').get(c)
  return row && col ? m.get('cells').get(cellKey(row, col)) || null : null
}

// Sets what a cell holds from what someone typed (A1 formulas allowed).
// Empty input with no style removes the cell.
export function setCell (ydoc, sheetId, r, c, input, ctx = context(ydoc, sheetId)) {
  const m = sheetMap(ydoc, sheetId)
  const row = m?.get('rows').get(r)
  const col = m?.get('cols').get(c)
  if (!row || !col) return
  const key = cellKey(row, col)
  const cur = m.get('cells').get(key)
  const v = toStored(String(input ?? ''), ctx)
  if (!v && !cur?.s) m.get('cells').delete(key)
  else m.get('cells').set(key, cur?.s ? { v, s: cur.s } : { v })
}

// Applies a style change to every cell in a rectangle.
export function styleRange (ydoc, sheetId, { r0, c0, r1, c1 }, patch) {
  const m = sheetMap(ydoc, sheetId)
  if (!m) return
  const rows = m.get('rows').toArray()
  const cols = m.get('cols').toArray()
  const cells = m.get('cells')
  ydoc.transact(() => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (!rows[r] || !cols[c]) continue
        const key = cellKey(rows[r], cols[c])
        const cur = cells.get(key) || { v: '' }
        const s = { ...(cur.s || {}), ...patch }
        for (const k of Object.keys(s)) if (s[k] == null || s[k] === false) delete s[k]
        if (!cur.v && !Object.keys(s).length) cells.delete(key)
        else cells.set(key, Object.keys(s).length ? { v: cur.v, s } : { v: cur.v })
      }
    }
  })
}

export function clearRange (ydoc, sheetId, { r0, c0, r1, c1 }) {
  const m = sheetMap(ydoc, sheetId)
  if (!m) return
  const rows = m.get('rows').toArray()
  const cols = m.get('cols').toArray()
  const cells = m.get('cells')
  ydoc.transact(() => {
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = rows[r] && cols[c] && cellKey(rows[r], cols[c])
        const cur = key && cells.get(key)
        if (!cur) continue
        if (cur.s) cells.set(key, { v: '', s: cur.s })
        else cells.delete(key)
      }
    }
  })
}

export function insertRows (ydoc, sheetId, at, n = 1) { sheetMap(ydoc, sheetId)?.get('rows').insert(at, ids(n)) }
export function insertCols (ydoc, sheetId, at, n = 1) { sheetMap(ydoc, sheetId)?.get('cols').insert(at, ids(n)) }

// Deleting rows or columns removes their cells too. Formulas that pointed
// at them show #REF!.
export function deleteRows (ydoc, sheetId, at, n = 1) { deleteLine(ydoc, sheetId, 'rows', at, n) }
export function deleteCols (ydoc, sheetId, at, n = 1) { deleteLine(ydoc, sheetId, 'cols', at, n) }

function deleteLine (ydoc, sheetId, kind, at, n) {
  const m = sheetMap(ydoc, sheetId)
  if (!m) return
  const line = m.get(kind)
  const gone = new Set(line.toArray().slice(at, at + n))
  ydoc.transact(() => {
    line.delete(at, Math.min(n, line.length - at))
    const cells = m.get('cells')
    for (const key of [...cells.keys()]) {
      const [row, col] = key.split(':')
      if (gone.has(kind === 'rows' ? row : col)) cells.delete(key)
    }
    if (kind === 'cols') for (const id of gone) m.get('widths').delete(id)
  })
}

export function setWidth (ydoc, sheetId, c, px) {
  const m = sheetMap(ydoc, sheetId)
  const col = m?.get('cols').get(c)
  if (col) m.get('widths').set(col, Math.max(32, Math.min(800, Math.round(px))))
}

// ---- reading -----------------------------------------------------------------------

// Everything needed to show one sheet: values computed, text formatted.
// Returns { name, rows, cols, widths: [px], get(r, c) -> { input, value, text, style } }.
export function readSheet (ydoc, sheetId) {
  const ctx = context(ydoc, sheetId)
  const sheet = ctx.sheets.find((s) => s.id === sheetId)
  if (!sheet) return null
  const maps = new Map(ctx.sheets.map((s) => [s.id, { s, cells: sheetMap(ydoc, s.id).get('cells') }]))
  const getCell = (sid, r, c) => {
    const x = maps.get(sid)
    const row = x?.s.rows[r]
    const col = x?.s.cols[c]
    return row && col ? x.cells.get(cellKey(row, col))?.v ?? null : null
  }
  const evaluate = evaluator({ ctx, getCell })
  const m = sheetMap(ydoc, sheetId)
  const widths = m.get('widths')
  const cells = m.get('cells')
  return {
    id: sheetId,
    name: sheet.name,
    rows: sheet.rows,
    cols: sheet.cols,
    widths: sheet.cols.map((id) => widths.get(id) || DEFAULT_WIDTH),
    get (r, c) {
      const stored = cells.get(cellKey(sheet.rows[r], sheet.cols[c]))
      if (!stored) return null
      const value = evaluate(sheetId, r, c)
      return { input: toDisplay(stored.v, ctx), value, text: formatValue(value, stored.s), style: stored.s || null }
    },
    // Every cell that has something in it.
    * filled () {
      const rowIx = new Map(sheet.rows.map((id, i) => [id, i]))
      const colIx = new Map(sheet.cols.map((id, i) => [id, i]))
      for (const key of cells.keys()) {
        const [row, col] = key.split(':')
        if (rowIx.has(row) && colIx.has(col)) yield [rowIx.get(row), colIx.get(col)]
      }
    }
  }
}

// How a value shows in its cell, given the cell's number format.
export function formatValue (value, style) {
  if (value == null) return ''
  if (isError(value)) return value.code
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'string') return value
  const nf = style?.nf
  const dp = style?.dp
  const fixed = (n, d) => n.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })
  switch (nf) {
    case 'number': return fixed(value, dp ?? 2)
    case 'percent': return `${fixed(value * 100, dp ?? 0)}%`
    case 'currency': return value.toLocaleString(undefined, { style: 'currency', currency: style?.cur || 'USD', minimumFractionDigits: dp ?? 2, maximumFractionDigits: dp ?? 2 })
    case 'date': return dateFromSerial(value).toLocaleDateString()
    case 'text': return String(value)
    default: return dp != null ? fixed(value, dp) : formatGeneral(value)
  }
}

// A short text preview for Drive.
export function preview (ydoc) {
  const first = sheetList(ydoc)[0]
  if (!first) return ''
  const s = readSheet(ydoc, first.id)
  const parts = []
  const filled = [...s.filled()].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  for (const [r, c] of filled) {
    const t = s.get(r, c)?.text
    if (t) parts.push(t)
    if (parts.join(' ').length > 200) break
  }
  return parts.join(' · ')
}

// A grid of displayed text (for the Drive thumbnail): top-left corner.
export function previewGrid (ydoc, rows = 6, cols = 4) {
  const first = sheetList(ydoc)[0]
  if (!first) return []
  const s = readSheet(ydoc, first.id)
  return Array.from({ length: Math.min(rows, s.rows.length) }, (_, r) => Array.from({ length: Math.min(cols, s.cols.length) }, (_, c) => s.get(r, c)?.text || ''))
}

export { literal, colName }
