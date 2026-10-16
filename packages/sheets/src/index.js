// commonSheets app descriptor: what commonDrive needs to create, preview,
// merge and restore spreadsheets. The grid UI lives in the desktop app.

import { initSheets, preview, previewGrid, sheetList, sheetMap, context, SHEETS, SHEET_DATA } from './model.js'
import { sheetTemplates } from './templates.js'
import { toDisplay } from './formula.js'

// Conflict units: every cell that has something in it (plus the title).
function units (ydoc) {
  const out = new Map()
  for (const s of sheetList(ydoc)) {
    const ctx = context(ydoc, s.id)
    for (const [key, cell] of sheetMap(ydoc, s.id).get('cells')) {
      out.set(`${s.id}|${key}`, { kind: 'cell', sheetId: s.id, key, sig: JSON.stringify(cell), text: toDisplay(cell.v, ctx) || '(empty)', cell, prev: null })
    }
  }
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

const snapshotUnit = (u) => (u?.cell ? JSON.stringify(u.cell) : null)

// The owner's decision on a conflict: 'v0' | 'v1' (one version), 'both'
// (the texts side by side in the cell) or 'current'.
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  const present = picked.filter((v) => v.exists)
  if (rec.kind === 'title') {
    if (present.length) ydoc.getMap('meta').set('title', present.map((v) => v.text).join(' / '))
    return
  }
  const [sheetId, key] = rec.unit.split('|')
  const cells = sheetMap(ydoc, sheetId)?.get('cells')
  if (!cells) return
  if (!present.length) { cells.delete(key); return }
  if (present.length === 1) { cells.set(key, JSON.parse(present[0].snapshot)); return }
  cells.set(key, { v: present.map((v) => v.text).join(' / ') })
}

export const sheetsApp = {
  type: 'sheet',
  kind: 'sheet',
  name: 'Spreadsheet',
  description: 'Rows, columns and formulas. Imports and exports .xlsx and .csv files.',
  schemaVersion: 1,
  exports: ['xlsx', 'csv'],
  initContent (ydoc) { initSheets(ydoc) },
  preview,
  thumbnail: (ydoc) => ({ grid: previewGrid(ydoc) }),
  units,
  resolve,
  snapshotUnit,
  templates: sheetTemplates,
  history: { roots: [{ name: SHEETS, type: 'array' }, { name: SHEET_DATA, type: 'map' }] }
}

export default sheetsApp
