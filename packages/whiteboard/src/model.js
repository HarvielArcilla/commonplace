// commonBoard data model, on top of the file's Y.Doc. No DOM code.
//
//   ydoc.getMap('shapes')   id -> Y.Map {
//     type:  'sticky' | 'rect' | 'ellipse' | 'text' | 'arrow' | 'line' | 'pen'
//     x, y:  top-left (boxes), or start point (arrow, line, pen)
//     w, h:  size (boxes), or the end point relative to the start (arrow, line)
//     points: [dx, dy, dx, dy, ...] relative to x, y (pen)
//     color: fill (sticky, rect, ellipse) or ink (text, arrow, line, pen)
//     text:  Y.Text (sticky, rect, ellipse, text), so people can type together
//     size:  font size
//     z:     stacking order
//   }
//
// The board has no edges: coordinates are board units, any size. Each
// shape is its own map, so people moving or editing different shapes never
// collide.

import * as Y from 'yjs'

export const SHAPES = 'shapes'
export const STICKY_COLORS = ['#fff1a8', '#ffd6a5', '#ffc8dd', '#cde7ff', '#c9f2d9', '#e4d7ff', '#ececec']
export const INKS = ['#1f2430', '#3b6fd8', '#2f8a5b', '#c2562f', '#c03a5b', '#8a4fb8', '#8a8f9b']
export const BOXES = new Set(['sticky', 'rect', 'ellipse', 'text'])
export const HAS_TEXT = BOXES

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

export function initBoard () {}

export function topZ (ydoc) {
  let z = 0
  for (const s of ydoc.getMap(SHAPES).values()) z = Math.max(z, s.get('z') || 0)
  return z
}

export function addShape (ydoc, fields) {
  const id = newId()
  ydoc.transact(() => {
    const s = new Y.Map()
    ydoc.getMap(SHAPES).set(id, s)
    const { text = '', ...rest } = fields
    const defaults = {
      sticky: { w: 180, h: 160, color: STICKY_COLORS[0], size: 18 },
      rect: { w: 200, h: 120, color: '#ffffff', size: 18 },
      ellipse: { w: 180, h: 120, color: '#ffffff', size: 18 },
      text: { w: 240, h: 40, color: INKS[0], size: 24 },
      arrow: { w: 120, h: 0, color: INKS[0] },
      line: { w: 120, h: 0, color: INKS[0] },
      pen: { w: 0, h: 0, color: INKS[0], points: [] }
    }[fields.type] || {}
    for (const [k, v] of Object.entries({ x: 0, y: 0, ...defaults, ...rest, z: topZ(ydoc) + 1 })) s.set(k, v)
    if (HAS_TEXT.has(fields.type)) { const t = new Y.Text(); t.insert(0, text); s.set('text', t) }
  })
  return id
}

export function updateShape (ydoc, id, patch) {
  const s = ydoc.getMap(SHAPES).get(id)
  if (!s) return
  ydoc.transact(() => { for (const [k, v] of Object.entries(patch)) s.set(k, v) })
}

export function deleteShapes (ydoc, ids) {
  ydoc.transact(() => { for (const id of ids) ydoc.getMap(SHAPES).delete(id) })
}

export function moveShapes (ydoc, ids, dx, dy, from) {
  ydoc.transact(() => {
    for (const id of ids) {
      const s = ydoc.getMap(SHAPES).get(id)
      const start = from?.get(id)
      if (s && start) { s.set('x', start.x + dx); s.set('y', start.y + dy) }
    }
  })
}

export function bringToFront (ydoc, ids) {
  let z = topZ(ydoc)
  ydoc.transact(() => { for (const id of ids) ydoc.getMap(SHAPES).get(id)?.set('z', ++z) })
}

export function duplicateShapes (ydoc, ids, offset = 24) {
  const out = []
  ydoc.transact(() => {
    for (const id of ids) {
      const s = readShape(ydoc, id)
      if (!s) continue
      const { id: _id, text, z, ...rest } = s
      out.push(addShape(ydoc, { ...rest, x: s.x + offset, y: s.y + offset, text: text || '' }))
    }
  })
  return out
}

export function readShape (ydoc, id) {
  const s = ydoc.getMap(SHAPES).get(id)
  if (!s) return null
  const out = { id }
  for (const [k, v] of s.entries()) out[k] = v instanceof Y.Text ? v.toString() : v
  return out
}

export const shapeText = (ydoc, id) => ydoc.getMap(SHAPES).get(id)?.get('text') || null

export function allShapes (ydoc) {
  return [...ydoc.getMap(SHAPES).keys()].map((id) => readShape(ydoc, id)).sort((a, b) => (a.z || 0) - (b.z || 0) || (a.id < b.id ? -1 : 1))
}

// The box a shape covers, normalized (for selection and fitting).
export function bounds (s) {
  if (s.type === 'pen') {
    const xs = []; const ys = []
    for (let i = 0; i < (s.points || []).length; i += 2) { xs.push(s.points[i]); ys.push(s.points[i + 1]) }
    if (!xs.length) return { x: s.x, y: s.y, w: 0, h: 0 }
    const minX = Math.min(...xs); const minY = Math.min(...ys)
    return { x: s.x + minX, y: s.y + minY, w: Math.max(...xs) - minX, h: Math.max(...ys) - minY }
  }
  if (s.type === 'arrow' || s.type === 'line') return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) }
  return { x: s.x, y: s.y, w: s.w, h: s.h }
}

export function extent (shapes) {
  if (!shapes.length) return null
  const bs = shapes.map(bounds)
  const x = Math.min(...bs.map((b) => b.x)); const y = Math.min(...bs.map((b) => b.y))
  return { x, y, w: Math.max(...bs.map((b) => b.x + b.w)) - x, h: Math.max(...bs.map((b) => b.y + b.h)) - y }
}

export function preview (ydoc) {
  const shapes = allShapes(ydoc)
  if (!shapes.length) return 'Empty board'
  const words = shapes.map((s) => s.text).filter(Boolean).slice(0, 4)
  return words.length ? words.join(' · ') : `${shapes.length} shape${shapes.length === 1 ? '' : 's'}`
}

// A small picture of the board: shapes scaled into 160 x 100.
export function thumbnail (ydoc) {
  const shapes = allShapes(ydoc).slice(-60)
  const box = extent(shapes)
  if (!box) return { shapes: [] }
  const k = Math.min(160 / Math.max(box.w, 1), 100 / Math.max(box.h, 1), 0.5)
  return {
    shapes: shapes.map((s) => ({
      type: s.type,
      color: s.color,
      x: (s.x - box.x) * k,
      y: (s.y - box.y) * k,
      w: s.w * k,
      h: s.h * k,
      points: s.type === 'pen' ? (s.points || []).filter((_, i) => i % 4 < 2).map((n) => n * k) : undefined
    }))
  }
}
