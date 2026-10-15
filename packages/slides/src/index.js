// CommonSlides app descriptor: what CommonDrive needs to create, preview,
// merge and restore presentations. The editor lives in the desktop app.

import * as Y from 'yjs'
import { initSlides, preview, thumbnail, slideIds, readSlide, plainText, slideMap, SLIDES, SLIDE_DATA, DECK } from './model.js'

// Conflict units: every element on every slide (plus the title). An
// element's signature covers where it is, how it looks and its text.
function units (ydoc) {
  const out = new Map()
  for (const slideId of slideIds(ydoc)) {
    for (const el of readSlide(ydoc, slideId).elements) {
      const { text, id, ...props } = el
      const words = text ? plainText(text) : ''
      out.set(`${slideId}|${id}`, { kind: 'element', sig: JSON.stringify({ ...props, words }), text: words || describe(el), props, words, prev: null })
    }
  }
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

const describe = (el) => (el.type === 'image' ? `Image${el.alt ? `: ${el.alt}` : ''}` : el.type === 'shape' ? `${el.shape || 'rect'} shape` : 'Empty text box')
const snapshotUnit = (u) => (u?.props ? JSON.stringify({ props: u.props, words: u.words }) : null)

// The owner's decision: one version's element (position, look and text),
// or 'both' (each version's text, one after the other, in one box).
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  const present = picked.filter((v) => v.exists)
  if (rec.kind === 'title') {
    if (present.length) ydoc.getMap('meta').set('title', present.map((v) => v.text).join(' / '))
    return
  }
  const [slideId, elId] = rec.unit.split('|')
  const elements = slideMap(ydoc, slideId)?.get('elements')
  if (!elements) return
  if (!present.length) { elements.delete(elId); return }
  const { props, words } = JSON.parse(present[0].snapshot)
  const el = new Y.Map()
  elements.set(elId, el)
  for (const [k, v] of Object.entries(props)) el.set(k, v)
  if (props.type !== 'image') {
    const frag = new Y.XmlFragment()
    el.set('text', frag)
    const text = choice === 'both' ? present.map((v) => JSON.parse(v.snapshot).words).join('\n') : words
    for (const line of String(text || '').split('\n')) {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText(line)])
      frag.push([p])
    }
  }
}

export const slidesApp = {
  type: 'slides',
  kind: 'slides',
  name: 'Presentation',
  description: 'Slides with text, shapes and images. Exports .pptx and PDF.',
  schemaVersion: 1,
  exports: ['pptx', 'pdf'],
  initContent (ydoc) { initSlides(ydoc) },
  preview,
  thumbnail,
  units,
  resolve,
  snapshotUnit,
  history: { roots: [{ name: SLIDES, type: 'array' }, { name: SLIDE_DATA, type: 'map' }, { name: DECK, type: 'map' }] }
}

export default slidesApp
