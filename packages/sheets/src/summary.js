// Summaries (pivot tables): one row per distinct value in a column, with a
// sum, count, average, smallest or largest of another column.
//
// The result is an ordinary sheet of formulas (=SUMIF and friends) that
// point at the source, so its numbers stay right as the source changes on
// any computer. The list of groups is written once; "Update" rewrites it
// from the definition kept on the summary sheet:
//
//   sheetData[id].summary = { source, range, group, value, fn, header }

import { addSheet, insertRows, sheetList, sheetMap, readSheet, setCell, styleRange, setWidth, context } from './model.js'
import { storeRange, resolveRange } from './rules.js'
import { a1, colName, quoteSheet } from './formula.js'

export const SUMMARY_FUNCTIONS = { sum: 'Sum', count: 'Count', average: 'Average', min: 'Smallest', max: 'Largest' }
const MAX_GROUPS = 2000

// sel: the source rectangle (indices); group, value: column indices in it.
export function summarize (ydoc, sourceId, sel, { group, value, fn = 'sum', header = true }) {
  const source = sheetList(ydoc).find((s) => s.id === sourceId)
  if (!source) return null
  const name = `Summary of ${source.name}`.slice(0, 60)
  let id
  ydoc.transact(() => {
    id = addSheet(ydoc, { name: uniqueName(ydoc, name), rows: 20, cols: 4 })
    sheetMap(ydoc, id).set('summary', { source: sourceId, range: storeRange(source, sel), group: source.cols[group], value: source.cols[value], fn, header })
    writeSummary(ydoc, id)
  })
  return id
}

const uniqueName = (ydoc, name) => {
  const taken = new Set(sheetList(ydoc).map((s) => s.name.toLowerCase()))
  for (let i = 1; ; i++) { const n = i === 1 ? name : `${name} ${i}`; if (!taken.has(n.toLowerCase())) return n }
}

export const summaryOf = (ydoc, sheetId) => sheetMap(ydoc, sheetId)?.get('summary') || null

// Rewrites a summary sheet from its definition. Returns false when its
// source or columns are gone.
export function writeSummary (ydoc, id) {
  const def = summaryOf(ydoc, id)
  const src = def && readSheet(ydoc, def.source)
  const at = src && resolveRange(src, def.range)
  const gc = src ? src.cols.indexOf(def.group) : -1
  const vc = src ? src.cols.indexOf(def.value) : -1
  if (!at || gc < 0 || vc < 0) return false

  let last = at.r0
  for (const [r, c] of src.filled()) if (c >= at.c0 && c <= at.c1 && r > last) last = r
  const first = at.r0 + (def.header ? 1 : 0)
  const r1 = Math.min(at.r1, last)
  const groups = new Map()
  for (let r = first; r <= r1 && groups.size < MAX_GROUPS; r++) {
    const cell = src.get(r, gc)
    if (!cell || cell.text === '') continue
    if (!groups.has(cell.text)) groups.set(cell.text, cell.value)
  }
  const sorted = [...groups].sort(([a, x], [b, y]) => (typeof x === 'number' && typeof y === 'number' ? x - y : a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })))

  const ref = (c) => `${quoteSheet(src.name)}!$${colName(c)}$${first + 1}:$${colName(c)}$${at.r1 + 1}`
  const G = ref(gc)
  const V = ref(vc)
  const formula = (key) => ({
    sum: `=SUMIF(${G},${key},${V})`,
    count: `=COUNTIF(${G},${key})`,
    average: `=AVERAGEIF(${G},${key},${V})`,
    min: `=MINIFS(${V},${G},${key})`,
    max: `=MAXIFS(${V},${G},${key})`
  })[def.fn]
  const total = { sum: `=SUM(B2:B${sorted.length + 1})`, count: `=SUM(B2:B${sorted.length + 1})`, average: `=AVERAGE(${V})`, min: `=MIN(${V})`, max: `=MAX(${V})` }[def.fn]
  const heading = (c) => (def.header ? src.get(at.r0, c)?.text : '') || `Column ${colName(c)}`
  const valueStyle = src.get(first, vc)?.style

  ydoc.transact(() => {
    const m = sheetMap(ydoc, id)
    m.get('cells').clear()
    const need = sorted.length + 3 - m.get('rows').length
    if (need > 0) insertRows(ydoc, id, m.get('rows').length, need)
    const ctx = context(ydoc, id)
    const put = (r, c, input) => setCell(ydoc, id, r, c, input, ctx)
    put(0, 0, heading(gc))
    put(0, 1, `${SUMMARY_FUNCTIONS[def.fn]} of ${def.fn === 'count' ? 'rows' : heading(vc)}`)
    sorted.forEach(([text, v], i) => {
      put(i + 1, 0, typeof v === 'number' ? String(v) : text.startsWith('=') || text.startsWith("'") ? `'${text}` : text)
      put(i + 1, 1, formula(`A${i + 2}`))
    })
    const t = sorted.length + 1
    put(t, 0, 'Total')
    put(t, 1, total)
    styleRange(ydoc, id, { r0: 0, c0: 0, r1: 0, c1: 1 }, { b: true, bg: '#eef2fa' })
    styleRange(ydoc, id, { r0: t, c0: 0, r1: t, c1: 1 }, { b: true })
    if (valueStyle?.nf && def.fn !== 'count') styleRange(ydoc, id, { r0: 1, c0: 1, r1: t, c1: 1 }, { nf: valueStyle.nf, dp: valueStyle.dp })
    setWidth(ydoc, id, 0, 180)
    setWidth(ydoc, id, 1, 150)
  })
  return true
}

// Words for the bar above a summary sheet.
export function describeSummary (ydoc, id) {
  const def = summaryOf(ydoc, id)
  const src = def && readSheet(ydoc, def.source)
  const at = src && resolveRange(src, def.range)
  if (!at) return 'Its source cells are gone.'
  return `${SUMMARY_FUNCTIONS[def.fn]} by group, from ${src.name} ${a1(at.r0, at.c0)}:${a1(at.r1, at.c1)}`
}
