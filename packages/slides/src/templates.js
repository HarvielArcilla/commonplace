// Ready-made decks for "New from a template".

import * as Y from 'yjs'
import { addSlide, slideMap, DECK, NEW_DECK_FONT } from './model.js'

// Puts text into a slide's placeholder: one line per paragraph, or bullets.
function say (ydoc, slideId, role, lines) {
  const els = slideMap(ydoc, slideId).get('elements')
  const box = [...els.values()].find((m) => m.get('role') === role)
  const frag = box?.get('text')
  if (!frag) return
  const para = (s) => { const p = new Y.XmlElement('paragraph'); const t = new Y.XmlText(); if (s) t.insert(0, s); p.insert(0, [t]); return p }
  frag.delete(0, frag.length)
  if (box.get('role') === 'body' && Array.isArray(lines) && lines.length > 1) {
    const list = new Y.XmlElement('bulletList')
    list.insert(0, lines.map((s) => { const li = new Y.XmlElement('listItem'); li.insert(0, [para(s)]); return li }))
    frag.insert(0, [list])
  } else {
    frag.insert(0, [].concat(lines).map(para))
  }
}

function deck (ydoc, slides, theme = {}) {
  ydoc.transact(() => {
    const d = ydoc.getMap(DECK)
    d.set('font', theme.font || NEW_DECK_FONT)
    if (theme.accent) d.set('accent', theme.accent)
    for (const s of slides) {
      const id = addSlide(ydoc, { layout: s.layout, bg: s.bg || '#ffffff' })
      if (s.title != null) say(ydoc, id, 'title', s.title)
      if (s.body != null) say(ydoc, id, 'body', s.body)
      if (s.notes) slideMap(ydoc, id).get('notes').insert(0, s.notes)
    }
  })
}

export const slideTemplates = [
  {
    id: 'slides.update',
    name: 'Project update',
    description: 'Where things stand, what’s next and what you need',
    build: (ydoc) => deck(ydoc, [
      { layout: 'title', title: 'Project update', body: 'Team name · Date' },
      { layout: 'content', title: 'Where we are', body: ['What shipped since last time', 'What’s in progress', 'How we’re doing against the plan'] },
      { layout: 'content', title: 'What’s next', body: ['The next milestone and its date', 'Who is doing what', 'What could slow us down'] },
      { layout: 'content', title: 'What we need', body: ['Decisions', 'Help from other teams'] },
      { layout: 'section', title: 'Questions?', bg: '#f3f5fa' }
    ])
  },
  {
    id: 'slides.pitch',
    name: 'Pitch',
    description: 'Problem, idea, how it works and the ask',
    build: (ydoc) => deck(ydoc, [
      { layout: 'title', title: 'The idea, in a few words', body: 'Your name', bg: '#f7f3ea' },
      { layout: 'content', title: 'The problem', body: ['Who has it', 'What it costs them today'], notes: 'Tell one person’s story.' },
      { layout: 'content', title: 'Our answer', body: ['What it is', 'Why it works now'] },
      { layout: 'content', title: 'How it works', body: ['Step one', 'Step two', 'Step three'] },
      { layout: 'content', title: 'The ask', body: ['What we need', 'What happens next'] }
    ], { accent: '#9a3d2e' })
  }
]
