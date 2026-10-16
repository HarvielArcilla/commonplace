// commonBoard window: an open canvas you pan and zoom, with sticky notes,
// shapes, text, arrows, lines and freehand drawing, and everyone's cursor.
// Everything edits the file's Y.Doc through @commonplace/whiteboard/model;
// shapes are drawn by @commonplace/whiteboard/render, the same code that
// makes the SVG and PNG exports.

import * as Y from 'yjs'
import {
  allShapes, readShape, addShape, updateShape, deleteShapes, moveShapes, bringToFront, duplicateShapes, shapeText, bounds, extent,
  STICKY_COLORS, INKS, BOXES, HAS_TEXT, SHAPES
} from '@commonplace/whiteboard/model'
import { shapeSvg, boardSvg, hits, FONT, DEFS } from '@commonplace/whiteboard/render'
import { $, el } from './ui.js'
import { toolButton, toolbarGroups, setToolbar, press, swatchMenu } from './toolbar.js'

const NS = 'http://www.w3.org/2000/svg'
const I = (d) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`
const TOOLS = [
  ['select', 'Select', 'V', I('<path d="m3 2 9.5 6-4.5 1 2.5 4.5-1.5.8-2.5-4.5L3 12.5z"/>')],
  ['hand', 'Move around', 'H', I('<path d="M5.5 8V3.5a1 1 0 0 1 2 0V7m0-3.5V3a1 1 0 0 1 2 0v4m0-3a1 1 0 0 1 2 0v4.5m0-2a1 1 0 0 1 2 0V10a4.5 4.5 0 0 1-4.5 4.5h-.5A4.5 4.5 0 0 1 4.2 12L2.6 9.3a1 1 0 0 1 1.7-1l1.2 1.4"/>')],
  ['sticky', 'Sticky note', 'S', I('<path d="M2.5 2.5h11v7l-4 4h-7z"/><path d="M13.5 9.5h-4v4"/>')],
  ['rect', 'Rectangle', 'R', I('<rect x="2" y="3.5" width="12" height="9" rx="2"/>')],
  ['ellipse', 'Ellipse', 'O', I('<ellipse cx="8" cy="8" rx="6" ry="4.5"/>')],
  ['text', 'Text', 'T', I('<path d="M3 3.5h10M8 3.5v9.5M6 13h4"/>')],
  ['arrow', 'Arrow', 'A', I('<path d="M2.5 13.5 13 3M13 3H7.5M13 3v5.5"/>')],
  ['line', 'Line', 'L', I('<path d="M2.5 13.5 13.5 2.5"/>')],
  ['pen', 'Draw', 'P', I('<path d="M2.5 13.5c1.5-3 3-4 4.5-2.5s3 .5 3.5-2 2-4 3-5"/>')]
]
const SIZES = [['Small', 14], ['Medium', 18], ['Large', 24], ['Huge', 36]]
const MIN_K = 0.1
const MAX_K = 4

export function mountWhiteboard (o) {
  const v = {
    o,
    ydoc: o.ydoc,
    writable: true,
    tool: 'select',
    cam: { x: 0, y: 0, k: 1 },
    selected: new Set(),
    editing: null, // shape id whose text is being typed
    nodes: new Map(), // id -> { g, sig }
    undo: new Y.UndoManager([o.ydoc.getMap(SHAPES)], { trackedOrigins: new Set([null]) }),
    clip: null
  }
  v.svg = svgEl('svg', { class: 'board-svg', tabindex: '0', 'aria-label': 'Whiteboard' })
  v.svg.innerHTML = DEFS
  v.world = svgEl('g')
  v.shapesLayer = svgEl('g')
  v.overlay = svgEl('g', { class: 'board-overlay' })
  v.world.append(v.shapesLayer, v.overlay)
  v.svg.append(v.world)
  v.cursors = el('div', { class: 'board-cursors', 'aria-hidden': 'true' })
  v.zoomLabel = el('button', { type: 'button', class: 'board-zoom-label', title: 'Fit the board', onclick: () => fit(v) }, '100%')
  v.zoom = el('div', { class: 'board-zoom' },
    el('button', { type: 'button', class: 'tool', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(v, 1 / 1.25) }, '−'),
    v.zoomLabel,
    el('button', { type: 'button', class: 'tool', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(v, 1.25) }, '+'))
  v.empty = el('p', { class: 'board-empty' }, 'Pick a tool above, or double-click anywhere to write.')
  v.root = el('div', { class: 'board-app' }, v.svg, v.cursors, v.zoom, v.empty)
  $('#desk').replaceChildren(v.root)
  const ctx = document.createElement('canvas').getContext('2d')
  v.measure = (text, size) => { ctx.font = `${size}px ${FONT}`; return ctx.measureText(text).width }

  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); o.refreshMargin() }) }
  o.ydoc.getMap(SHAPES).observeDeep(schedule)
  const onAwareness = () => drawPeers(v)
  o.awareness.on('change', onAwareness)
  const onKey = (e) => keydown(v, e)
  document.addEventListener('keydown', onKey)
  const onUp = (e) => { if (e.key === ' ') v.space = false }
  document.addEventListener('keyup', onUp)
  const fitObserver = new ResizeObserver(() => { applyCamera(v) })
  fitObserver.observe(v.root)
  wirePointer(v)
  v.destroy = () => {
    cancelAnimationFrame(frame)
    o.ydoc.getMap(SHAPES).unobserveDeep(schedule)
    o.awareness.off('change', onAwareness)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('keyup', onUp)
    fitObserver.disconnect()
    stopEditing(v)
    v.undo.destroy()
  }
  renderToolbar(v)
  render(v)
  requestAnimationFrame(() => fit(v, { maxK: 1 }))

  return {
    focus: () => v.svg.focus({ preventScroll: true }),
    setEditable (writable) {
      if (writable === v.writable) return
      v.writable = writable
      if (!writable) { stopEditing(v); setTool(v, 'hand') }
      render(v)
    },
    notes () {
      const n = v.ydoc.getMap(SHAPES).size
      return [{ text: n ? `${n} thing${n === 1 ? '' : 's'} on the board` : 'Empty board' }]
    },
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const shown = el('div', { class: 'board-app board-preview' })
      shown.innerHTML = boardSvg(allShapes(ydoc), { measure: v.measure })
      $('#desk').append(shown)
      return { title: ydoc.getMap('meta').get('title') || '', close () { shown.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    async exportPayload (format) {
      const svg = boardSvg(allShapes(v.ydoc), { measure: v.measure })
      if (format === 'svg') return { payload: { svg } }
      return { payload: { png: await toPng(svg) } }
    },
    exportFormats: { png: 'Image (.png)', svg: 'Vector image (.svg)' },
    exportHints: { png: 'The whole board, at twice its size', svg: 'Opens in browsers, Figma, Illustrator and Inkscape' },
    destroy: () => v.destroy()
  }
}

function svgEl (tag, attrs = {}) {
  const n = document.createElementNS(NS, tag)
  for (const [k, val] of Object.entries(attrs)) if (val != null) n.setAttribute(k, val)
  return n
}

// Draws the SVG onto a canvas at 2x and returns it as base64 PNG.
async function toPng (svg) {
  const w = Number(/width="(\d+)"/.exec(svg)[1])
  const h = Number(/height="(\d+)"/.exec(svg)[1])
  const scale = Math.min(2, 8000 / Math.max(w, h))
  const img = new Image()
  img.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`
  await img.decode()
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w * scale)
  canvas.height = Math.round(h * scale)
  const c = canvas.getContext('2d')
  c.scale(scale, scale)
  c.drawImage(img, 0, 0, w, h)
  return canvas.toDataURL('image/png').split(',')[1]
}

// ---- camera ----------------------------------------------------------------------

const toBoard = (v, cx, cy) => {
  const r = v.svg.getBoundingClientRect()
  return { x: (cx - r.left) / v.cam.k + v.cam.x, y: (cy - r.top) / v.cam.k + v.cam.y }
}

function applyCamera (v) {
  v.world.setAttribute('transform', `scale(${v.cam.k}) translate(${-v.cam.x} ${-v.cam.y})`)
  v.zoomLabel.textContent = `${Math.round(v.cam.k * 100)}%`
  v.svg.style.setProperty('--grid', `${24 * v.cam.k}px`)
  v.svg.style.backgroundPosition = `${-v.cam.x * v.cam.k}px ${-v.cam.y * v.cam.k}px`
  placeEditor(v)
  drawPeers(v)
}

function zoomAt (v, k, cx, cy) {
  const before = toBoard(v, cx, cy)
  v.cam.k = Math.max(MIN_K, Math.min(MAX_K, k))
  const r = v.svg.getBoundingClientRect()
  v.cam.x = before.x - (cx - r.left) / v.cam.k
  v.cam.y = before.y - (cy - r.top) / v.cam.k
  applyCamera(v)
}

function zoomBy (v, f) {
  const r = v.svg.getBoundingClientRect()
  zoomAt(v, v.cam.k * f, r.left + r.width / 2, r.top + r.height / 2)
}

// Shows everything on the board (or the start, if it's empty).
function fit (v, { maxK = 2 } = {}) {
  const box = extent(allShapes(v.ydoc))
  const r = v.svg.getBoundingClientRect()
  if (!box || !r.width) { v.cam = { x: -r.width / 2 + 200, y: -120, k: 1 }; applyCamera(v); return }
  const k = Math.max(MIN_K, Math.min(maxK, (r.width - 120) / Math.max(box.w, 1), (r.height - 120) / Math.max(box.h, 1)))
  v.cam = { k, x: box.x + box.w / 2 - r.width / 2 / k, y: box.y + box.h / 2 - r.height / 2 / k }
  applyCamera(v)
}

// ---- drawing ---------------------------------------------------------------------

function render (v) {
  const shapes = allShapes(v.ydoc)
  const keep = new Set(shapes.map((s) => s.id))
  for (const [id, n] of v.nodes) if (!keep.has(id)) { n.g.remove(); v.nodes.delete(id) }
  for (const id of v.selected) if (!keep.has(id)) v.selected.delete(id)
  if (v.editing && !keep.has(v.editing)) stopEditing(v)
  shapes.forEach((s, i) => {
    let n = v.nodes.get(s.id)
    if (!n) { n = { g: svgEl('g', { 'data-id': s.id }), sig: '' }; v.nodes.set(s.id, n) }
    const sig = JSON.stringify(s) + (v.editing === s.id)
    if (n.sig !== sig) { n.g.innerHTML = shapeSvg(s, { measure: v.measure, editing: v.editing === s.id }); n.sig = sig }
    if (v.shapesLayer.children[i] !== n.g) v.shapesLayer.insertBefore(n.g, v.shapesLayer.children[i] || null)
  })
  v.empty.hidden = shapes.length > 0
  drawSelection(v)
  applyCamera(v)
  syncToolbar(v)
}

function drawSelection (v) {
  v.overlay.replaceChildren()
  const peers = peerSelections(v)
  for (const [id, user] of peers) {
    const s = readShape(v.ydoc, id)
    if (!s) continue
    const b = bounds(s)
    v.overlay.append(svgEl('rect', { x: b.x - 6, y: b.y - 6, width: b.w + 12, height: b.h + 12, rx: 6, class: 'peer-outline', style: `stroke:${user.color}` }))
  }
  if (v.marquee) v.overlay.append(svgEl('rect', { ...rectOf(v.marquee), class: 'marquee' }))
  if (!v.selected.size || !v.writable) return
  const shapes = [...v.selected].map((id) => readShape(v.ydoc, id)).filter(Boolean)
  const pad = 6 / v.cam.k
  for (const s of shapes) {
    const b = bounds(s)
    v.overlay.append(svgEl('rect', { x: b.x - pad, y: b.y - pad, width: b.w + pad * 2, height: b.h + pad * 2, class: 'sel-outline', 'stroke-width': 1.5 / v.cam.k }))
  }
  if (shapes.length !== 1) return
  const s = shapes[0]
  const hs = 9 / v.cam.k
  const handle = (x, y, kind) => v.overlay.append(svgEl('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, class: `handle handle-${kind}`, 'data-handle': kind, 'stroke-width': 1.5 / v.cam.k }))
  if (BOXES.has(s.type)) handle(s.x + s.w, s.y + s.h, 'se')
  else if (s.type === 'line' || s.type === 'arrow') { handle(s.x, s.y, 'start'); handle(s.x + s.w, s.y + s.h, 'end') }
}

const rectOf = (m) => ({ x: Math.min(m.x0, m.x1), y: Math.min(m.y0, m.y1), width: Math.abs(m.x1 - m.x0), height: Math.abs(m.y1 - m.y0) })

function peerSelections (v) {
  const out = new Map()
  for (const [clientId, s] of v.o.awareness.getStates()) {
    if (clientId === v.ydoc.clientID || !s.user) continue
    for (const id of s.board?.sel || []) out.set(id, s.user)
  }
  return out
}

function drawPeers (v) {
  const r = v.svg.getBoundingClientRect()
  const rr = v.root.getBoundingClientRect()
  const nodes = []
  for (const [clientId, s] of v.o.awareness.getStates()) {
    if (clientId === v.ydoc.clientID || !s.user || !s.board?.at) continue
    const x = (s.board.at.x - v.cam.x) * v.cam.k + (r.left - rr.left)
    const y = (s.board.at.y - v.cam.y) * v.cam.k + (r.top - rr.top)
    if (x < -20 || y < -20 || x > rr.width || y > rr.height) continue
    nodes.push(el('div', { class: 'board-cursor', style: `--c:${s.user.color};transform:translate(${x}px,${y}px)` },
      el('span', { class: 'cursor-arrow' }), el('span', { class: 'cursor-name' }, s.user.name)))
  }
  v.cursors.replaceChildren(...nodes)
  drawSelection(v)
}

let lastShared = 0
function shareSelf (v, at) {
  const now = performance.now()
  if (at && now - lastShared < 40) return // about 25 a second is plenty
  lastShared = now
  const prev = v.o.awareness.getLocalState()?.board || {}
  v.o.awareness.setLocalStateField('board', { at: at || prev.at || null, sel: [...v.selected] })
}

// ---- pointer --------------------------------------------------------------------

function shapeAt (v, p) {
  const shapes = allShapes(v.ydoc)
  for (let i = shapes.length - 1; i >= 0; i--) if (hits(shapes[i], p.x, p.y, 6 / v.cam.k)) return shapes[i]
  return null
}

function wirePointer (v) {
  let drag = null
  v.svg.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return
    v.svg.focus({ preventScroll: true })
    const p = toBoard(v, e.clientX, e.clientY)
    if (v.editing) stopEditing(v)
    const panning = v.tool === 'hand' || v.space || e.button === 1 || !v.writable
    if (panning) {
      drag = { kind: 'pan', cx: e.clientX, cy: e.clientY, cam: { ...v.cam } }
    } else if (v.tool === 'select') {
      const handle = e.target.closest?.('[data-handle]')?.dataset.handle
      const id = [...v.selected][0]
      if (handle && id) {
        drag = { kind: 'handle', handle, id, start: readShape(v.ydoc, id) }
      } else {
        const hit = shapeAt(v, p)
        if (hit) {
          if (e.shiftKey) { v.selected.has(hit.id) ? v.selected.delete(hit.id) : v.selected.add(hit.id) } else if (!v.selected.has(hit.id)) { v.selected = new Set([hit.id]) }
          const from = new Map([...v.selected].map((sid) => { const s = readShape(v.ydoc, sid); return [sid, { x: s.x, y: s.y }] }))
          drag = { kind: 'move', p0: p, from, moved: false }
        } else {
          if (!e.shiftKey) v.selected.clear()
          v.marquee = { x0: p.x, y0: p.y, x1: p.x, y1: p.y }
          drag = { kind: 'marquee', base: new Set(v.selected) }
        }
        shareSelf(v)
        render(v)
      }
    } else if (v.tool === 'pen') {
      const id = addShape(v.ydoc, { type: 'pen', x: p.x, y: p.y, points: [0, 0], color: v.ink || INKS[0] })
      drag = { kind: 'pen', id, p0: p, points: [0, 0] }
    } else if (v.tool === 'arrow' || v.tool === 'line') {
      const id = addShape(v.ydoc, { type: v.tool, x: p.x, y: p.y, w: 0, h: 0, color: v.ink || INKS[0] })
      drag = { kind: 'create-line', id, p0: p }
    } else {
      drag = { kind: 'create-box', type: v.tool, p0: p, id: null }
    }
    v.svg.setPointerCapture(e.pointerId)
    v.svg.classList.toggle('panning', drag?.kind === 'pan')
  })
  v.svg.addEventListener('pointermove', (e) => {
    const p = toBoard(v, e.clientX, e.clientY)
    shareSelf(v, { x: Math.round(p.x), y: Math.round(p.y) })
    if (!drag) { v.svg.style.cursor = v.tool === 'select' && shapeAt(v, p) ? 'move' : ''; return }
    if (drag.kind === 'pan') {
      v.cam.x = drag.cam.x - (e.clientX - drag.cx) / v.cam.k
      v.cam.y = drag.cam.y - (e.clientY - drag.cy) / v.cam.k
      applyCamera(v)
    } else if (drag.kind === 'move') {
      const dx = p.x - drag.p0.x
      const dy = p.y - drag.p0.y
      if (!drag.moved && Math.hypot(dx, dy) * v.cam.k < 3) return
      if (!drag.moved) { drag.moved = true; v.undo.stopCapturing() }
      moveShapes(v.ydoc, [...v.selected], dx, dy, drag.from)
    } else if (drag.kind === 'marquee') {
      v.marquee.x1 = p.x
      v.marquee.y1 = p.y
      const box = rectOf(v.marquee)
      v.selected = new Set(drag.base)
      for (const s of allShapes(v.ydoc)) {
        const b = bounds(s)
        if (b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.width && b.y + b.h <= box.y + box.height) v.selected.add(s.id)
      }
      drawSelection(v)
    } else if (drag.kind === 'handle') {
      const s = drag.start
      if (drag.handle === 'se') updateShape(v.ydoc, drag.id, { w: Math.max(30, p.x - s.x), h: Math.max(24, p.y - s.y) })
      else if (drag.handle === 'end') updateShape(v.ydoc, drag.id, { w: p.x - s.x, h: p.y - s.y })
      else updateShape(v.ydoc, drag.id, { x: p.x, y: p.y, w: s.x + s.w - p.x, h: s.y + s.h - p.y })
    } else if (drag.kind === 'pen') {
      const dx = p.x - drag.p0.x
      const dy = p.y - drag.p0.y
      const n = drag.points.length
      if (Math.hypot(dx - drag.points[n - 2], dy - drag.points[n - 1]) * v.cam.k < 2) return
      drag.points.push(Math.round(dx * 10) / 10, Math.round(dy * 10) / 10)
      updateShape(v.ydoc, drag.id, { points: drag.points.slice() })
    } else if (drag.kind === 'create-line') {
      updateShape(v.ydoc, drag.id, { w: p.x - drag.p0.x, h: p.y - drag.p0.y })
    } else if (drag.kind === 'create-box') {
      const w = Math.abs(p.x - drag.p0.x)
      const h = Math.abs(p.y - drag.p0.y)
      if (!drag.id && Math.hypot(w, h) * v.cam.k < 6) return
      const box = { x: Math.min(p.x, drag.p0.x), y: Math.min(p.y, drag.p0.y), w: Math.max(30, w), h: Math.max(24, h) }
      if (!drag.id) drag.id = addShape(v.ydoc, { type: drag.type, ...box, ...styleFor(v, drag.type) })
      else updateShape(v.ydoc, drag.id, box)
    }
  })
  const end = (e) => {
    if (!drag) return
    const d = drag
    drag = null
    v.svg.classList.remove('panning')
    try { v.svg.releasePointerCapture(e.pointerId) } catch {}
    if (d.kind === 'marquee') { v.marquee = null; shareSelf(v); render(v) }
    if (d.kind === 'create-line') {
      const s = readShape(v.ydoc, d.id)
      if (s && Math.hypot(s.w, s.h) < 4) updateShape(v.ydoc, d.id, { w: 140, h: 0 })
      finishCreate(v, d.id)
    }
    if (d.kind === 'pen') { v.selected = new Set(); render(v) }
    if (d.kind === 'create-box') {
      let id = d.id
      if (!id) {
        // A click: a shape of the usual size, centered on it.
        const size = { sticky: [180, 160], rect: [200, 120], ellipse: [180, 120], text: [240, 40] }[d.type]
        id = addShape(v.ydoc, { type: d.type, x: d.p0.x - size[0] / 2, y: d.p0.y - size[1] / 2, ...styleFor(v, d.type) })
      }
      finishCreate(v, id)
      if (HAS_TEXT.has(d.type)) startEditing(v, id)
    }
    if (d.kind === 'move' || d.kind === 'handle') v.undo.stopCapturing()
  }
  v.svg.addEventListener('pointerup', end)
  v.svg.addEventListener('pointercancel', end)
  v.svg.addEventListener('pointerleave', () => { if (!drag) v.o.awareness.setLocalStateField('board', { at: null, sel: [...v.selected] }) })
  v.svg.addEventListener('dblclick', (e) => {
    if (!v.writable) return
    const p = toBoard(v, e.clientX, e.clientY)
    const hit = shapeAt(v, p)
    if (hit && HAS_TEXT.has(hit.type)) { v.selected = new Set([hit.id]); startEditing(v, hit.id); return }
    if (!hit) {
      const id = addShape(v.ydoc, { type: 'text', x: p.x - 8, y: p.y - 20, ...styleFor(v, 'text') })
      finishCreate(v, id)
      startEditing(v, id)
    }
  })
  // Scrolling pans; pinching or Ctrl/Cmd-scrolling zooms.
  v.svg.addEventListener('wheel', (e) => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) zoomAt(v, v.cam.k * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY)
    else { v.cam.x += e.deltaX / v.cam.k; v.cam.y += e.deltaY / v.cam.k; applyCamera(v) }
  }, { passive: false })
}

function styleFor (v, type) {
  if (type === 'sticky') return { color: v.stickyColor || STICKY_COLORS[0] }
  if (type === 'text') return { color: v.ink || INKS[0], size: v.textSize || 24 }
  return {}
}

function finishCreate (v, id) {
  v.selected = new Set([id])
  setTool(v, 'select')
  v.undo.stopCapturing()
  shareSelf(v)
  render(v)
}

// ---- typing in a shape ----------------------------------------------------------

function startEditing (v, id) {
  stopEditing(v)
  const ytext = shapeText(v.ydoc, id)
  if (!ytext) return
  v.editing = id
  const ta = el('textarea', { class: 'board-editor', spellcheck: 'true', 'aria-label': 'Text' })
  ta.value = ytext.toString()
  // Typing changes only what changed, so two people can type in one note.
  ta.addEventListener('input', () => {
    const before = ytext.toString()
    const after = ta.value
    let a = 0
    while (a < before.length && a < after.length && before[a] === after[a]) a++
    let b = 0
    while (b < before.length - a && b < after.length - a && before[before.length - 1 - b] === after[after.length - 1 - b]) b++
    v.ydoc.transact(() => {
      if (before.length - a - b > 0) ytext.delete(a, before.length - a - b)
      if (after.length - a - b > 0) ytext.insert(a, after.slice(a, after.length - b))
    })
    grow(v, id, ta)
  })
  ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); stopEditing(v); v.svg.focus() } })
  ta.addEventListener('blur', () => setTimeout(() => { if (v.editing === id && document.activeElement !== ta) stopEditing(v) }, 0))
  // Someone else typing here: keep my caret where it was in the text.
  const onRemote = (event) => {
    if (event.transaction.local) return
    const sel = [ta.selectionStart, ta.selectionEnd]
    let i = 0
    let shift = [0, 0]
    for (const d of event.delta) {
      if (d.retain) {
        i += d.retain
      } else if (d.insert) {
        shift = shift.map((s, k) => s + (i <= sel[k] ? d.insert.length : 0))
        i += d.insert.length
      } else if (d.delete) {
        shift = shift.map((s, k) => s - (i < sel[k] ? Math.min(d.delete, sel[k] - i) : 0))
      }
    }
    ta.value = ytext.toString()
    ta.setSelectionRange(sel[0] + shift[0], sel[1] + shift[1])
  }
  ytext.observe(onRemote)
  v.editor = { ta, ytext, onRemote, id }
  v.root.append(ta)
  render(v)
  placeEditor(v)
  ta.focus()
  ta.select()
}

// A text shape grows to fit what's typed in it.
function grow (v, id, ta) {
  const s = readShape(v.ydoc, id)
  if (s?.type !== 'text') return
  const h = Math.ceil(ta.scrollHeight / v.cam.k)
  if (h > s.h + 2) updateShape(v.ydoc, id, { h })
}

function placeEditor (v) {
  const ed = v.editor
  if (!ed) return
  const s = readShape(v.ydoc, ed.id)
  if (!s) return
  const r = v.svg.getBoundingClientRect()
  const rr = v.root.getBoundingClientRect()
  const k = v.cam.k
  Object.assign(ed.ta.style, {
    left: `${(s.x - v.cam.x) * k + r.left - rr.left}px`,
    top: `${(s.y - v.cam.y) * k + r.top - rr.top}px`,
    width: `${s.w * k}px`,
    height: `${s.h * k}px`,
    fontSize: `${(s.size || 18) * k}px`,
    padding: `${(s.type === 'text' ? 4 : 14) * k}px`,
    textAlign: s.type === 'text' ? 'left' : 'center',
    color: s.type === 'text' ? s.color : '#1f2430'
  })
}

function stopEditing (v) {
  const ed = v.editor
  if (!ed) return
  ed.ytext.unobserve(ed.onRemote)
  ed.ta.remove()
  v.editor = null
  const id = v.editing
  v.editing = null
  // An empty text shape isn't kept.
  const s = readShape(v.ydoc, id)
  if (s?.type === 'text' && !s.text.trim()) { deleteShapes(v.ydoc, [id]); v.selected.delete(id) }
  render(v)
}

// ---- keys -----------------------------------------------------------------------

function keydown (v, e) {
  if (e.target.closest?.('input, textarea, select, dialog, [contenteditable]')) return
  if (!v.root.isConnected) return
  const mod = e.metaKey || e.ctrlKey
  if (e.key === ' ') { v.space = true; e.preventDefault(); return }
  if (!v.writable) return
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? v.undo.redo() : v.undo.undo(); return }
  if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); v.selected = new Set(allShapes(v.ydoc).map((s) => s.id)); shareSelf(v); render(v); return }
  if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); v.selected = new Set(duplicateShapes(v.ydoc, [...v.selected])); render(v); return }
  if (mod && e.key.toLowerCase() === 'c' && v.selected.size) { v.clip = [...v.selected]; return }
  if (mod && e.key.toLowerCase() === 'v' && v.clip?.length) { e.preventDefault(); v.selected = new Set(duplicateShapes(v.ydoc, v.clip, 32)); render(v); return }
  if ((e.key === 'Delete' || e.key === 'Backspace') && v.selected.size) { e.preventDefault(); deleteShapes(v.ydoc, [...v.selected]); v.selected.clear(); shareSelf(v); return }
  if (e.key === 'Enter' && v.selected.size === 1) { const id = [...v.selected][0]; if (HAS_TEXT.has(readShape(v.ydoc, id)?.type)) { e.preventDefault(); startEditing(v, id) } return }
  if (e.key === 'Escape') { v.selected.clear(); setTool(v, 'select'); shareSelf(v); render(v); return }
  const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  if (arrows[e.key] && v.selected.size) {
    e.preventDefault()
    const step = e.shiftKey ? 20 : 2
    const from = new Map([...v.selected].map((id) => { const s = readShape(v.ydoc, id); return [id, { x: s.x, y: s.y }] }))
    moveShapes(v.ydoc, [...v.selected], arrows[e.key][0] * step, arrows[e.key][1] * step, from)
    return
  }
  if (mod || e.altKey) return
  const tool = TOOLS.find((t) => t[2].toLowerCase() === e.key.toLowerCase())
  if (tool) setTool(v, tool[0])
}

// ---- toolbar ---------------------------------------------------------------------

function setTool (v, tool) {
  v.tool = tool
  v.root.dataset.tool = tool
  syncToolbar(v)
}

function renderToolbar (v) {
  const tools = TOOLS.map(([id, label, key, icon]) => toolButton(`tool-${id}`, `${label} (${key})`, icon, () => setTool(v, id)))
  const colorBtn = toolButton('color', 'Color', I('<circle cx="8" cy="8" r="5.5" fill="var(--swatch, #fff1a8)" stroke="currentColor"/>'), (b) => {
    const sel = [...v.selected].map((id) => readShape(v.ydoc, id)).filter(Boolean)
    const stickyish = sel.length ? sel.every((s) => s.type === 'sticky' || s.type === 'rect' || s.type === 'ellipse') : v.tool === 'sticky' || v.tool === 'rect' || v.tool === 'ellipse'
    const colors = stickyish ? STICKY_COLORS.map((c, i) => [['Yellow', 'Orange', 'Pink', 'Blue', 'Green', 'Lilac', 'Gray'][i], c]).concat([['White', '#ffffff']]) : INKS.map((c, i) => [['Ink', 'Blue', 'Green', 'Rust', 'Red', 'Plum', 'Slate'][i], c])
    swatchMenu(b, 'Color', colors, (hex) => {
      if (sel.length) v.ydoc.transact(() => { for (const s of sel) updateShape(v.ydoc, s.id, { color: hex }) })
      if (stickyish) v.stickyColor = hex
      else v.ink = hex
    })
  })
  const sizeBtn = el('select', {
    class: 'tool-select',
    'data-cmd': 'size',
    'aria-label': 'Text size',
    title: 'Text size',
    onchange: (e) => {
      const size = Number(e.target.value)
      v.textSize = size
      v.ydoc.transact(() => { for (const id of v.selected) { const s = readShape(v.ydoc, id); if (s && HAS_TEXT.has(s.type)) updateShape(v.ydoc, id, { size }) } })
    }
  }, ...SIZES.map(([label, n]) => el('option', { value: String(n) }, label)))
  setToolbar(toolbarGroups([
    tools,
    [colorBtn, sizeBtn],
    [toolButton('front', 'Bring to front', I('<rect x="2" y="2" width="7" height="7" rx="1"/><rect x="7" y="7" width="7" height="7" rx="1" fill="currentColor"/>'), () => bringToFront(v.ydoc, [...v.selected])),
      toolButton('delete', 'Delete', I('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 9h5.6l.7-9"/>'), () => { deleteShapes(v.ydoc, [...v.selected]); v.selected.clear(); shareSelf(v) })],
    [toolButton('undo', 'Undo', I('<path d="M5 4 2 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7"/>'), () => v.undo.undo(), { key: 'Mod-Z' }),
      toolButton('redo', 'Redo', I('<path d="m11 4 3 3-3 3"/><path d="M13.5 7H6a3.5 3.5 0 0 0 0 7h3"/>'), () => v.undo.redo(), { key: 'Mod-Shift-Z' })]
  ]))
  v.toolbarReady = true
}

function syncToolbar (v) {
  if (!v.toolbarReady) return
  for (const [id] of TOOLS) press(`tool-${id}`, v.tool === id)
  const sel = [...v.selected].map((id) => readShape(v.ydoc, id)).filter(Boolean)
  const size = document.querySelector('.tool-select[data-cmd="size"]')
  const withText = sel.filter((s) => HAS_TEXT.has(s.type))
  if (size && document.activeElement !== size) size.value = String(withText[0]?.size || v.textSize || 24)
  const swatch = document.querySelector('.tool[data-cmd="color"]')
  if (swatch) swatch.style.setProperty('--swatch', sel[0]?.color || (v.tool === 'sticky' ? v.stickyColor || STICKY_COLORS[0] : v.ink || INKS[0]))
  for (const id of ['front', 'delete']) { const b = document.querySelector(`.tool[data-cmd="${id}"]`); if (b) b.disabled = !sel.length }
}
