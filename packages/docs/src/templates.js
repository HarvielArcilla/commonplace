// Ready-made documents for "New from a template". Each builds the content
// tree (ProseMirror nodes as Yjs XML) into an empty file.

import * as Y from 'yjs'
import { DEFAULT_PAGE } from './page.js'
import { CONTENT_FIELD } from './index.js'

// Inline content: 'plain', or ['text', { bold: {} }] for marks.
const run = (part) => {
  const t = new Y.XmlText()
  const [s, marks] = Array.isArray(part) ? part : [part, undefined]
  if (s) t.insert(0, s, marks)
  return t
}
const node = (name, attrs = {}, children = []) => {
  const n = new Y.XmlElement(name)
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
  n.insert(0, children)
  return n
}
const p = (...parts) => node('paragraph', {}, parts.map(run))
const h = (level, s) => node('heading', { level }, [run(s)])
const ul = (items) => node('bulletList', {}, items.map((i) => node('listItem', {}, [p(i)])))
const ol = (items) => node('orderedList', { start: 1 }, items.map((i) => node('listItem', {}, [p(i)])))
const table = (head, rows) => node('table', {}, [
  node('tableRow', {}, head.map((c) => node('tableHeader', { colspan: 1, rowspan: 1 }, [p(c)]))),
  ...rows.map((r) => node('tableRow', {}, r.map((c) => node('tableCell', { colspan: 1, rowspan: 1 }, [p(c)]))))
])
const B = { bold: {} }
const I = { italic: {} }

function fill (ydoc, blocks, { paged = false } = {}) {
  ydoc.transact(() => {
    if (paged) ydoc.getMap('page').set('setup', { ...DEFAULT_PAGE, margins: { ...DEFAULT_PAGE.margins } })
    ydoc.getXmlFragment(CONTENT_FIELD).insert(0, blocks)
  })
}

export const pagedTemplates = [
  {
    id: 'paged.meeting',
    name: 'Meeting notes',
    description: 'Agenda, notes, decisions and who does what by when',
    build: (ydoc) => fill(ydoc, [
      h(1, 'Meeting notes'),
      p(['Date: ', B], 'Thursday', ['   Attendees: ', B], 'Everyone who came'),
      h(2, 'Agenda'),
      ol(['Where we are', 'What’s blocking us', 'Next steps']),
      h(2, 'Notes'),
      p(''),
      h(2, 'Decisions'),
      ul(['']),
      h(2, 'Action items'),
      table(['What', 'Who', 'By when'], [['', '', ''], ['', '', ''], ['', '', '']])
    ], { paged: true })
  },
  {
    id: 'paged.brief',
    name: 'Project brief',
    description: 'Why, what, when and what could go wrong, on one page',
    build: (ydoc) => fill(ydoc, [
      h(1, 'Project brief'),
      p(['One sentence on what this project is and who it’s for.', I]),
      h(2, 'Why now'),
      p(''),
      h(2, 'Goals'),
      ul(['', '']),
      h(2, 'In and out of scope'),
      table(['In scope', 'Out of scope'], [['', ''], ['', '']]),
      h(2, 'Milestones'),
      table(['Milestone', 'Date', 'Owner'], [['', '', ''], ['', '', ''], ['', '', '']]),
      h(2, 'Risks'),
      ul([''])
    ], { paged: true })
  },
  {
    id: 'paged.letter',
    name: 'Letter',
    description: 'A plain, well-spaced letter',
    build: (ydoc) => fill(ydoc, [
      p('Your name'),
      p('Street and number'),
      p('Town and postcode'),
      p(''),
      p('Date'),
      p(''),
      p('Dear …,'),
      p(''),
      p(''),
      p('Kind regards,'),
      p(''),
      p('Your name')
    ], { paged: true })
  }
]

export const markdownTemplates = [
  {
    id: 'markdown.weekly',
    name: 'Weekly notes',
    description: 'Priorities, notes and what carries over',
    build: (ydoc) => fill(ydoc, [
      h(1, 'This week'),
      h(2, 'Priorities'),
      ol(['', '', '']),
      h(2, 'Notes'),
      p(''),
      h(2, 'Carry over to next week'),
      ul([''])
    ])
  },
  {
    id: 'markdown.reading',
    name: 'Reading notes',
    description: 'Summary, quotes and questions for a book or article',
    build: (ydoc) => fill(ydoc, [
      h(1, 'Title, author'),
      h(2, 'In one paragraph'),
      p(''),
      h(2, 'Passages worth keeping'),
      ul(['']),
      h(2, 'Questions it raised'),
      ul([''])
    ])
  }
]
