// Rules that apply to a range of cells: conditional formatting ("format")
// and data validation ("check": a dropdown, a checkbox or a number range).
//
//   ydoc.getMap('sheetRules')   ruleId -> { sheet, kind, range, ... }
//
// One flat map at the top of the document, so two people adding rules at
// the same time never overwrite each other's container. A range is stored
// by row and column ids (null for "the whole column / row"), so it follows
// its cells when rows or columns are inserted elsewhere.
//
// Validation can't stop someone else's computer from writing anything, so
// it never rejects: values that break a rule are marked, on every copy.

export const RULES = 'sheetRules'

export const CONDITIONS = {
  gt: { label: 'Greater than', args: 1 },
  lt: { label: 'Less than', args: 1 },
  eq: { label: 'Equal to', args: 1 },
  between: { label: 'Between', args: 2 },
  contains: { label: 'Text contains', args: 1 },
  notEmpty: { label: 'Is not empty', args: 0 },
  scale: { label: 'Color scale', args: 0 }
}

export const CHECKS = {
  list: 'Dropdown',
  checkbox: 'Checkbox',
  number: 'Number between'
}

const MAX_OPTIONS = 200
const newId = () => Math.random().toString(36).slice(2, 10)
// When it was added, never the same twice here, so later rules win in order.
let last = 0
export const stamp = () => { last = Math.max(Date.now(), last + 1); return last }

// ---- ranges ------------------------------------------------------------------

// sheet: { id, rows: [rowId], cols: [colId] } (an entry of sheetList).
export function storeRange (sheet, { r0, c0, r1, c1 }) {
  const line = (ids, a, b) => (a === 0 && b === ids.length - 1 ? null : [ids[a], ids[b]])
  return { rows: line(sheet.rows, r0, r1), cols: line(sheet.cols, c0, c1) }
}

// Back to indices, or null when a row or column at its edge was deleted.
export function resolveRange (sheet, range) {
  const line = (ids, ends) => {
    if (!ends) return [0, ids.length - 1]
    const a = ids.indexOf(ends[0])
    const b = ids.indexOf(ends[1])
    return a < 0 || b < 0 ? null : [Math.min(a, b), Math.max(a, b)]
  }
  const rows = line(sheet.rows, range?.rows)
  const cols = line(sheet.cols, range?.cols)
  return rows && cols ? { r0: rows[0], r1: rows[1], c0: cols[0], c1: cols[1] } : null
}

export const inRange = (x, r, c) => r >= x.r0 && r <= x.r1 && c >= x.c0 && c <= x.c1

// ---- editing -------------------------------------------------------------------

export function addRule (ydoc, rule) {
  const id = newId()
  ydoc.getMap(RULES).set(id, clean({ ...rule, created: stamp() }))
  return id
}

export function updateRule (ydoc, id, patch) {
  const map = ydoc.getMap(RULES)
  const cur = map.get(id)
  if (cur) map.set(id, clean({ ...cur, ...patch }))
}

export const deleteRule = (ydoc, id) => ydoc.getMap(RULES).delete(id)

function clean (rule) {
  const out = { ...rule }
  if (out.kind === 'check' && Array.isArray(out.options)) {
    const seen = new Set()
    out.options = out.options.map((o) => String(o).trim().slice(0, 100))
      .filter((o) => o && !seen.has(o.toLowerCase()) && seen.add(o.toLowerCase()))
      .slice(0, MAX_OPTIONS)
  }
  return out
}

// A sheet's rules, oldest first (later rules win where they overlap).
export function rulesFor (ydoc, sheetId, kind = null) {
  const out = []
  for (const [id, rule] of ydoc.getMap(RULES)) {
    if (rule?.sheet === sheetId && (!kind || rule.kind === kind)) out.push({ id, ...rule })
  }
  return out.sort((a, b) => (a.created || 0) - (b.created || 0) || (a.id < b.id ? -1 : 1))
}

// ---- applying -------------------------------------------------------------------

const asNumber = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

// Whether a value meets a formatting rule's condition.
export function matches (rule, value) {
  const n = asNumber(value)
  const a = asNumber(rule.a)
  const b = asNumber(rule.b)
  switch (rule.when) {
    case 'gt': return n != null && a != null && n > a
    case 'lt': return n != null && a != null && n < a
    case 'eq': return n != null && a != null ? n === a : String(value ?? '').toLowerCase() === String(rule.a ?? '').toLowerCase()
    case 'between': return n != null && a != null && b != null && n >= Math.min(a, b) && n <= Math.max(a, b)
    case 'contains': return String(value ?? '').toLowerCase().includes(String(rule.a ?? '').toLowerCase()) && String(rule.a ?? '') !== ''
    case 'notEmpty': return value != null && value !== ''
    default: return false
  }
}

// A color between two hex colors, t from 0 to 1.
export function mix (from, to, t) {
  const p = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const x = p(from)
  const y = p(to)
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * Math.max(0, Math.min(1, t))).toString(16).padStart(2, '0')).join('')
}

// Whether a value is allowed by a validation rule. Empty is always allowed.
export function allowed (rule, value) {
  if (value == null || value === '') return true
  switch (rule.check) {
    case 'list': return (rule.options || []).some((o) => o.toLowerCase() === String(value).toLowerCase())
    case 'checkbox': return typeof value === 'boolean'
    case 'number': {
      const n = asNumber(value)
      const lo = asNumber(rule.min)
      const hi = asNumber(rule.max)
      return n != null && (lo == null || n >= lo) && (hi == null || n <= hi)
    }
    default: return true
  }
}

// Words for a rule, for lists of rules and tooltips.
export function describeRule (rule) {
  if (rule.kind === 'check') {
    if (rule.check === 'list') return `Dropdown: ${(rule.options || []).join(', ')}`
    if (rule.check === 'checkbox') return 'Checkbox'
    return `Number ${rule.min ?? '…'} to ${rule.max ?? '…'}`
  }
  const c = CONDITIONS[rule.when]
  if (!c) return 'Rule'
  if (rule.when === 'between') return `${c.label} ${rule.a} and ${rule.b}`
  if (rule.when === 'contains') return `${c.label} “${rule.a}”`
  return c.args ? `${c.label} ${rule.a}` : c.label
}
