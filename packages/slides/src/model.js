// CommonSlides data model, on top of the file's Y.Doc. No DOM code.
//
//   ydoc.getArray('slides')     slide ids, in order
//   ydoc.getMap('slideData')    slideId -> Y.Map {
//                                 bg:       background color
//                                 elements: Y.Map elementId -> Y.Map {
//                                   type: 'text' | 'image' | 'shape'
//                                   x, y, w, h: position on a 960 x 540 slide
//                                   z: stacking order
//                                   text:  Y.XmlFragment (text boxes and shapes; rich text)
//                                   size:  base font size (points on the slide)
//                                   align: 'left' | 'center' | 'right'
//                                   valign: 'top' | 'middle' | 'bottom'
//                                   color: text color
//                                   fill, stroke: colors (shapes); shape: 'rect' | 'ellipse' | 'round'
//                                   src, alt: image data URL and description
//                                   role: 'title' | 'body' | null (placeholder kind)
//                                 }
//                                 notes:    Y.Text (speaker notes)
//                               }
//   ydoc.getMap('deck')         { font, fg, accent }: the deck's theme
//
// Each element is its own map and each text its own fragment, so two
// people moving different boxes, or typing in different boxes, never
// collide; two people dragging the same box end up wherever the last move
// left it.

import * as Y from 'yjs'

export const SLIDES = 'slides'
export const SLIDE_DATA = 'slideData'
export const DECK = 'deck'
export const WIDTH = 960
export const HEIGHT = 540
export const DEFAULT_THEME = { font: 'Arial, Helvetica, sans-serif', fg: '#1f2430', accent: '#284b8c' }

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

export const LAYOUTS = {
  title: { name: 'Title slide', elements: [{ role: 'title', x: 80, y: 170, w: 800, h: 110, size: 44, align: 'center', valign: 'bottom', bold: true }, { role: 'body', x: 80, y: 295, w: 800, h: 70, size: 22, align: 'center', valign: 'top' }] },
  content: { name: 'Title and text', elements: [{ role: 'title', x: 60, y: 36, w: 840, h: 80, size: 34, align: 'left', valign: 'middle', bold: true }, { role: 'body', x: 60, y: 130, w: 840, h: 370, size: 22, align: 'left', valign: 'top', bullets: true }] },
  section: { name: 'Section header', elements: [{ role: 'title', x: 80, y: 200, w: 800, h: 140, size: 40, align: 'left', valign: 'middle', bold: true }] },
  blank: { name: 'Blank', elements: [] }
}

export function initSlides (ydoc) {
  ydoc.transact(() => { addSlide(ydoc, { layout: 'title' }) })
}

// Adds a slide from a layout, after `after` (or at the end). Returns its id.
export function addSlide (ydoc, { layout = 'content', after = null, bg = '#ffffff' } = {}) {
  const id = newId()
  ydoc.transact(() => {
    const slide = new Y.Map()
    ydoc.getMap(SLIDE_DATA).set(id, slide)
    slide.set('bg', bg)
    slide.set('elements', new Y.Map())
    slide.set('notes', new Y.Text())
    for (const spec of LAYOUTS[layout]?.elements || []) addText(ydoc, id, spec)
    const order = ydoc.getArray(SLIDES)
    const at = after ? order.toArray().indexOf(after) + 1 : order.length
    order.insert(at > 0 ? at : order.length, [id])
  })
  return id
}

export const slideMap = (ydoc, id) => ydoc.getMap(SLIDE_DATA).get(id) || null

export function slideIds (ydoc) {
  const data = ydoc.getMap(SLIDE_DATA)
  return [...new Set(ydoc.getArray(SLIDES).toArray())].filter((id) => data.has(id))
}

// A text box (or a placeholder from a layout). `bold` makes the box's base
// text bold (titles); runs can still be formatted on their own.
export function addText (ydoc, slideId, { role = null, x = 280, y = 220, w = 400, h = 80, size = 20, align = 'left', valign = 'top', bold = false, bullets = false, text = '' } = {}) {
  const frag = new Y.XmlFragment()
  return addElement(ydoc, slideId, { type: 'text', role, x, y, w, h, size, align, valign, bold: bold || undefined, text: frag }, () => {
    const p = new Y.XmlElement('paragraph')
    const t = new Y.XmlText()
    p.insert(0, [t])
    if (bullets) {
      const item = new Y.XmlElement('listItem')
      const list = new Y.XmlElement('bulletList')
      item.insert(0, [p])
      list.insert(0, [item])
      frag.insert(0, [list])
    } else {
      frag.insert(0, [p])
    }
    if (text) t.insert(0, text)
  })
}

export function addShape (ydoc, slideId, { shape = 'rect', x = 330, y = 170, w = 300, h = 200, fill = '#d6e4fb', stroke = null } = {}) {
  return addElement(ydoc, slideId, { type: 'shape', shape, x, y, w, h, fill, stroke, size: 20, align: 'center', valign: 'middle', text: new Y.XmlFragment() })
}

export function addImage (ydoc, slideId, { src, alt = '', w, h }) {
  // Fit large images onto the slide, keeping their shape.
  const scale = Math.min(1, (WIDTH * 0.8) / w, (HEIGHT * 0.8) / h)
  const width = Math.round(w * scale)
  const height = Math.round(h * scale)
  return addElement(ydoc, slideId, { type: 'image', src, alt, x: Math.round((WIDTH - width) / 2), y: Math.round((HEIGHT - height) / 2), w: width, h: height })
}

function addElement (ydoc, slideId, props, after) {
  const slide = slideMap(ydoc, slideId)
  if (!slide) return null
  const id = newId()
  ydoc.transact(() => {
    const el = new Y.Map()
    const elements = slide.get('elements')
    elements.set(id, el)
    const z = Math.max(0, ...[...elements.values()].map((e) => e.get?.('z') || 0)) + 1
    for (const [k, v] of Object.entries({ ...props, z })) if (v !== undefined) el.set(k, v)
    after?.()
  })
  return id
}

export function updateElement (ydoc, slideId, elId, patch) {
  const el = slideMap(ydoc, slideId)?.get('elements').get(elId)
  if (!el) return
  ydoc.transact(() => { for (const [k, v] of Object.entries(patch)) (v == null ? el.delete(k) : el.set(k, v)) })
}

export function deleteElement (ydoc, slideId, elId) {
  slideMap(ydoc, slideId)?.get('elements').delete(elId)
}

// Front or back of the stack.
export function restack (ydoc, slideId, elId, toFront) {
  const elements = slideMap(ydoc, slideId)?.get('elements')
  if (!elements?.has(elId)) return
  const zs = [...elements.values()].map((e) => e.get('z') || 0)
  elements.get(elId).set('z', toFront ? Math.max(...zs) + 1 : Math.min(...zs) - 1)
}

export function deleteSlide (ydoc, id) {
  if (slideIds(ydoc).length <= 1) return false
  const order = ydoc.getArray(SLIDES)
  ydoc.transact(() => {
    for (let i = order.length - 1; i >= 0; i--) if (order.get(i) === id) order.delete(i, 1)
    ydoc.getMap(SLIDE_DATA).delete(id)
  })
  return true
}

export function moveSlide (ydoc, id, to) {
  const order = ydoc.getArray(SLIDES)
  const from = order.toArray().indexOf(id)
  if (from < 0 || from === to) return
  ydoc.transact(() => { order.delete(from, 1); order.insert(Math.max(0, Math.min(to, order.length)), [id]) })
}

export function duplicateSlide (ydoc, id) {
  const src = slideMap(ydoc, id)
  if (!src) return null
  const copy = newId()
  ydoc.transact(() => {
    ydoc.getMap(SLIDE_DATA).set(copy, src.clone())
    const order = ydoc.getArray(SLIDES)
    order.insert(order.toArray().indexOf(id) + 1, [copy])
  })
  return copy
}

export function theme (ydoc) {
  const deck = ydoc.getMap(DECK)
  return { font: deck.get('font') || DEFAULT_THEME.font, fg: deck.get('fg') || DEFAULT_THEME.fg, accent: deck.get('accent') || DEFAULT_THEME.accent }
}

// ---- reading -------------------------------------------------------------------

// Plain objects for one slide, elements in stacking order.
export function readSlide (ydoc, id) {
  const slide = slideMap(ydoc, id)
  if (!slide) return null
  const elements = [...slide.get('elements').entries()].map(([elId, m]) => {
    const props = {}
    for (const [k, v] of m.entries()) if (!(v instanceof Y.AbstractType)) props[k] = v
    return { id: elId, ...props, text: m.get('text') || null }
  }).sort((a, b) => (a.z || 0) - (b.z || 0))
  return { id, bg: slide.get('bg') || '#ffffff', elements, notes: slide.get('notes')?.toString() || '' }
}

// Text of a rich-text fragment, one line per paragraph.
export function plainText (frag) {
  if (!frag) return ''
  const lines = []
  const walk = (node) => {
    if (node instanceof Y.XmlText) return node.toString().replace(/<[^>]+>/g, '')
    if (node instanceof Y.XmlElement && ['paragraph', 'heading'].includes(node.nodeName)) { lines.push(node.toArray().map(walk).join('')); return '' }
    node.toArray?.().forEach(walk)
    return ''
  }
  frag.toArray().forEach(walk)
  return lines.join('\n')
}

// Paragraphs as runs, for export: [{ bullet, runs: [{ text, bold, italic, underline, color, size }] }].
export function paragraphs (frag) {
  const out = []
  const walk = (node, bullet) => {
    if (node instanceof Y.XmlElement && ['paragraph', 'heading'].includes(node.nodeName)) {
      const runs = []
      for (const child of node.toArray()) {
        if (!(child instanceof Y.XmlText)) continue
        for (const d of child.toDelta()) {
          if (typeof d.insert !== 'string') continue
          const a = d.attributes || {}
          runs.push({ text: d.insert, bold: Boolean(a.bold), italic: Boolean(a.italic), underline: Boolean(a.underline), color: a.textStyle?.color || null, size: a.textStyle?.fontSize ? parseFloat(a.textStyle.fontSize) : null })
        }
      }
      out.push({ bullet, runs })
      return
    }
    const isList = node instanceof Y.XmlElement && (node.nodeName === 'bulletList' || node.nodeName === 'orderedList')
    node.toArray?.().forEach((c) => walk(c, isList ? (node.nodeName === 'orderedList' ? 'number' : 'bullet') : bullet))
  }
  frag?.toArray().forEach((n) => walk(n, null))
  return out
}

export function preview (ydoc) {
  return slideIds(ydoc).slice(0, 3).map((id) => readSlide(ydoc, id).elements.filter((e) => e.text).map((e) => plainText(e.text)).join(' ')).join(' · ').replace(/\s+/g, ' ').trim().slice(0, 200)
}

// The first slide in brief, for the Drive thumbnail.
export function thumbnail (ydoc) {
  const [first] = slideIds(ydoc)
  const s = first && readSlide(ydoc, first)
  if (!s) return null
  return {
    bg: s.bg,
    count: slideIds(ydoc).length,
    boxes: s.elements.slice(0, 8).map((e) => ({ type: e.type, x: e.x, y: e.y, w: e.w, h: e.h, fill: e.fill || null, text: e.text ? plainText(e.text).slice(0, 80) : '', size: e.size || 20, align: e.align || 'left' }))
  }
}
