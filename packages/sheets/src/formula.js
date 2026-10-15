// commonSheets formulas: tokenizer, parser and evaluator.
//
// People type formulas with A1 references (=SUM(A1:B3), ='Q1 numbers'!C4).
// They're stored with references to row and column *ids* instead, written
// {rowId:colId} or {sheetId!rowId:colId}, with $ before an id for absolute
// references. Ids don't change when someone inserts or deletes a row on
// another computer at the same time, so a formula keeps pointing at the
// same cells however the edits merge. toStored/toDisplay convert between
// the two.

export const ERR = {
  div0: '#DIV/0!',
  value: '#VALUE!',
  ref: '#REF!',
  name: '#NAME?',
  na: '#N/A',
  num: '#NUM!',
  cycle: '#CYCLE!',
  parse: '#ERROR!'
}

export class FormulaError {
  constructor (code) { this.code = code }
  toString () { return this.code }
}
const fail = (code) => new FormulaError(code)
export const isError = (v) => v instanceof FormulaError

// ---- A1 names ----------------------------------------------------------------

export function colName (i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

export function colIndex (name) {
  let n = 0
  for (const ch of name.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

// 'B12' -> { r: 11, c: 1 }
export function parseA1 (text) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text)
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null
}

export const a1 = (r, c) => `${colName(c)}${r + 1}`

const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`)

// ---- tokenizer -----------------------------------------------------------------

const A1_REF = /^(?:('(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_(])/
const STORED_REF = /^\{(?:([a-z0-9]+)!)?(\$?)([a-z0-9]+):(\$?)([a-z0-9]+)\}/
const NUMBER = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/
const NAME = /^[A-Za-z_][A-Za-z0-9_.]*/

function tokenize (src) {
  const out = []
  let i = 0
  while (i < src.length) {
    const rest = src.slice(i)
    const ch = src[i]
    if (/\s/.test(ch)) { i++; continue }
    let m
    if ((m = STORED_REF.exec(rest))) {
      out.push({ t: 'ref', stored: true, sheet: m[1] || null, absR: Boolean(m[2]), row: m[3], absC: Boolean(m[4]), col: m[5], text: m[0] })
      i += m[0].length
    } else if ((m = A1_REF.exec(rest))) {
      const sheet = m[1] ? (m[1].startsWith("'") ? m[1].slice(1, -1).replace(/''/g, "'") : m[1]) : null
      out.push({ t: 'ref', stored: false, sheet, absC: Boolean(m[2]), c: colIndex(m[3]), absR: Boolean(m[4]), r: Number(m[5]) - 1, text: m[0] })
      i += m[0].length
    } else if ((m = NUMBER.exec(rest))) {
      out.push({ t: 'num', v: Number(m[0]), text: m[0] })
      i += m[0].length
    } else if (ch === '"') {
      let j = i + 1
      let v = ''
      for (;;) {
        if (j >= src.length) throw new Error('unterminated string')
        if (src[j] === '"') { if (src[j + 1] === '"') { v += '"'; j += 2; continue } break }
        v += src[j++]
      }
      out.push({ t: 'str', v, text: src.slice(i, j + 1) })
      i = j + 1
    } else if ((m = NAME.exec(rest))) {
      out.push({ t: 'name', v: m[0].toUpperCase(), text: m[0] })
      i += m[0].length
    } else if (/^(<=|>=|<>)/.test(rest)) {
      out.push({ t: 'op', v: rest.slice(0, 2), text: rest.slice(0, 2) })
      i += 2
    } else if ('+-*/^&=<>%(),:'.includes(ch)) {
      out.push({ t: 'op', v: ch, text: ch })
      i++
    } else {
      throw new Error(`unexpected "${ch}"`)
    }
  }
  return out
}

// ---- storage form --------------------------------------------------------------

// ctx: { rows: [rowId], cols: [colId], sheetId, sheets: [{ id, name, rows, cols }] }
const sheetByName = (ctx, name) => ctx.sheets.find((s) => s.name.toLowerCase() === String(name).toLowerCase())
const sheetById = (ctx, id) => (id ? ctx.sheets.find((s) => s.id === id) : ctx.sheets.find((s) => s.id === ctx.sheetId))

// "=SUM(A1:A3)" as typed -> "=SUM({r1:c1}:{r3:c1})" to store. Text that
// isn't a formula is stored as typed. (Spaces between parts of a formula
// aren't kept.)
export function toStored (input, ctx) {
  if (typeof input !== 'string' || !input.startsWith('=')) return input
  let tokens
  try { tokens = tokenize(input.slice(1)) } catch { return input }
  return '=' + tokens.map((tok) => {
    if (tok.t !== 'ref' || tok.stored) return tok.text
    const sheet = tok.sheet ? sheetByName(ctx, tok.sheet) : sheetById(ctx)
    const row = sheet?.rows[tok.r]
    const col = sheet?.cols[tok.c]
    if (!row || !col) return '#REF!'
    return `{${tok.sheet ? `${sheet.id}!` : ''}${tok.absR ? '$' : ''}${row}:${tok.absC ? '$' : ''}${col}}`
  }).join('')
}

// "=SUM({r1:c1}:{r3:c1})" -> "=SUM(A1:A3)" for showing and editing.
export function toDisplay (stored, ctx) {
  if (typeof stored !== 'string' || !stored.startsWith('=')) return stored ?? ''
  return '=' + stored.slice(1).replace(new RegExp(STORED_REF.source.slice(1), 'g'), (_m, sheetId, absR, row, absC, col) => {
    const sheet = sheetById(ctx, sheetId)
    const r = sheet ? sheet.rows.indexOf(row) : -1
    const c = sheet ? sheet.cols.indexOf(col) : -1
    if (r < 0 || c < 0) return '#REF!'
    return `${sheetId ? `${quoteSheet(sheet.name)}!` : ''}${absC ? '$' : ''}${colName(c)}${absR ? '$' : ''}${r + 1}`
  })
}

// Moves a formula's relative references by (dr, dc), as copying it from one
// cell to another does. Works on the A1 form.
export function shiftFormula (display, dr, dc) {
  if (typeof display !== 'string' || !display.startsWith('=')) return display
  let tokens
  try { tokens = tokenize(display.slice(1)) } catch { return display }
  return '=' + tokens.map((tok) => {
    if (tok.t !== 'ref' || tok.stored) return tok.text
    const r = tok.absR ? tok.r : tok.r + dr
    const c = tok.absC ? tok.c : tok.c + dc
    if (r < 0 || c < 0) return '#REF!'
    return `${tok.sheet ? `${quoteSheet(tok.sheet)}!` : ''}${tok.absC ? '$' : ''}${colName(c)}${tok.absR ? '$' : ''}${r + 1}`
  }).join('')
}

// ---- parser ----------------------------------------------------------------------

// Precedence, loosest first: comparison, &, + -, * /, ^, unary, %.
function parse (tokens) {
  let i = 0
  const peek = () => tokens[i]
  const isOp = (v) => peek()?.t === 'op' && peek().v === v
  const take = () => tokens[i++]
  const expect = (v) => { if (!isOp(v)) throw new Error(`expected ${v}`); i++ }

  const binary = (next, ops) => () => {
    let left = next()
    while (peek()?.t === 'op' && ops.includes(peek().v)) {
      const op = take().v
      left = { k: 'bin', op, a: left, b: next() }
    }
    return left
  }
  const primary = () => {
    const tok = take()
    if (!tok) throw new Error('unexpected end')
    if (tok.t === 'num') return { k: 'val', v: tok.v }
    if (tok.t === 'str') return { k: 'val', v: tok.v }
    if (tok.t === 'ref') {
      const ref = { k: 'ref', tok }
      if (isOp(':')) { i++; const end = take(); if (end?.t !== 'ref') throw new Error('bad range'); return { k: 'range', a: tok, b: end } }
      return ref
    }
    if (tok.t === 'name') {
      if (isOp('(')) {
        i++
        const args = []
        if (!isOp(')')) {
          for (;;) {
            args.push(isOp(',') || isOp(')') ? { k: 'val', v: null } : comparison())
            if (isOp(',')) { i++; continue }
            break
          }
        }
        expect(')')
        return { k: 'call', name: tok.v, args }
      }
      if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'val', v: tok.v === 'TRUE' }
      return { k: 'name', v: tok.v }
    }
    if (tok.t === 'op' && tok.v === '(') { const e = comparison(); expect(')'); return e }
    if (tok.t === 'op' && (tok.v === '-' || tok.v === '+')) return { k: 'neg', sign: tok.v, a: power() }
    throw new Error(`unexpected ${tok.text}`)
  }
  const percent = () => {
    let e = primary()
    while (isOp('%')) { i++; e = { k: 'pct', a: e } }
    return e
  }
  const power = binary(percent, ['^'])
  const product = binary(power, ['*', '/'])
  const sum = binary(product, ['+', '-'])
  const concat = binary(sum, ['&'])
  const comparison = binary(concat, ['=', '<>', '<', '>', '<=', '>='])
  const tree = comparison()
  if (i < tokens.length) throw new Error(`unexpected ${tokens[i].text}`)
  return tree
}

const parsed = new Map()
function compile (stored) {
  if (parsed.has(stored)) return parsed.get(stored)
  let tree
  try { tree = parse(tokenize(stored.slice(1))) } catch { tree = { k: 'err', code: ERR.parse } }
  if (parsed.size > 5000) parsed.clear()
  parsed.set(stored, tree)
  return tree
}

// ---- values ------------------------------------------------------------------------

// What a cell holds before any formula runs: a number, true/false, text,
// or empty.
// A leading apostrophe keeps text as text ('=not a formula, '00123).
export function literal (input) {
  if (input == null || input === '') return null
  if (String(input).startsWith("'")) return String(input).slice(1)
  const s = String(input).trim()
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return Number(s)
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return Number(s.replace(/,/g, ''))
  if (/^[+-]?(\d+\.?\d*|\.\d+)%$/.test(s)) return Number(s.slice(0, -1)) / 100
  if (/^\$[+-]?\d[\d,]*(\.\d+)?$/.test(s)) return Number(s.slice(1).replace(/,/g, ''))
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true'
  return String(input)
}

const num = (v) => {
  if (isError(v)) return v
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  const n = literal(v)
  return typeof n === 'number' ? n : fail(ERR.value)
}
const str = (v) => (isError(v) ? v : v == null ? '' : typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? formatGeneral(v) : String(v))
const bool = (v) => (isError(v) ? v : typeof v === 'string' ? (/^true$/i.test(v) ? true : /^false$/i.test(v) ? false : fail(ERR.value)) : Boolean(num(v)))

export function formatGeneral (n) {
  if (!Number.isFinite(n)) return ERR.num
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n)
  const r = Number(n.toPrecision(12))
  return Math.abs(r) >= 1e15 || (Math.abs(r) < 1e-9 && r !== 0) ? r.toExponential(6).replace(/\.?0+e/, 'e') : String(r)
}

// Flattens arguments (single values and ranges) into a list.
const flat = (args) => args.flatMap((a) => (a?.range ? a.range.flat() : [a]))
const numbers = (args) => {
  const out = []
  for (const a of args) {
    if (a?.range) { for (const v of a.range.flat()) { if (isError(v)) return v; if (typeof v === 'number') out.push(v) } } else {
      const n = num(a)
      if (isError(n)) return n
      out.push(n)
    }
  }
  return out
}

function criterion (crit) {
  if (typeof crit === 'number') return (v) => v === crit
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(str(crit))
  const op = m[1] || '='
  const target = literal(m[2])
  return (v) => {
    const a = typeof target === 'number' ? (typeof v === 'number' ? v : literal(v)) : str(v).toLowerCase()
    const b = typeof target === 'number' ? target : str(target).toLowerCase()
    if (typeof target === 'number' && typeof a !== 'number') return op === '<>'
    switch (op) {
      case '=': return a === b
      case '<>': return a !== b
      case '<': return a < b
      case '>': return a > b
      case '<=': return a <= b
      case '>=': return a >= b
    }
    return false
  }
}

const round = (n, d, mode) => {
  const f = 10 ** d
  const x = n * f
  const r = mode === 'up' ? Math.sign(x) * Math.ceil(Math.abs(x) - 1e-9) : mode === 'down' ? Math.trunc(x) : Math.sign(x) * Math.round(Math.abs(x) + 1e-9)
  return r / f
}

// Functions get evaluated arguments (ranges as { range: [[...]] }), except
// IF and IFERROR, which evaluate lazily.
const FUNCTIONS = {
  SUM: (args) => { const n = numbers(args); return isError(n) ? n : n.reduce((a, b) => a + b, 0) },
  PRODUCT: (args) => { const n = numbers(args); return isError(n) ? n : n.reduce((a, b) => a * b, 1) },
  AVERAGE: (args) => { const n = numbers(args); return isError(n) ? n : n.length ? n.reduce((a, b) => a + b, 0) / n.length : fail(ERR.div0) },
  MIN: (args) => { const n = numbers(args); return isError(n) ? n : n.length ? Math.min(...n) : 0 },
  MAX: (args) => { const n = numbers(args); return isError(n) ? n : n.length ? Math.max(...n) : 0 },
  MEDIAN: (args) => {
    const n = numbers(args)
    if (isError(n)) return n
    if (!n.length) return fail(ERR.num)
    const s = [...n].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  },
  COUNT: (args) => flat(args).filter((v) => typeof v === 'number').length,
  COUNTA: (args) => flat(args).filter((v) => v != null && v !== '').length,
  COUNTBLANK: (args) => flat(args).filter((v) => v == null || v === '').length,
  ABS: ([a]) => { const n = num(a); return isError(n) ? n : Math.abs(n) },
  SQRT: ([a]) => { const n = num(a); return isError(n) ? n : n < 0 ? fail(ERR.num) : Math.sqrt(n) },
  POWER: ([a, b]) => { const x = num(a); const y = num(b); return isError(x) ? x : isError(y) ? y : x ** y },
  MOD: ([a, b]) => { const x = num(a); const y = num(b); if (isError(x)) return x; if (isError(y)) return y; return y === 0 ? fail(ERR.div0) : x - y * Math.floor(x / y) },
  INT: ([a]) => { const n = num(a); return isError(n) ? n : Math.floor(n) },
  ROUND: ([a, d]) => { const n = num(a); const k = num(d ?? 0); return isError(n) ? n : isError(k) ? k : round(n, k) },
  ROUNDUP: ([a, d]) => { const n = num(a); const k = num(d ?? 0); return isError(n) ? n : isError(k) ? k : round(n, k, 'up') },
  ROUNDDOWN: ([a, d]) => { const n = num(a); const k = num(d ?? 0); return isError(n) ? n : isError(k) ? k : round(n, k, 'down') },
  PI: () => Math.PI,
  AND: (args) => { const v = flat(args).filter((x) => x != null).map(bool); return v.find(isError) || (v.length ? v.every(Boolean) : fail(ERR.value)) },
  OR: (args) => { const v = flat(args).filter((x) => x != null).map(bool); return v.find(isError) || (v.length ? v.some(Boolean) : fail(ERR.value)) },
  NOT: ([a]) => { const b = bool(a); return isError(b) ? b : !b },
  CONCAT: (args) => { const v = flat(args).map(str); return v.find(isError) || v.join('') },
  CONCATENATE: (args) => FUNCTIONS.CONCAT(args),
  LEN: ([a]) => { const s = str(a); return isError(s) ? s : s.length },
  UPPER: ([a]) => { const s = str(a); return isError(s) ? s : s.toUpperCase() },
  LOWER: ([a]) => { const s = str(a); return isError(s) ? s : s.toLowerCase() },
  TRIM: ([a]) => { const s = str(a); return isError(s) ? s : s.trim().replace(/\s+/g, ' ') },
  LEFT: ([a, n]) => { const s = str(a); const k = num(n ?? 1); return isError(s) ? s : isError(k) ? k : s.slice(0, k) },
  RIGHT: ([a, n]) => { const s = str(a); const k = num(n ?? 1); return isError(s) ? s : isError(k) ? k : k ? s.slice(-k) : '' },
  MID: ([a, start, n]) => { const s = str(a); const b = num(start); const k = num(n); return isError(s) ? s : isError(b) ? b : isError(k) ? k : s.slice(b - 1, b - 1 + k) },
  TODAY: () => { const d = new Date(); return serialDate(new Date(d.getFullYear(), d.getMonth(), d.getDate())) },
  NOW: () => serialDate(new Date()),
  ISBLANK: ([a]) => a == null || a === '',
  ISNUMBER: ([a]) => typeof a === 'number',
  ISTEXT: ([a]) => typeof a === 'string' && a !== '',
  ISERROR: ([a]) => isError(a),
  SUMIF: ([range, crit, sumRange]) => {
    if (!range?.range) return fail(ERR.value)
    const test = criterion(crit)
    const vals = range.range.flat()
    const sums = sumRange?.range ? sumRange.range.flat() : vals
    let total = 0
    vals.forEach((v, i) => { if (test(v) && typeof sums[i] === 'number') total += sums[i] })
    return total
  },
  COUNTIF: ([range, crit]) => (range?.range ? range.range.flat().filter(criterion(crit)).length : fail(ERR.value)),
  AVERAGEIF: ([range, crit, avgRange]) => {
    if (!range?.range) return fail(ERR.value)
    const test = criterion(crit)
    const vals = range.range.flat()
    const src = avgRange?.range ? avgRange.range.flat() : vals
    const picked = vals.map((v, i) => (test(v) ? src[i] : null)).filter((v) => typeof v === 'number')
    return picked.length ? picked.reduce((a, b) => a + b, 0) / picked.length : fail(ERR.div0)
  },
  VLOOKUP: ([key, table, col, approx]) => {
    if (!table?.range) return fail(ERR.value)
    const c = num(col)
    if (isError(c)) return c
    if (c < 1 || c > (table.range[0]?.length || 0)) return fail(ERR.ref)
    const exact = approx === false || approx === 0
    const rows = table.range
    const eq = (v) => (typeof key === 'number' ? v === key : str(v).toLowerCase() === str(key).toLowerCase())
    if (exact) { const row = rows.find((r) => eq(r[0])); return row ? row[c - 1] : fail(ERR.na) }
    let best = null
    for (const r of rows) { if (typeof r[0] === typeof key && r[0] <= key) best = r; else if (best) break }
    return best ? best[c - 1] : fail(ERR.na)
  },
  MATCH: ([key, range, type]) => {
    if (!range?.range) return fail(ERR.value)
    const list = range.range.flat()
    const exact = type === 0 || type === false
    const i = exact || type == null
      ? list.findIndex((v) => (typeof key === 'number' ? v === key : str(v).toLowerCase() === str(key).toLowerCase()))
      : -1
    return i >= 0 ? i + 1 : fail(ERR.na)
  },
  INDEX: ([range, r, c]) => {
    if (!range?.range) return fail(ERR.value)
    const row = num(r)
    const col = num(c ?? 1)
    if (isError(row)) return row
    if (isError(col)) return col
    const rows = range.range
    const value = (rows.length === 1 && c == null) ? rows[0][row - 1] : rows[row - 1]?.[col - 1]
    return value === undefined ? fail(ERR.ref) : value
  }
}

// Days since 1899-12-30, like other spreadsheets.
export function serialDate (date) {
  return (date.getTime() - date.getTimezoneOffset() * 60000) / 86400000 + 25569
}
export function dateFromSerial (n) {
  const d = new Date(Math.round((n - 25569) * 86400000))
  return new Date(d.getTime() + d.getTimezoneOffset() * 60000)
}

export const FUNCTION_NAMES = Object.keys(FUNCTIONS).sort()

// ---- evaluation ------------------------------------------------------------------------

// A workbook: getCell(sheetId, r, c) -> stored input; ctx as for toStored.
// Returns evaluate(sheetId, r, c) -> value, memoized for this snapshot.
export function evaluator ({ ctx, getCell }) {
  const memo = new Map()
  const visiting = new Set()
  const indexOf = new Map(ctx.sheets.map((s) => [s.id, { rows: new Map(s.rows.map((id, i) => [id, i])), cols: new Map(s.cols.map((id, i) => [id, i])) }]))

  const resolve = (tok, here) => {
    const sheetId = tok.stored ? (tok.sheet || here) : (tok.sheet ? sheetByName(ctx, tok.sheet)?.id : here)
    const ix = indexOf.get(sheetId)
    if (!ix) return null
    const r = tok.stored ? ix.rows.get(tok.row) : tok.r
    const c = tok.stored ? ix.cols.get(tok.col) : tok.c
    return r == null || c == null ? null : { sheetId, r, c }
  }

  const evaluate = (sheetId, r, c) => {
    const key = `${sheetId}|${r}|${c}`
    if (memo.has(key)) return memo.get(key)
    if (visiting.has(key)) return fail(ERR.cycle)
    const input = getCell(sheetId, r, c)
    let value
    if (typeof input === 'string' && input.startsWith('=') && input.length > 1) {
      visiting.add(key)
      try { value = run(compile(input), sheetId) } finally { visiting.delete(key) }
      if (value?.range) value = value.range[0]?.[0] ?? null
    } else {
      value = literal(input)
    }
    if (typeof value === 'number' && !Number.isFinite(value)) value = fail(ERR.num)
    memo.set(key, value)
    return value
  }

  const run = (node, here) => {
    switch (node.k) {
      case 'val': return node.v
      case 'err': return fail(node.code)
      case 'name': return fail(ERR.name)
      case 'ref': {
        const at = resolve(node.tok, here)
        return at ? evaluate(at.sheetId, at.r, at.c) ?? null : fail(ERR.ref)
      }
      case 'range': {
        const a = resolve(node.a, here)
        const b = resolve(node.b, here)
        if (!a || !b || a.sheetId !== b.sheetId) return fail(ERR.ref)
        const rows = []
        for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
          const row = []
          for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) row.push(evaluate(a.sheetId, r, c))
          rows.push(row)
        }
        return { range: rows }
      }
      case 'neg': {
        const v = num(single(run(node.a, here)))
        return isError(v) ? v : node.sign === '-' ? -v : v
      }
      case 'pct': {
        const v = num(single(run(node.a, here)))
        return isError(v) ? v : v / 100
      }
      case 'bin': return binaryOp(node.op, single(run(node.a, here)), single(run(node.b, here)))
      case 'call': {
        if (node.name === 'IF') {
          const test = bool(single(run(node.args[0] || { k: 'val', v: false }, here)))
          if (isError(test)) return test
          const pick = test ? node.args[1] : node.args[2]
          return pick ? single(run(pick, here)) ?? 0 : test
        }
        if (node.name === 'IFERROR') {
          const v = single(run(node.args[0], here))
          return isError(v) ? single(run(node.args[1] || { k: 'val', v: '' }, here)) : v
        }
        const fn = FUNCTIONS[node.name]
        if (!fn) return fail(ERR.name)
        const args = node.args.map((a) => run(a, here))
        const err = args.find((a) => isError(a))
        if (err && !['ISERROR', 'COUNT', 'COUNTA', 'COUNTBLANK'].includes(node.name)) return err
        return fn(args)
      }
    }
    return fail(ERR.parse)
  }
  return evaluate
}

const single = (v) => (v?.range ? (v.range.length === 1 && v.range[0].length === 1 ? v.range[0][0] : fail(ERR.value)) : v)

function binaryOp (op, a, b) {
  if (isError(a)) return a
  if (isError(b)) return b
  if (op === '&') return str(a) + str(b)
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const norm = (v) => (v == null ? (typeof (v === a ? b : a) === 'number' ? 0 : '') : typeof v === 'string' ? v.toLowerCase() : v)
    const x = norm(a)
    const y = norm(b)
    switch (op) {
      case '=': return x === y
      case '<>': return x !== y
      case '<': return x < y
      case '>': return x > y
      case '<=': return x <= y
      case '>=': return x >= y
    }
  }
  const x = num(a)
  const y = num(b)
  if (isError(x)) return x
  if (isError(y)) return y
  switch (op) {
    case '+': return x + y
    case '-': return x - y
    case '*': return x * y
    case '/': return y === 0 ? fail(ERR.div0) : x / y
    case '^': return x ** y
  }
  return fail(ERR.parse)
}
