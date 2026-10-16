// Charts placed on a sheet, drawn from a range of its cells.
//
//   ydoc.getMap('sheetCharts')  chartId -> {
//     sheet, range,           the cells it draws (stored as in rules.js)
//     type,                   'column' | 'bar' | 'line' | 'pie'
//     title,
//     at: { row, col },       the cell its top-left corner sits on (ids)
//     w, h                    size in pixels
//   }
//
// chartSvg draws one as plain SVG, with fixed colors, so the same picture
// works in the grid, as an exported image and pasted into a document or a
// slide. The palettes were checked for color-blind separation; every
// chart with more than one series also has a legend, so color never
// carries meaning alone.

import { CHARTS, readSheet, sheetList, formatValue } from './model.js'
import { resolveRange, storeRange, stamp } from './rules.js'

export { CHARTS }

export const CHART_TYPES = { column: 'Columns', bar: 'Bars', line: 'Line', pie: 'Pie' }

const PALETTE = {
  light: ['#2f5fa7', '#c2602a', '#3a8a5a', '#8a5bb8', '#b98a12', '#c34a72'],
  dark: ['#5b8ad6', '#d4733b', '#4fa775', '#a07fd6', '#b68a1c', '#d4688f']
}
const INK = {
  light: { surface: '#ffffff', text: '#1f2430', soft: '#5c6270', grid: '#e4e6eb', axis: '#c9ccd3' },
  dark: { surface: '#1d2027', text: '#e6e7ea', soft: '#a6abb6', grid: '#2a2e36', axis: '#3a3f4a' }
}
const FONT = '"Iowan Old Style", Charter, "Sitka Text", Cambria, Georgia, serif'
const MAX_SERIES = 6
const MAX_POINTS = 500

const newId = () => Math.random().toString(36).slice(2, 10)

// ---- editing ------------------------------------------------------------------

// place: the cell for its top-left corner ({ r, c }); by default just right of the cells.
export function addChart (ydoc, sheetId, sel, { type = 'column', title = '', place = { r: sel.r0 + 1, c: sel.c1 + 2 } } = {}) {
  const sheet = sheetList(ydoc).find((s) => s.id === sheetId)
  if (!sheet) return null
  const id = newId()
  const row = sheet.rows[Math.min(place.r, sheet.rows.length - 1)]
  const col = sheet.cols[Math.min(place.c, sheet.cols.length - 1)]
  ydoc.getMap(CHARTS).set(id, { sheet: sheetId, range: storeRange(sheet, sel), type, title: String(title).slice(0, 120), at: { row, col }, w: 440, h: 280, created: stamp() })
  return id
}

export function updateChart (ydoc, id, patch) {
  const map = ydoc.getMap(CHARTS)
  const cur = map.get(id)
  if (!cur) return
  const next = { ...cur, ...patch }
  next.w = Math.max(200, Math.min(1600, Math.round(next.w)))
  next.h = Math.max(140, Math.min(1000, Math.round(next.h)))
  next.title = String(next.title || '').slice(0, 120)
  map.set(id, next)
}

export const deleteChart = (ydoc, id) => ydoc.getMap(CHARTS).delete(id)

export function chartsOn (ydoc, sheetId) {
  const out = []
  for (const [id, chart] of ydoc.getMap(CHARTS)) if (chart?.sheet === sheetId) out.push({ id, ...chart })
  return out.sort((a, b) => (a.created || 0) - (b.created || 0))
}

// ---- data -------------------------------------------------------------------------

// What a chart shows: { labels: [text], series: [{ name, values: [number|null] }] }.
// A first row with text in it names the series; a first column of text
// labels the points. Each other column is one series.
export function chartData (ydoc, chart) {
  const sheet = readSheet(ydoc, chart.sheet)
  const at = sheet && resolveRange(sheet, chart.range)
  if (!at) return null
  const r1 = Math.min(at.r1, lastFilledRow(sheet, at))
  const grid = []
  for (let r = at.r0; r <= r1 && grid.length <= MAX_POINTS; r++) {
    const row = []
    for (let c = at.c0; c <= at.c1; c++) row.push(sheet.get(r, c))
    grid.push(row)
  }
  if (!grid.length) return { labels: [], series: [] }
  const isNum = (x) => typeof x?.value === 'number'
  const body = grid.slice(1)
  const header = grid[0].some((x) => x && !isNum(x)) && body.some((row) => row.some(isNum))
  const rows = header ? body : grid
  const labelCol = grid[0].length > 1 && rows.every((row) => !isNum(row[0]))
  const first = labelCol ? 1 : 0
  const series = []
  for (let j = first; j < grid[0].length && series.length < MAX_SERIES; j++) {
    series.push({
      name: header ? grid[0][j]?.text || `Series ${series.length + 1}` : `Series ${series.length + 1}`,
      values: rows.map((row) => (isNum(row[j]) ? row[j].value : null)),
      format: (n) => formatValue(n, rows.find((row) => isNum(row[j]))?.[j]?.style)
    })
  }
  return { labels: rows.map((row, i) => (labelCol ? row[0]?.text || '' : String(i + 1))), series }
}

// A whole-column range stops at the last row with something in it.
function lastFilledRow (sheet, at) {
  let last = at.r0
  for (const [r, c] of sheet.filled()) if (c >= at.c0 && c <= at.c1 && r > last) last = r
  return last
}

// ---- drawing -----------------------------------------------------------------------

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch])
const fit = (s, n) => (s.length > n ? s.slice(0, Math.max(1, n - 1)) + '…' : s)

// Round steps for an axis from lo to hi.
function ticks (lo, hi) {
  if (lo === hi) { hi = lo + 1; lo = Math.min(0, lo) }
  const raw = (hi - lo) / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => k >= raw)
  const start = Math.floor(lo / step) * step
  const out = []
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
  if (out[out.length - 1] < hi) out.push(Number((out[out.length - 1] + step).toPrecision(12)))
  return out
}

const short = (n) => {
  const a = Math.abs(n)
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`
  if (a >= 1e4) return `${+(n / 1e3).toFixed(1)}K`
  return String(+n.toFixed(2))
}

// A bar with its free end rounded and its baseline end square.
function bar (x, y, w, h, horizontal, flip) {
  const r = Math.min(4, (horizontal ? h : w) / 2, Math.abs(horizontal ? w : h))
  if (!horizontal) {
    if (flip) return `M${x},${y}h${w}v${h - r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - 2 * r)}a${r},${r} 0 0 1 ${-r},${-r}z`
    return `M${x},${y + h}v${-(h - r)}a${r},${r} 0 0 1 ${r},${-r}h${w - 2 * r}a${r},${r} 0 0 1 ${r},${r}v${h - r}z`
  }
  if (flip) return `M${x + w},${y}h${-(w - r)}a${r},${r} 0 0 0 ${-r},${r}v${h - 2 * r}a${r},${r} 0 0 0 ${r},${r}h${w - r}z`
  return `M${x},${y}h${w - r}a${r},${r} 0 0 1 ${r},${r}v${h - 2 * r}a${r},${r} 0 0 1 ${-r},${r}h${-(w - r)}z`
}

export function chartSvg (data, { type = 'column', title = '', width = 440, height = 280, dark = false } = {}) {
  const ink = INK[dark ? 'dark' : 'light']
  const colors = PALETTE[dark ? 'dark' : 'light']
  const parts = []
  const text = (x, y, s, { size = 11, color = ink.soft, anchor = 'start', weight = 400 } = {}) =>
    parts.push(`<text x="${x}" y="${y}" font-size="${size}" fill="${color}" text-anchor="${anchor}" font-weight="${weight}">${esc(s)}</text>`)
  let top = 14
  if (title) { text(14, 24, fit(title, Math.floor(width / 8)), { size: 14, color: ink.text, weight: 600 }); top = 38 }

  const series = data?.series || []
  const labels = data?.labels || []
  const empty = !series.length || series.every((s) => s.values.every((v) => v == null))
  if (empty) {
    text(width / 2, height / 2, 'Select cells with numbers to chart', { anchor: 'middle' })
    return wrap(parts, width, height, ink, title)
  }

  // Legend: always for two or more series, so color never works alone.
  const shown = type === 'pie' ? series.slice(0, 1) : series
  if (shown.length > 1 || type === 'pie') {
    const items = type === 'pie' ? labels.map((l, i) => ({ name: l, color: colors[i % colors.length] })).slice(0, colors.length) : shown.map((s, i) => ({ name: s.name, color: colors[i] }))
    let x = 14
    for (const item of items) {
      const name = fit(item.name, 18)
      const w = 16 + name.length * 6.2 + 14
      if (x + w > width - 8) break
      parts.push(`<rect x="${x}" y="${top}" width="10" height="10" rx="2" fill="${item.color}"/>`)
      text(x + 15, top + 9, name, { size: 11, color: ink.text })
      x += w
    }
    top += 22
  }

  if (type === 'pie') pie(parts, shown[0], labels, { top, width, height, colors, ink })
  else axes(parts, shown, labels, { type, top, width, height, colors, ink, text })
  return wrap(parts, width, height, ink, title)
}

function wrap (parts, width, height, ink, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family='${FONT}' role="img" aria-label="${esc(title || 'Chart')}"><rect width="${width}" height="${height}" fill="${ink.surface}"/>${parts.join('')}</svg>`
}

function axes (parts, series, labels, { type, top, width, height, colors, ink, text }) {
  const values = series.flatMap((s) => s.values).filter((v) => v != null)
  const lo = Math.min(0, ...values)
  const hi = Math.max(0, ...values)
  const steps = ticks(lo, hi)
  const min = steps[0]
  const max = steps[steps.length - 1]
  const horizontal = type === 'bar'
  const fmt = series[0].format || short
  const labelW = horizontal ? Math.min(110, 12 + Math.max(...labels.map((l) => l.length)) * 6.2) : Math.max(...steps.map((s) => short(s).length)) * 6.5 + 14
  const left = 10 + labelW
  const right = width - 16
  const bottom = height - (horizontal ? 24 : 28)
  const span = horizontal ? right - left : bottom - top
  const pos = (v) => (horizontal ? left + ((v - min) / (max - min)) * span : bottom - ((v - min) / (max - min)) * span)

  // Grid lines and value labels.
  for (const s of steps) {
    const p = pos(s)
    if (horizontal) {
      parts.push(`<line x1="${p}" x2="${p}" y1="${top}" y2="${bottom}" stroke="${s === 0 ? ink.axis : ink.grid}" stroke-width="1"/>`)
      text(p, bottom + 16, short(s), { anchor: 'middle' })
    } else {
      parts.push(`<line x1="${left}" x2="${right}" y1="${p}" y2="${p}" stroke="${s === 0 ? ink.axis : ink.grid}" stroke-width="1"/>`)
      text(left - 6, p + 4, short(s), { anchor: 'end' })
    }
  }

  const n = labels.length
  const band = (horizontal ? bottom - top : right - left) / Math.max(1, n)
  const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((horizontal ? bottom - top : right - left) / (horizontal ? 16 : 56)))))
  labels.forEach((l, i) => {
    if (i % every) return
    const mid = (horizontal ? top : left) + band * (i + 0.5)
    if (horizontal) text(left - 6, mid + 4, fit(l, Math.floor((labelW - 12) / 6.2)), { anchor: 'end' })
    else text(mid, bottom + 17, fit(l, Math.max(3, Math.floor((band * every) / 6.5))), { anchor: 'middle' })
  })

  const zero = pos(Math.max(min, Math.min(max, 0)))
  if (type === 'line') {
    series.forEach((s, k) => {
      const pts = s.values.map((v, i) => (v == null ? null : [left + band * (i + 0.5), pos(v)]))
      let d = ''
      let pen = false
      for (const p of pts) { if (!p) { pen = false; continue } d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`; pen = true }
      parts.push(`<path d="${d}" fill="none" stroke="${colors[k]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)
      if (n <= 40) {
        pts.forEach((p, i) => {
          if (p) parts.push(`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="4" fill="${colors[k]}" stroke="${ink.surface}" stroke-width="2"><title>${esc(`${labels[i]} · ${s.name}: ${fmt(s.values[i])}`)}</title></circle>`)
        })
      }
    })
    return
  }
  // Columns or bars: one group per label, a 2px gap between neighbors.
  const inner = band * 0.72
  const thick = Math.max(1, (inner - 2 * (series.length - 1)) / series.length)
  series.forEach((s, k) => {
    s.values.forEach((v, i) => {
      if (v == null) return
      const at = (horizontal ? top : left) + band * i + (band - inner) / 2 + k * (thick + 2)
      const end = pos(v)
      const tip = `<title>${esc(`${labels[i]} · ${s.name}: ${s.format ? s.format(v) : short(v)}`)}</title>`
      const d = horizontal
        ? bar(Math.min(zero, end), at, Math.max(1, Math.abs(end - zero)), thick, true, v < 0)
        : bar(at, Math.min(zero, end), thick, Math.max(1, Math.abs(end - zero)), false, v < 0)
      parts.push(`<path d="${d}" fill="${colors[k]}">${tip}</path>`)
    })
  })
}

function pie (parts, s, labels, { top, width, height, colors, ink }) {
  const vals = s.values.map((v) => (v != null && v > 0 ? v : 0))
  const total = vals.reduce((a, b) => a + b, 0)
  if (!total) return
  const cx = width / 2
  const cy = top + (height - top) / 2
  const r = Math.max(20, Math.min(width / 2 - 20, (height - top) / 2 - 12))
  let a = -Math.PI / 2
  vals.forEach((v, i) => {
    if (!v) return
    const b = a + (v / total) * Math.PI * 2
    const color = colors[i % colors.length]
    const tip = `<title>${esc(`${labels[i]}: ${s.format ? s.format(v) : short(v)} (${Math.round((v / total) * 100)}%)`)}</title>`
    if (v === total) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}">${tip}</circle>`)
    } else {
      const p = (t) => `${(cx + r * Math.cos(t)).toFixed(2)},${(cy + r * Math.sin(t)).toFixed(2)}`
      parts.push(`<path d="M${cx},${cy}L${p(a)}A${r},${r} 0 ${b - a > Math.PI ? 1 : 0} 1 ${p(b)}Z" fill="${color}" stroke="${ink.surface}" stroke-width="2">${tip}</path>`)
    }
    a = b
  })
}
