// commonSheets data tools: sort, filter, freeze, conditional formatting,
// dropdowns and checkboxes, and summaries. The grid (sheet-view.js) owns
// drawing and selection; these build the dialogs and menus and write
// through the sheets model.
//
// Everything here is shared with everyone who has the file, except
// filters: hiding rows for everyone would surprise people working on
// them, so a filter only changes your own view (like a "filter view").

import { sortRange, setFreeze, readSheet, sheetList } from '@commonplace/sheets/model'
import { addRule, deleteRule, storeRange, CONDITIONS, CHECKS, describeRule } from '@commonplace/sheets/rules'
import { summarize, SUMMARY_FUNCTIONS } from '@commonplace/sheets/summary'
import { colName, a1 } from '@commonplace/sheets/formula'
import { el, toast, openMenu, dialog, selectField, plural } from './ui.js'
import { FILL_COLORS, TEXT_COLORS } from './toolbar.js'

const MAX_FILTER_VALUES = 500

export const selRange = (s) => ({ r0: Math.min(s.r, s.r2), c0: Math.min(s.c, s.c2), r1: Math.max(s.r, s.r2), c1: Math.max(s.c, s.c2) })

// ---- the data region -----------------------------------------------------------

// The block of filled cells (from A1 to the last filled row and column).
export function usedRange (sheet) {
  let r1 = -1
  let c1 = -1
  for (const [r, c] of sheet.filled()) if (sheet.get(r, c)?.text !== '') { r1 = Math.max(r1, r); c1 = Math.max(c1, c) }
  return r1 < 0 ? null : { r0: 0, c0: 0, r1, c1 }
}

// Rows at the top that are headings rather than data: the frozen rows, or
// a first row of words above rows with numbers in them.
export function headerRows (sheet) {
  if (sheet.freeze.rows) return sheet.freeze.rows
  const used = usedRange(sheet)
  if (!used || used.r1 < 1) return 0
  let words = 0
  let numbers = 0
  for (let c = 0; c <= used.c1; c++) {
    const top = sheet.get(0, c)
    if (top?.text) { if (typeof top.value === 'number') return 0; words++ }
    for (let r = 1; r <= Math.min(used.r1, 20); r++) if (typeof sheet.get(r, c)?.value === 'number') numbers++
  }
  return words && (numbers || sheet.get(0, 0)?.style?.b) ? 1 : 0
}

// What a tool works on: the selection when it's more than one cell,
// otherwise the data around it, without its header rows.
function workingRange (v, { withHeader = false } = {}) {
  const sel = selRange(v.sel)
  if (sel.r0 !== sel.r1 || sel.c0 !== sel.c1) return { ...sel, whole: false }
  const table = tableRange(v.sheet)
  if (!table) return null
  return { ...table, r0: withHeader ? 0 : headerRows(v.sheet), whole: true }
}

// The data on a sheet, without a totals row at the bottom.
export function tableRange (sheet) {
  const used = usedRange(sheet)
  return used && { ...used, r1: totalsRow(sheet, used) ? used.r1 - 1 : used.r1 }
}

// A last row that adds up the rows above it (=SUM(B2:B9)) stays where it is.
function totalsRow (sheet, used) {
  for (let c = used.c0; c <= used.c1; c++) {
    const input = sheet.get(used.r1, c)?.input
    if (typeof input === 'string' && /^=.*[A-Z]+\d+:[A-Z]+\d+/i.test(input)) return true
  }
  return false
}

// ---- sort -----------------------------------------------------------------------

export function sortMenu (v, anchor) {
  const col = v.sel.c2
  const go = (descending) => {
    const at = workingRange(v)
    if (!at || at.r1 <= at.r0) { toast('There’s nothing to sort here yet.'); return }
    const by = Math.max(at.c0, Math.min(at.c1, col))
    if (sortRange(v.ydoc, v.sheetId, at, by, { descending })) toast(`Sorted rows ${at.r0 + 1}–${at.r1 + 1} by column ${colName(by)}`)
    else toast('Already in that order.')
  }
  const sel = selRange(v.sel)
  const scope = sel.r0 !== sel.r1 ? 'selected rows' : 'sheet'
  openMenu(anchor, [
    { heading: `Sort ${scope} by column ${colName(col)}` },
    { label: 'A → Z, smallest first', onSelect: () => go(false) },
    { label: 'Z → A, largest first', onSelect: () => go(true) }
  ], { label: 'Sort' })
}

// ---- freeze ------------------------------------------------------------------------

export function freezeMenu (v, anchor) {
  const f = v.sheet.freeze
  const r = v.sel.r2 + 1
  const c = v.sel.c2 + 1
  openMenu(anchor, [
    { heading: 'Keep rows in view' },
    { label: 'No rows', checked: !f.rows, onSelect: () => setFreeze(v.ydoc, v.sheetId, { rows: 0 }) },
    { label: '1 row', checked: f.rows === 1, onSelect: () => setFreeze(v.ydoc, v.sheetId, { rows: 1 }) },
    { label: '2 rows', checked: f.rows === 2, onSelect: () => setFreeze(v.ydoc, v.sheetId, { rows: 2 }) },
    r > 2 && r <= 10 ? { label: `Up to row ${r}`, checked: f.rows === r, onSelect: () => setFreeze(v.ydoc, v.sheetId, { rows: r }) } : null,
    { heading: 'Keep columns in view' },
    { label: 'No columns', checked: !f.cols, onSelect: () => setFreeze(v.ydoc, v.sheetId, { cols: 0 }) },
    { label: '1 column', checked: f.cols === 1, onSelect: () => setFreeze(v.ydoc, v.sheetId, { cols: 1 }) },
    c > 1 && c <= 5 ? { label: `Up to column ${colName(c - 1)}`, checked: f.cols === c, onSelect: () => setFreeze(v.ydoc, v.sheetId, { cols: c }) } : null
  ], { label: 'Freeze' })
}

// ---- filter (yours only) ------------------------------------------------------------

// v.filters: Map colId -> Set of hidden texts. Returns the rows to hide.
export function hiddenRows (v) {
  const out = new Set()
  if (!v.filters?.size || !v.sheet) return out
  const used = tableRange(v.sheet)
  if (!used) return out
  const cols = [...v.filters].map(([id, hide]) => [v.sheet.cols.indexOf(id), hide]).filter(([c]) => c >= 0)
  for (let r = headerRows(v.sheet) || 1; r <= used.r1; r++) {
    if (cols.some(([c, hide]) => hide.has(v.sheet.get(r, c)?.text ?? ''))) out.add(r)
  }
  return out
}

export async function filterDialog (v) {
  const s = v.sheet
  const c = v.sel.c2
  const colId = s.cols[c]
  const used = tableRange(s)
  if (!used) { toast('There’s nothing to filter yet.'); return }
  const counts = new Map()
  for (let r = headerRows(s) || 1; r <= used.r1; r++) {
    const t = s.get(r, c)?.text ?? ''
    counts.set(t, (counts.get(t) || 0) + 1)
  }
  const values = [...counts].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, undefined, { numeric: true }))).slice(0, MAX_FILTER_VALUES)
  const hidden = v.filters.get(colId) || new Set()
  const boxes = values.map(([text, n]) => {
    const box = el('input', { type: 'checkbox', checked: !hidden.has(text) || null, 'data-value': text })
    return el('label', { class: 'check filter-value' }, box, el('span', {}, text === '' ? '(empty)' : text), el('span', { class: 'filter-count' }, String(n)))
  })
  const search = el('input', { type: 'search', placeholder: 'Find a value', 'aria-label': 'Find a value', autocomplete: 'off' })
  search.addEventListener('input', () => { const q = search.value.toLowerCase(); for (const b of boxes) b.hidden = !b.textContent.toLowerCase().includes(q) })
  const all = (on) => () => { for (const b of boxes) if (!b.hidden) b.querySelector('input').checked = on }
  const heading = headerRows(s) ? s.get(0, c)?.text : ''
  const res = await dialog({
    title: `Show rows where ${heading ? `“${heading}”` : `column ${colName(c)}`} is…`,
    wide: true,
    fields: [
      el('p', { class: 'fineprint-plain' }, 'Filters change only your view. Everyone else still sees every row.'),
      search,
      el('div', { class: 'filter-actions' },
        el('button', { type: 'button', class: 'btn btn-quiet', onclick: all(true) }, 'Select all'),
        el('button', { type: 'button', class: 'btn btn-quiet', onclick: all(false) }, 'Clear')),
      el('div', { class: 'filter-list' }, ...boxes)
    ],
    confirm: 'Filter',
    extraActions: v.filters.has(colId) ? [{ label: 'Remove this filter', value: 'remove' }] : []
  })
  if (!res) return
  if (res.action === 'remove') v.filters.delete(colId)
  else if (res.action === 'confirm') {
    const hide = new Set(boxes.filter((b) => !b.querySelector('input').checked).map((b) => b.querySelector('input').dataset.value))
    if (hide.size) v.filters.set(colId, hide)
    else v.filters.delete(colId)
  }
  v.refresh()
}

// ---- conditional formatting ------------------------------------------------------------

export async function formatRulesDialog (v) {
  const sel = selRange(v.sel)
  const ruleList = () => {
    const rules = v.sheet.formats
    return rules.length
      ? el('ul', { class: 'rule-list' }, ...rules.map(({ id, rule, at }) => el('li', {},
        el('span', { class: 'rule-swatch', style: `--swatch:${rule.when === 'scale' ? `linear-gradient(90deg, ${rule.from}, ${rule.to})` : rule.style?.bg || 'transparent'}` }),
        el('span', { class: 'rule-text' }, `${a1(at.r0, at.c0)}:${a1(at.r1, at.c1)} · ${describeRule(rule)}`),
        v.writable ? el('button', { type: 'button', class: 'btn btn-quiet btn-small', onclick: (e) => { deleteRule(v.ydoc, id); e.currentTarget.closest('li').remove() } }, 'Remove') : null)))
      : el('p', { class: 'fineprint-plain' }, 'No rules on this sheet yet.')
  }
  const when = selectField({ label: 'When a cell', name: 'when', value: 'gt', options: Object.entries(CONDITIONS).map(([value, c]) => ({ value, label: c.label })) })
  const a = el('input', { name: 'a', autocomplete: 'off', 'aria-label': 'Value' })
  const b = el('input', { name: 'b', autocomplete: 'off', 'aria-label': 'Second value' })
  const and = el('span', { class: 'rule-and' }, 'and')
  const fill = selectField({ label: 'Fill', name: 'bg', value: FILL_COLORS[1][1], options: [{ value: '', label: 'No fill' }, ...FILL_COLORS.map(([label, value]) => ({ value, label }))] })
  const ink = selectField({ label: 'Text', name: 'fg', value: '', options: [{ value: '', label: 'Unchanged' }, ...TEXT_COLORS.map(([label, value]) => ({ value, label }))] })
  const bold = el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'bold' }), 'Bold')
  const styleRow = el('div', { class: 'ev-when' }, fill, ink)
  const scaleNote = el('p', { class: 'fineprint-plain' }, 'Colors each number from light (smallest) to dark (largest).')
  const values = el('div', { class: 'rule-values' }, a, and, b)
  const show = () => {
    const c = CONDITIONS[when.querySelector('select').value]
    values.hidden = !c.args
    b.hidden = and.hidden = c.args < 2
    styleRow.hidden = bold.hidden = when.querySelector('select').value === 'scale'
    scaleNote.hidden = !styleRow.hidden
  }
  when.querySelector('select').addEventListener('change', show)
  show()
  const res = await dialog({
    title: 'Conditional formatting',
    wide: true,
    fields: [
      ruleList(),
      v.writable ? el('h3', { class: 'dialog-sub' }, `New rule for ${a1(sel.r0, sel.c0)}:${a1(sel.r1, sel.c1)}`) : null,
      ...(v.writable ? [when, values, styleRow, bold, scaleNote] : [])
    ],
    confirm: v.writable ? 'Add rule' : 'Done',
    cancel: v.writable ? 'Close' : null,
    validate: (d) => {
      if (!v.writable) return null
      const c = CONDITIONS[d.when]
      if (c.args >= 1 && !d.a.trim()) return 'Enter a value to compare with.'
      if (c.args === 2 && !d.b.trim()) return 'Enter both values.'
      if (['gt', 'lt', 'between'].includes(d.when) && [d.a, c.args === 2 ? d.b : '0'].some((x) => !Number.isFinite(Number(x)))) return 'Use numbers for this comparison.'
      if (d.when !== 'scale' && !d.bg && !d.fg && !d.bold) return 'Choose how matching cells should look.'
      return null
    }
  })
  if (res?.action !== 'confirm' || !v.writable) return
  const d = res.data
  const sheet = sheetList(v.ydoc).find((s) => s.id === v.sheetId)
  const rule = { sheet: v.sheetId, kind: 'format', range: storeRange(sheet, sel), when: d.when }
  if (d.when === 'scale') Object.assign(rule, { from: '#ffffff', to: '#7ea6e0' })
  else Object.assign(rule, { a: d.a.trim(), b: d.b.trim() || null, style: { bg: d.bg || undefined, fg: d.fg || undefined, b: d.bold || undefined } })
  addRule(v.ydoc, rule)
  toast('Rule added')
}

// ---- dropdowns, checkboxes and number ranges ------------------------------------------

export async function checksDialog (v) {
  const sel = selRange(v.sel)
  const existing = v.sheet.checkAt(sel.r0, sel.c0)
  const kind = selectField({ label: 'Cells hold', name: 'check', value: existing?.rule.check || 'list', options: Object.entries(CHECKS).map(([value, label]) => ({ value, label })) })
  const options = el('textarea', { name: 'options', rows: '5', placeholder: 'One choice per line', 'aria-label': 'Choices' }, (existing?.rule.options || []).join('\n'))
  const optionsField = el('label', { class: 'field' }, 'Choices', options)
  const min = el('input', { name: 'min', inputmode: 'decimal', value: existing?.rule.min ?? '', 'aria-label': 'Smallest' })
  const max = el('input', { name: 'max', inputmode: 'decimal', value: existing?.rule.max ?? '', 'aria-label': 'Largest' })
  const numbers = el('div', { class: 'rule-values' }, min, el('span', { class: 'rule-and' }, 'to'), max)
  const show = () => {
    const k = kind.querySelector('select').value
    optionsField.hidden = k !== 'list'
    numbers.hidden = k !== 'number'
  }
  kind.querySelector('select').addEventListener('change', show)
  show()
  const res = await dialog({
    title: `Allowed values for ${a1(sel.r0, sel.c0)}:${a1(sel.r1, sel.c1)}`,
    fields: [
      kind, optionsField, numbers,
      el('p', { class: 'fineprint-plain' }, 'Anything else is marked so everyone can spot it. Nothing is blocked, because each copy of the file accepts edits on its own.')
    ],
    confirm: 'Save',
    extraActions: existing ? [{ label: 'Remove', value: 'remove', danger: true }] : [],
    validate: (d) => {
      if (d.check === 'list' && !d.options.split('\n').some((x) => x.trim())) return 'Add at least one choice.'
      if (d.check === 'number' && [d.min, d.max].some((x) => x.trim() && !Number.isFinite(Number(x)))) return 'Use numbers for the range.'
      if (d.check === 'number' && !d.min.trim() && !d.max.trim()) return 'Enter a smallest or largest number.'
      return null
    }
  })
  if (!res) return
  const sheet = sheetList(v.ydoc).find((s) => s.id === v.sheetId)
  v.ydoc.transact(() => {
    // A new rule replaces older ones that sit wholly inside it.
    for (const x of v.sheet.checks) if (x.at.r0 >= sel.r0 && x.at.r1 <= sel.r1 && x.at.c0 >= sel.c0 && x.at.c1 <= sel.c1) deleteRule(v.ydoc, x.id)
    if (res.action === 'remove') { if (existing) deleteRule(v.ydoc, existing.id); return }
    const d = res.data
    const rule = { sheet: v.sheetId, kind: 'check', range: storeRange(sheet, sel), check: d.check }
    if (d.check === 'list') rule.options = d.options.split('\n')
    if (d.check === 'number') Object.assign(rule, { min: d.min.trim() || null, max: d.max.trim() || null })
    addRule(v.ydoc, rule)
  })
}

// The menu under a dropdown cell.
export function pickMenu (v, anchor, r, c, rule, apply) {
  openMenu(anchor, [
    ...(rule.options || []).map((o) => ({ label: o, checked: v.sheet.get(r, c)?.text === o, onSelect: () => apply(o) })),
    { sep: true },
    { label: 'Clear', onSelect: () => apply('') }
  ], { label: 'Choices' })
}

// ---- summaries -----------------------------------------------------------------------

export async function summaryDialog (v, onMade) {
  const at = workingRange(v, { withHeader: true })
  if (!at || at.r1 <= at.r0) { toast('Select a table with a heading row to summarize.'); return }
  const sheet = readSheet(v.ydoc, v.sheetId)
  const header = headerRows(sheet) > 0 || !at.whole
  const name = (c) => (header && sheet.get(at.r0, c)?.text) || `Column ${colName(c)}`
  const cols = []
  for (let c = at.c0; c <= at.c1; c++) cols.push({ value: String(c), label: name(c) })
  const numeric = cols.find((x) => { for (let r = at.r0 + 1; r <= at.r1; r++) if (typeof sheet.get(r, Number(x.value))?.value === 'number') return true; return false })
  const res = await dialog({
    title: `Summarize ${a1(at.r0, at.c0)}:${a1(at.r1, at.c1)}`,
    fields: [
      selectField({ label: 'One row for each', name: 'group', value: cols[0].value, options: cols }),
      selectField({ label: 'Work out', name: 'fn', value: 'sum', options: Object.entries(SUMMARY_FUNCTIONS).map(([value, label]) => ({ value, label })) }),
      selectField({ label: 'Of', name: 'value', value: (numeric || cols[cols.length - 1]).value, options: cols }),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'header', checked: header || null }), 'The first row is headings'),
      el('p', { class: 'fineprint-plain' }, 'The summary goes on a new sheet. Its numbers keep up with changes; choose Update there when new groups appear.')
    ],
    confirm: 'Summarize'
  })
  if (res?.action !== 'confirm') return
  const d = res.data
  const id = summarize(v.ydoc, v.sheetId, at, { group: Number(d.group), value: Number(d.value), fn: d.fn, header: d.header })
  if (id) onMade(id)
}

export const filterNote = (v, hidden) => {
  if (!v.filters?.size) return null
  const used = tableRange(v.sheet)
  const total = used ? used.r1 + 1 - (headerRows(v.sheet) || 1) : 0
  return `Filtered for you: ${plural(total - hidden.size, 'row')} of ${total} shown`
}
