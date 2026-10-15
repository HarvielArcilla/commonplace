// CommonSheets: formulas, ids that survive concurrent edits, conflicts, xlsx/csv.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { sheetsApp } from '@commonplace/sheets'
import { initSheets, sheetList, setCell, readSheet, insertRows, deleteRows, addSheet, renameSheet, styleRange, cellAt } from '@commonplace/sheets/model'
import { toStored, toDisplay, shiftFormula, literal } from '@commonplace/sheets/formula'
import { exportXlsx, importXlsx, exportCsv, importCsv, parseCsv } from '@commonplace/sheets/convert'
import { findConflicts, docFrom } from '@commonplace/core'

const book = (cells) => {
  const d = new Y.Doc()
  initSheets(d, { rows: 20, cols: 8 })
  const id = sheetList(d)[0].id
  for (const [ref, v] of Object.entries(cells)) {
    const c = ref.charCodeAt(0) - 65
    const r = Number(ref.slice(1)) - 1
    setCell(d, id, r, c, v)
  }
  return { d, id, text: (ref) => readSheet(d, id).get(Number(ref.slice(1)) - 1, ref.charCodeAt(0) - 65)?.text ?? '' }
}
const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}

test('formulas: arithmetic, functions, ranges, errors and cycles', () => {
  const { text } = book({
    A1: '10', A2: '20', A3: '30.5', A4: '=SUM(A1:A3)', A5: '=AVERAGE(A1:A3)*2',
    B1: '=A1/0', B2: '=IF(A1>5,"big","small")', B3: '=B4', B4: '=B3', B5: '="Total: "&A4',
    C1: '=ROUND(A3/3, 2)', C2: '=COUNTIF(A1:A3,">15")', C3: '=VLOOKUP(20,A1:B3,1,FALSE)', C4: '=NOPE(1)',
    C5: '=IFERROR(A1/0,"n/a")', D1: '12%', D2: '=D1*100', D3: "'=not a formula", D4: '=-A1^2', D5: '=MAX(A1:A3)-MIN(A1:A3)'
  })
  assert.equal(text('A4'), '60.5')
  assert.equal(text('A5'), '40.3333333333')
  assert.equal(text('B1'), '#DIV/0!')
  assert.equal(text('B2'), 'big')
  assert.equal(text('B3'), '#CYCLE!')
  assert.equal(text('B5'), 'Total: 60.5')
  assert.equal(text('C1'), '10.17')
  assert.equal(text('C2'), '2')
  assert.equal(text('C3'), '20')
  assert.equal(text('C4'), '#NAME?')
  assert.equal(text('C5'), 'n/a')
  assert.equal(text('D2'), '12')
  assert.equal(text('D3'), '=not a formula')
  assert.equal(text('D4'), '-100')
  assert.equal(text('D5'), '20.5')
  assert.equal(literal('1,234.5'), 1234.5)
})

test('formulas keep pointing at the same cells when rows are inserted elsewhere at the same time', () => {
  const a = book({ A1: '1', A2: '2', A3: '=A1+A2' })
  const b = new Y.Doc()
  sync(a.d, b)
  // Alice inserts two rows at the top; Bob, at the same time, edits A2.
  insertRows(a.d, a.id, 0, 2)
  setCell(b, a.id, 1, 0, '5')
  sync(a.d, b)
  const sheet = readSheet(a.d, a.id)
  assert.equal(sheet.get(4, 0).input, '=A3+A4', 'the formula moved down with its cells')
  assert.equal(sheet.get(4, 0).text, '6', 'and sees Bob’s edit')
  assert.deepEqual(readSheet(b, a.id).get(4, 0).text, '6')

  // Deleting a row a formula uses shows #REF!.
  deleteRows(a.d, a.id, 2, 1)
  assert.equal(readSheet(a.d, a.id).get(3, 0).input, '=#REF!+A3')
  assert.equal(readSheet(a.d, a.id).get(3, 0).text, '#REF!')
})

test('cross-sheet references, renaming, and copying formulas', () => {
  const { d, id } = book({ A1: '7' })
  const other = addSheet(d, { name: 'Totals', rows: 10, cols: 5 })
  const ctx = { sheetId: other, sheets: sheetList(d) }
  setCell(d, other, 0, 0, '=\'Sheet 1\'!A1*3', ctx)
  assert.equal(readSheet(d, other).get(0, 0).text, '21')
  renameSheet(d, id, 'Inputs')
  assert.equal(readSheet(d, other).get(0, 0).input, '=Inputs!A1*3', 'the reference follows the rename')
  assert.equal(shiftFormula('=A1+$B$2+C$3', 2, 1), '=B3+$B$2+D$3')
  const stored = toStored('=SUM(A1:B2)', { sheetId: id, sheets: sheetList(d) })
  assert.match(stored, /^=SUM\(\{[a-z0-9]+:[a-z0-9]+\}:\{[a-z0-9]+:[a-z0-9]+\}\)$/)
  assert.equal(toDisplay(stored, { sheetId: id, sheets: sheetList(d) }), '=SUM(A1:B2)')
})

test('the same cell edited on both sides while apart is a conflict the owner decides', () => {
  const { d, id } = book({ A1: 'base', B1: 'untouched' })
  const base = Y.encodeStateAsUpdate(d)
  const mine = docFrom(base)
  const theirs = docFrom(base)
  setCell(mine, id, 0, 0, 'mine')
  setCell(theirs, id, 0, 0, 'theirs')
  setCell(theirs, id, 0, 1, 'edited only there')
  const found = findConflicts({ base: docFrom(base), mine, theirs, units: sheetsApp.units })
  assert.equal(found.length, 1)
  assert.equal(found[0].mine.text, 'mine')
  const rec = { kind: 'cell', unit: found[0].key, versions: [found[0].mine, found[0].theirs].map((u) => ({ exists: true, text: u.text, snapshot: sheetsApp.snapshotUnit(u) })) }
  sheetsApp.resolve(mine, rec, 'v1')
  assert.equal(cellAt(mine, id, 0, 0).v, 'theirs')
})

test('xlsx and csv round trips keep values, formulas, styles and sheets', async () => {
  const { d, id } = book({ A1: 'Item', B1: 'Cost', A2: 'Paint', B2: '12.5', A3: 'Brushes', B3: '7.25', A4: 'Total', B4: '=SUM(B2:B3)' })
  styleRange(d, id, { r0: 0, c0: 0, r1: 0, c1: 1 }, { b: true, bg: '#fff3a3' })
  styleRange(d, id, { r0: 1, c0: 1, r1: 3, c1: 1 }, { nf: 'currency' })
  addSheet(d, { name: 'Notes', rows: 5, cols: 3 })
  const bytes = await exportXlsx(d)
  const back = new Y.Doc()
  await importXlsx(back, bytes)
  const sheets = sheetList(back)
  assert.deepEqual(sheets.map((s) => s.name), ['Sheet 1', 'Notes'])
  const s = readSheet(back, sheets[0].id)
  assert.equal(s.get(3, 1).input, '=SUM(B2:B3)')
  assert.equal(s.get(3, 1).value, 19.75)
  assert.match(s.get(3, 1).text, /19\.75/)
  assert.equal(s.get(0, 0).style.b, true)
  assert.equal(s.get(0, 0).style.bg, '#fff3a3')
  assert.equal(s.get(1, 1).style.nf, 'currency')

  const csv = exportCsv(d)
  assert.equal(csv.split('\r\n')[3], 'Total,$19.75')
  assert.deepEqual(parseCsv('a,"b ""q"", c",d\r\n1,2,3\n'), [['a', 'b "q", c', 'd'], ['1', '2', '3']])
  const fromCsv = new Y.Doc()
  importCsv(fromCsv, 'Name,Score\nAda,=1+1\nGrace,98\n')
  const t = readSheet(fromCsv, sheetList(fromCsv)[0].id)
  assert.equal(t.get(1, 1).text, '=1+1', 'formulas in a CSV stay text')
  assert.equal(t.get(2, 1).value, 98)
})
