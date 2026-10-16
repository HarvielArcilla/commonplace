// Drawing shapes as SVG markup. The board view and the SVG/PNG export use
// the same code, so an export looks like the board. Text is wrapped here
// (with a measure function from the caller), so the result is plain SVG
// that any program can open.

import { bounds, extent, BOXES } from './model.js'

export const FONT = '"Iowan Old Style", Charter, "Sitka Text", Cambria, Georgia, serif'
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

// Breaks text into lines no wider than `width` (measure(text, size) -> px).
export function wrap (text, width, size, measure) {
  const out = []
  for (const para of String(text || '').split('\n')) {
    let line = ''
    for (const word of para.split(/(\s+)/)) {
      const next = line + word
      if (!line.trim() || measure(next.trimEnd(), size) <= width) line = next
      else { out.push(line.trimEnd()); line = word.trimStart() }
      // A single word wider than the box: break it.
      while (line.length > 1 && measure(line.trimEnd(), size) > width) {
        let cut = line.length - 1
        while (cut > 1 && measure(line.slice(0, cut), size) > width) cut--
        out.push(line.slice(0, cut))
        line = line.slice(cut)
      }
    }
    out.push(line.trimEnd())
  }
  return out
}

function textBlock (s, measure, { color = '#1f2430' } = {}) {
  if (!s.text) return ''
  const size = s.size || 18
  const pad = s.type === 'text' ? 4 : 14
  const lines = wrap(s.text, Math.max(10, s.w - pad * 2), size, measure)
  const lh = size * 1.3
  const centered = s.type !== 'text'
  const total = lines.length * lh
  const top = centered ? s.y + Math.max(pad, (s.h - total) / 2) : s.y + pad
  const x = centered ? s.x + s.w / 2 : s.x + pad
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${top + size + i * lh - size * 0.2}">${esc(l) || ' '}</tspan>`).join('')
  return `<text font-family="${esc(FONT)}" font-size="${size}" fill="${esc(color)}"${centered ? ' text-anchor="middle"' : ''} xml:space="preserve">${tspans}</text>`
}

export function shapeSvg (s, { measure, editing = false } = {}) {
  const ink = '#1f2430'
  const text = editing ? '' : textBlock(s, measure, { color: s.type === 'text' ? s.color : ink })
  switch (s.type) {
    case 'sticky':
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="4" fill="${esc(s.color)}" filter="url(#cp-sticky-shadow)"/>${text}`
    case 'rect':
      return `<rect x="${s.x}" y="${s.y}" width="${s.w}" height="${s.h}" rx="10" fill="${esc(s.color)}" stroke="${ink}" stroke-width="2"/>${text}`
    case 'ellipse':
      return `<ellipse cx="${s.x + s.w / 2}" cy="${s.y + s.h / 2}" rx="${Math.abs(s.w / 2)}" ry="${Math.abs(s.h / 2)}" fill="${esc(s.color)}" stroke="${ink}" stroke-width="2"/>${text}`
    case 'text':
      return text
    case 'line':
    case 'arrow': {
      const x2 = s.x + s.w
      const y2 = s.y + s.h
      let head = ''
      if (s.type === 'arrow') {
        const a = Math.atan2(s.h, s.w)
        const l = 16
        const p = (da) => `${x2 - l * Math.cos(a + da)},${y2 - l * Math.sin(a + da)}`
        head = `<polyline points="${p(0.45)} ${x2},${y2} ${p(-0.45)}" fill="none" stroke="${esc(s.color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
      }
      return `<line x1="${s.x}" y1="${s.y}" x2="${x2}" y2="${y2}" stroke="${esc(s.color)}" stroke-width="3" stroke-linecap="round"/>${head}`
    }
    case 'pen': {
      const pts = s.points || []
      if (pts.length < 2) return ''
      let d = `M${s.x + pts[0]} ${s.y + pts[1]}`
      for (let i = 2; i < pts.length; i += 2) d += `L${s.x + pts[i]} ${s.y + pts[i + 1]}`
      return `<path d="${d}" fill="none" stroke="${esc(s.color)}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`
    }
    default:
      return ''
  }
}

export const DEFS = '<defs><filter id="cp-sticky-shadow" x="-10%" y="-10%" width="130%" height="140%"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-color="#000" flood-opacity="0.16"/></filter></defs>'

// The whole board as a standalone SVG document, cropped to its shapes.
export function boardSvg (shapes, { measure, padding = 40, background = '#fbfbf9' } = {}) {
  const box = extent(shapes) || { x: 0, y: 0, w: 400, h: 300 }
  const x = box.x - padding
  const y = box.y - padding
  const w = Math.ceil(box.w + padding * 2)
  const h = Math.ceil(box.h + padding * 2)
  const body = shapes.map((s) => `<g>${shapeSvg(s, { measure })}</g>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${x} ${y} ${w} ${h}">${DEFS}<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${background}"/>${body}</svg>`
}

// Whether a point (board units) is on a shape, for clicking.
export function hits (s, px, py, slop = 6) {
  if (BOXES.has(s.type)) {
    if (s.type === 'ellipse') {
      const rx = s.w / 2; const ry = s.h / 2
      const dx = (px - (s.x + rx)) / (rx + slop); const dy = (py - (s.y + ry)) / (ry + slop)
      return dx * dx + dy * dy <= 1
    }
    return px >= s.x - slop && px <= s.x + s.w + slop && py >= s.y - slop && py <= s.y + s.h + slop
  }
  if (s.type === 'line' || s.type === 'arrow') return nearSegment(px, py, s.x, s.y, s.x + s.w, s.y + s.h) <= slop + 2
  if (s.type === 'pen') {
    const p = s.points || []
    for (let i = 2; i < p.length; i += 2) if (nearSegment(px, py, s.x + p[i - 2], s.y + p[i - 1], s.x + p[i], s.y + p[i + 1]) <= slop + 2) return true
    return false
  }
  const b = bounds(s)
  return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h
}

function nearSegment (px, py, x1, y1, x2, y2) {
  const dx = x2 - x1; const dy = y2 - y1
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len)) : 0
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}
