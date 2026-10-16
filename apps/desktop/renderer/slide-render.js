// Read-only slides, drawn the same way everywhere they appear: the strip of
// thumbnails, presenting (on this screen or another), printing and history.

import * as Y from 'yjs'
import { readSlide, theme, WIDTH, HEIGHT } from '@commonplace/slides/model'
import { el } from './ui.js'

// A slide drawn at `k` times its size.
export function scaled (node, k) {
  node.style.transform = `scale(${k})`
  node.style.transformOrigin = '0 0'
  return el('div', { class: 'slide-scaled', style: `width:${WIDTH * k}px;height:${HEIGHT * k}px` }, node)
}

// The color of a box's text: its own, the theme's title color for titles,
// or (empty) the slide's text color.
export const textColor = (e, t) => e.color || (e.role === 'title' && t.title !== t.fg ? t.title : '')

export function renderSlide (ydoc, slideId) {
  const s = readSlide(ydoc, slideId)
  const t = theme(ydoc)
  const node = el('div', { class: 'slide-static', style: `background:${s?.bg || '#fff'};font-family:${t.font};color:${t.fg}` })
  for (const e of s?.elements || []) {
    const color = textColor(e, t)
    const box = el('div', {
      class: `slide-el slide-${e.type}`,
      'data-valign': e.valign || 'top',
      'data-shape': e.shape || '',
      style: `left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${e.z || 0};font-size:${e.size || 20}px;text-align:${e.align || 'left'};${e.bold ? 'font-weight:700;' : ''}${color ? `color:${color};` : ''}${e.type === 'shape' ? `background:${e.fill || 'transparent'};${e.stroke ? `border-color:${e.stroke};` : ''}` : ''}`
    })
    if (e.type === 'image') box.append(el('img', { src: e.src, alt: e.alt || '', draggable: 'false' }))
    if (e.text) box.append(el('div', { class: 'slide-el-text' }, el('div', { class: 'slide-text' }, ...fragmentToDom(e.text))))
    node.append(box)
  }
  return node
}

// Rich text from a fragment as DOM nodes (text is set as text, never HTML).
function fragmentToDom (frag) {
  const tags = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', hardBreak: 'br' }
  const walk = (node) => {
    if (node instanceof Y.XmlText) {
      return node.toDelta().map((d) => {
        if (typeof d.insert !== 'string') return null
        let out = document.createTextNode(d.insert)
        const a = d.attributes || {}
        const wrap = (tag, style) => { const w = document.createElement(tag); if (style) w.style.cssText = style; w.append(out); out = w }
        if (a.bold) wrap('strong')
        if (a.italic) wrap('em')
        if (a.underline) wrap('u')
        if (a.strike) wrap('s')
        if (a.textStyle) wrap('span', `${a.textStyle.color ? `color:${a.textStyle.color};` : ''}${a.textStyle.fontSize ? `font-size:${a.textStyle.fontSize};` : ''}`)
        return out
      }).filter(Boolean)
    }
    const tag = tags[node.nodeName]
    if (!tag) return node.toArray().flatMap(walk)
    const n = document.createElement(tag)
    for (const c of node.toArray().flatMap(walk)) n.append(c)
    if (tag === 'p' && !n.childNodes.length) n.append(document.createElement('br'))
    return [n]
  }
  return frag.toArray().flatMap(walk)
}
