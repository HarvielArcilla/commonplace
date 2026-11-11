// commonBoard app descriptor: what commonDrive needs to create, preview,
// merge and restore whiteboards. The board itself lives in the desktop app.

import * as Y from 'yjs'
import { initBoard, preview, thumbnail, allShapes, HAS_TEXT, SHAPES } from './model.js'
import { boardTemplates } from './templates.js'
import { chosenVersions } from '@commonplace/core/container'

// Conflict units: each shape. A shape's signature covers its
// place, look and text.
function units (ydoc) {
  const out = new Map()
  for (const s of allShapes(ydoc)) {
    const { id, ...props } = s
    out.set(`shape|${id}`, { kind: 'shape', sig: JSON.stringify(props), text: s.text || `${s.type} shape`, props, prev: null })
  }
  return out
}

const snapshotUnit = (u) => (u?.props ? JSON.stringify(u.props) : null)

// The owner's decision: one version of a shape; 'both' keeps both, the
// second a little offset.
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const present = chosenVersions(rec, choice)
  const id = rec.unit.split('|')[1]
  const shapes = ydoc.getMap(SHAPES)
  if (!present.length) { shapes.delete(id); return }
  present.forEach((v, n) => {
    const props = JSON.parse(v.snapshot)
    const s = new Y.Map()
    shapes.set(n === 0 ? id : `${id}-${n}`, s)
    for (const [k, val] of Object.entries(props)) {
      if (k === 'text') continue
      s.set(k, n && (k === 'x' || k === 'y') ? val + 24 * n : val)
    }
    if (HAS_TEXT.has(props.type)) { const t = new Y.Text(); t.insert(0, props.text || ''); s.set('text', t) }
  })
}

export const whiteboardApp = {
  type: 'whiteboard',
  kind: 'whiteboard',
  name: 'Whiteboard',
  description: 'An open canvas for sticky notes, shapes, arrows and drawing, with everyone’s cursor. Exports .svg and .png.',
  schemaVersion: 1,
  exports: ['svg', 'png'],
  initContent (ydoc) { initBoard(ydoc) },
  preview,
  thumbnail,
  units,
  resolve,
  snapshotUnit,
  templates: boardTemplates,
  history: { roots: [{ name: SHAPES, type: 'map' }] }
}

export default whiteboardApp
