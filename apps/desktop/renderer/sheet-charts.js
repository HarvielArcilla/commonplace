// Charts floating over the commonSheets grid. Each sits on a cell (so it
// moves with inserted rows and columns), redraws when its cells change,
// and can be moved, resized, retitled, copied as a picture or removed.

import { chartsOn, chartData, chartSvg, addChart, updateChart, deleteChart, CHART_TYPES } from '@commonplace/sheets/charts'
import { el, toast, openMenu, dialog, selectField } from './ui.js'
import { icons } from './icons.js'
import { isDark as dark } from './theme.js'

// The new chart goes beside everything already on the sheet.
export function insertChart (v, range, used) {
  if (!range) { toast('Select the cells to chart first.'); return }
  const id = addChart(v.ydoc, v.sheetId, range, { place: { r: range.r0 + 1, c: Math.max(range.c1, used?.c1 ?? 0) + 2 } })
  v.refresh()
  const box = v.chartLayer?.querySelector(`[data-chart="${id}"]`)
  box?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

// Draws (or updates) every chart on the current sheet.
export function drawCharts (v) {
  if (!v.chartLayer) {
    v.chartLayer = el('div', { class: 'chart-layer' })
    v.chartCache = new Map()
  }
  if (!v.chartLayer.isConnected) v.scroll.append(v.chartLayer)
  const charts = chartsOn(v.ydoc, v.sheetId)
  const keep = new Set()
  const table = v.table
  for (const chart of charts) {
    const r = v.sheet.rows.indexOf(chart.at?.row)
    const c = v.sheet.cols.indexOf(chart.at?.col)
    const cell = table.tBodies[0]?.rows[Math.max(0, r)]?.cells[Math.max(0, c) + 1]
    if (!cell) continue
    keep.add(chart.id)
    let box = v.chartLayer.querySelector(`[data-chart="${chart.id}"]`)
    if (!box) {
      box = el('figure', { class: 'chart-box', 'data-chart': chart.id, tabindex: '0' }, el('div', { class: 'chart-art' }))
      v.chartLayer.append(box)
      wireBox(v, box, chart.id)
    }
    box.style.left = `${cell.offsetLeft}px`
    box.style.top = `${cell.offsetTop}px`
    box.style.width = `${chart.w}px`
    box.style.height = `${chart.h}px`
    box.classList.toggle('editable', v.writable)
    const data = chartData(v.ydoc, chart)
    const svg = chartSvg(data, { type: chart.type, title: chart.title, width: chart.w, height: chart.h, dark: dark() })
    if (v.chartCache.get(chart.id) !== svg) {
      v.chartCache.set(chart.id, svg)
      box.querySelector('.chart-art').innerHTML = svg
      box.setAttribute('aria-label', `${CHART_TYPES[chart.type]} chart${chart.title ? `: ${chart.title}` : ''}`)
    }
  }
  for (const box of [...v.chartLayer.children]) if (!keep.has(box.dataset.chart)) { v.chartCache.delete(box.dataset.chart); box.remove() }
}

function wireBox (v, box, id) {
  const chart = () => chartsOn(v.ydoc, v.sheetId).find((x) => x.id === id)
  const menuButton = el('button', { type: 'button', class: 'chart-menu', 'aria-label': 'Chart options', title: 'Chart options', html: icons.more })
  const grip = el('span', { class: 'chart-grip', 'aria-hidden': 'true' })
  box.append(menuButton, grip)
  menuButton.addEventListener('click', (e) => {
    e.stopPropagation()
    openMenu(menuButton, [
      v.writable ? { label: 'Edit chart…', onSelect: () => editDialog(v, chart()) } : null,
      { label: 'Copy as picture', hint: 'Paste it into a document or slide', onSelect: () => copyPicture(v, chart()) },
      v.writable ? { sep: true } : null,
      v.writable ? { label: 'Delete chart', danger: true, onSelect: () => deleteChart(v.ydoc, id) } : null
    ], { label: 'Chart', align: 'end' })
  })
  box.addEventListener('dblclick', () => { if (v.writable) editDialog(v, chart()) })
  box.addEventListener('keydown', (e) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && v.writable) { e.preventDefault(); deleteChart(v.ydoc, id) }
  })

  // Drag to move (it lands on the cell under its corner), drag the grip to resize.
  box.addEventListener('mousedown', (e) => {
    if (!v.writable || e.button !== 0 || e.target.closest('.chart-menu')) return
    e.preventDefault()
    box.focus({ preventScroll: true })
    const resizing = e.target === grip
    const start = { x: e.clientX, y: e.clientY, left: box.offsetLeft, top: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight }
    const move = (ev) => {
      const dx = ev.clientX - start.x
      const dy = ev.clientY - start.y
      if (resizing) { box.style.width = `${Math.max(200, start.w + dx)}px`; box.style.height = `${Math.max(140, start.h + dy)}px` } else { box.style.left = `${Math.max(46, start.left + dx)}px`; box.style.top = `${Math.max(24, start.top + dy)}px` }
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      if (resizing) { updateChart(v.ydoc, id, { w: box.offsetWidth, h: box.offsetHeight }); return }
      const at = cellAtPoint(v, box.offsetLeft, box.offsetTop)
      if (at) updateChart(v.ydoc, id, { at: { row: v.sheet.rows[at.r], col: v.sheet.cols[at.c] } })
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  })
}

// The cell whose box holds a point in the table's coordinates.
function cellAtPoint (v, x, y) {
  const rows = v.table.tBodies[0]?.rows || []
  let r = 0
  while (r < rows.length - 1 && rows[r + 1].offsetTop <= y) r++
  const cells = rows[r]?.cells || []
  let c = 1
  while (c < cells.length - 1 && cells[c + 1].offsetLeft <= x) c++
  return rows[r] ? { r, c: c - 1 } : null
}

async function editDialog (v, chart) {
  if (!chart) return
  const res = await dialog({
    title: 'Edit chart',
    fields: [
      el('label', { class: 'field' }, 'Title', el('input', { name: 'title', value: chart.title || '', maxlength: '120', autocomplete: 'off' })),
      selectField({ label: 'Kind', name: 'type', value: chart.type, options: Object.entries(CHART_TYPES).map(([value, label]) => ({ value, label })) }),
      el('p', { class: 'fineprint-plain' }, 'A first row of words names each series; a first column of words labels the points. Pie charts show the first series.')
    ],
    confirm: 'Save'
  })
  if (res?.action === 'confirm') updateChart(v.ydoc, chart.id, { title: res.data.title.trim(), type: res.data.type })
}

// Copies the chart as a PNG, drawn in light colors so it suits a page.
async function copyPicture (v, chart) {
  if (!chart) return
  const svg = chartSvg(chartData(v.ydoc, chart), { type: chart.type, title: chart.title, width: chart.w, height: chart.h, dark: false })
  try {
    const blob = await svgToPng(svg, chart.w, chart.h)
    await navigator.clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
    toast('Chart copied. Paste it into a document or slide.')
  } catch {
    toast('Couldn’t copy the chart.')
  }
}

export async function svgToPng (svg, w, h, scale = 2) {
  const img = new Image()
  img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const ctx = canvas.getContext('2d')
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, w, h)
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('no image'))), 'image/png'))
}
