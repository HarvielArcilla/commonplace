// Ready-made boards for "New from a template".

import { addShape, STICKY_COLORS } from './model.js'

export const boardTemplates = [
  {
    id: 'whiteboard.retro',
    name: 'Retrospective',
    description: 'What went well, what to improve and what to try next',
    build: (ydoc) => ydoc.transact(() => {
      const cols = [['Went well', STICKY_COLORS[4]], ['To improve', STICKY_COLORS[1]], ['Try next', STICKY_COLORS[3]]]
      cols.forEach(([title, color], i) => {
        const x = i * 260
        addShape(ydoc, { type: 'text', x, y: 0, w: 220, h: 40, text: title, size: 26 })
        addShape(ydoc, { type: 'sticky', x, y: 60, w: 220, h: 140, color, text: '' })
        addShape(ydoc, { type: 'sticky', x, y: 220, w: 220, h: 140, color, text: '' })
      })
    })
  },
  {
    id: 'whiteboard.brainstorm',
    name: 'Brainstorm',
    description: 'One topic in the middle, ideas around it',
    build: (ydoc) => ydoc.transact(() => {
      addShape(ydoc, { type: 'ellipse', x: -110, y: -60, w: 220, h: 120, text: 'Topic', size: 24 })
      const n = 6
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2
        const x = Math.cos(a) * 330 - 80
        const y = Math.sin(a) * 230 - 70
        addShape(ydoc, { type: 'sticky', x, y, w: 160, h: 140, color: STICKY_COLORS[i % 6], text: '' })
        addShape(ydoc, { type: 'line', x: Math.cos(a) * 130, y: Math.sin(a) * 75, w: Math.cos(a) * 110, h: Math.sin(a) * 80 })
      }
    })
  }
]
