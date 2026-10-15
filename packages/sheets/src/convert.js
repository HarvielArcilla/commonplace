// .xlsx and .csv import and export for commonSheets (runs in the background
// process). Formulas travel as formulas, with their last computed result,
// so the file opens with numbers in Excel, Numbers and Google Sheets.

import ExcelJS from 'exceljs'
import {
  addSheet, sheetList, readSheet, setCell, styleRange, setWidth, context, SHEETS, SHEET_DATA, DEFAULT_WIDTH
} from './model.js'
import { isError } from './formula.js'

const NUMBER_FORMATS = { number: '#,##0.00', percent: '0%', currency: '$#,##0.00', date: 'yyyy-mm-dd', text: '@' }
const argb = (hex) => `FF${hex.replace('#', '').toUpperCase()}`
const hex = (argbValue) => (typeof argbValue === 'string' && argbValue.length >= 6 ? `#${argbValue.slice(-6).toLowerCase()}` : null)

export async function exportXlsx (ydoc) {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'commonSheets'
  const used = new Set()
  for (const s of sheetList(ydoc)) {
    let name = s.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet'
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${name.slice(0, 28)} ${i}`
    used.add(name.toLowerCase())
    const ws = wb.addWorksheet(name)
    const sheet = readSheet(ydoc, s.id)
    sheet.widths.forEach((px, c) => { if (px !== DEFAULT_WIDTH) ws.getColumn(c + 1).width = Math.round(px / 7) })
    for (const [r, c] of sheet.filled()) {
      const cell = sheet.get(r, c)
      if (!cell) continue
      const x = ws.getCell(r + 1, c + 1)
      if (typeof cell.input === 'string' && cell.input.startsWith('=')) {
        x.value = { formula: cell.input.slice(1), result: isError(cell.value) ? { error: cell.value.code } : cell.value ?? undefined }
      } else if (cell.value != null) {
        x.value = cell.value
      }
      const st = cell.style
      if (!st) continue
      if (st.b || st.i || st.u || st.fg) x.font = { bold: st.b || undefined, italic: st.i || undefined, underline: st.u || undefined, color: st.fg ? { argb: argb(st.fg) } : undefined }
      if (st.al) x.alignment = { horizontal: st.al }
      if (st.bg) x.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: argb(st.bg) } }
      if (st.nf && NUMBER_FORMATS[st.nf]) x.numFmt = st.dp != null && st.nf === 'number' ? `#,##0${st.dp ? '.' + '0'.repeat(st.dp) : ''}` : NUMBER_FORMATS[st.nf]
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

// Fills an empty spreadsheet (no sheets yet) from an .xlsx file.
export async function importXlsx (ydoc, bytes) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(bytes)
  let warnings = 0
  ydoc.transact(() => {
    clear(ydoc)
    const made = []
    wb.eachSheet((ws) => {
      const rows = Math.max(100, ws.actualRowCount + 20, ws.rowCount)
      const cols = Math.max(26, ws.actualColumnCount + 4, ws.columnCount)
      made.push({ ws, id: addSheet(ydoc, { name: ws.name, rows, cols }) })
    })
    if (!made.length) addSheet(ydoc, { name: 'Sheet 1' })
    // Cells second, so formulas can point at any sheet.
    for (const { ws, id } of made) {
      const ctx = context(ydoc, id)
      ws.columns?.forEach((col, i) => { if (col.width) setWidth(ydoc, id, i, col.width * 7) })
      ws.eachRow({ includeEmpty: false }, (row, r) => {
        row.eachCell({ includeEmpty: false }, (cell, c) => {
          const { input, style, lossy } = readXlsxCell(cell)
          if (lossy) warnings++
          if (input !== '') setCell(ydoc, id, r - 1, c - 1, input, ctx)
          if (style) styleRange(ydoc, id, { r0: r - 1, c0: c - 1, r1: r - 1, c1: c - 1 }, style)
        })
      })
    }
  })
  return { warnings }
}

function readXlsxCell (cell) {
  const v = cell.value
  let input = ''
  let lossy = false
  if (v && typeof v === 'object' && 'formula' in v) input = `=${v.formula}`
  else if (v && typeof v === 'object' && 'sharedFormula' in v) {
    input = v.result != null ? String(v.result) : ''
    lossy = true
  } else if (v instanceof Date) input = String((v.getTime() / 86400000) + 25569)
  else if (v && typeof v === 'object' && Array.isArray(v.richText)) input = v.richText.map((t) => t.text).join('')
  else if (v && typeof v === 'object' && 'text' in v) input = String(v.text)
  else if (v && typeof v === 'object' && 'error' in v) input = String(v.error)
  else if (typeof v === 'boolean') input = v ? 'TRUE' : 'FALSE'
  else if (v != null) input = String(v)
  const style = {}
  const f = cell.font || {}
  if (f.bold) style.b = true
  if (f.italic) style.i = true
  if (f.underline) style.u = true
  if (hex(f.color?.argb) && hex(f.color.argb) !== '#000000') style.fg = hex(f.color.argb)
  if (['left', 'center', 'right'].includes(cell.alignment?.horizontal)) style.al = cell.alignment.horizontal
  const bg = cell.fill?.type === 'pattern' && cell.fill.pattern === 'solid' ? hex(cell.fill.fgColor?.argb) : null
  if (bg && bg !== '#ffffff') style.bg = bg
  const fmt = String(cell.numFmt || '')
  if (v instanceof Date || /y{2}|d{1,2}[/-]|m{1,2}[/-]d/i.test(fmt)) style.nf = 'date'
  else if (fmt.includes('%')) style.nf = 'percent'
  else if (/[$€£¥]/.test(fmt)) style.nf = 'currency'
  else if (/0\.0/.test(fmt)) { style.nf = 'number'; style.dp = (fmt.split('.')[1] || '').replace(/[^0]/g, '').length }
  return { input, style: Object.keys(style).length ? style : null, lossy }
}

// ---- CSV ---------------------------------------------------------------------------

export function exportCsv (ydoc, sheetId = sheetList(ydoc)[0]?.id) {
  const sheet = readSheet(ydoc, sheetId)
  if (!sheet) return ''
  let maxR = -1
  let maxC = -1
  for (const [r, c] of sheet.filled()) { if (sheet.get(r, c)?.text !== '') { maxR = Math.max(maxR, r); maxC = Math.max(maxC, c) } }
  const lines = []
  for (let r = 0; r <= maxR; r++) {
    const row = []
    for (let c = 0; c <= maxC; c++) {
      const text = sheet.get(r, c)?.text ?? ''
      row.push(/[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
    }
    lines.push(row.join(','))
  }
  return lines.join('\r\n') + (lines.length ? '\r\n' : '')
}

export function parseCsv (text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = String(text).replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++ } else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"' && field === '') quoted = true
    else if (ch === ',' || ch === '\t') { row.push(field); field = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); rows.push(row); row = []; field = ''
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

export function importCsv (ydoc, text, { name = 'Sheet 1' } = {}) {
  const rows = parseCsv(text)
  const width = Math.max(0, ...rows.map((r) => r.length))
  ydoc.transact(() => {
    clear(ydoc)
    const id = addSheet(ydoc, { name, rows: Math.max(100, rows.length + 20), cols: Math.max(26, width + 4) })
    const ctx = context(ydoc, id)
    // Values only: text that starts with "=" in a CSV is data, not a formula.
    rows.forEach((row, r) => row.forEach((v, c) => { if (v !== '') setCell(ydoc, id, r, c, v.startsWith('=') ? `'${v}` : v, ctx) }))
  })
  return { warnings: 0 }
}

function clear (ydoc) {
  const order = ydoc.getArray(SHEETS)
  if (order.length) order.delete(0, order.length)
  const data = ydoc.getMap(SHEET_DATA)
  for (const k of [...data.keys()]) data.delete(k)
}
