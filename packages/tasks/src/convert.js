// Exporting a task board as CSV or as a Markdown checklist.

import { readLists, cardsIn } from './model.js'

const cell = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

// names: userId -> display name, for the assignee column.
export function exportCsv (ydoc, names = {}) {
  const rows = [['List', 'Task', 'Done', 'Due', 'Assigned to', 'Notes']]
  for (const list of readLists(ydoc)) {
    for (const c of cardsIn(ydoc, list.id)) rows.push([list.name, c.title, c.done ? 'yes' : 'no', c.due || '', c.assignee ? names[c.assignee] || '' : '', c.notes])
  }
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n'
}

export function exportMarkdown (ydoc, title = 'Tasks', names = {}) {
  const out = [`# ${title}`, '']
  for (const list of readLists(ydoc)) {
    out.push(`## ${list.name || 'Untitled list'}`, '')
    const cards = cardsIn(ydoc, list.id)
    if (!cards.length) out.push('_Nothing here._')
    for (const c of cards) {
      const extra = [c.due ? `due ${c.due}` : '', c.assignee && names[c.assignee] ? `@${names[c.assignee]}` : ''].filter(Boolean).join(', ')
      out.push(`- [${c.done ? 'x' : ' '}] ${c.title || 'Untitled task'}${extra ? ` (${extra})` : ''}`)
      if (c.notes) for (const line of c.notes.split('\n')) out.push(`  ${line}`)
    }
    out.push('')
  }
  return out.join('\n')
}
