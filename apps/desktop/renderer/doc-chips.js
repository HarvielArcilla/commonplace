// Smart chips in commonDocs, and sending action items to commonTasks.
//
// Typing @ offers people with access, files in your Drive and dates;
// picking one places a chip. Clicking a chip opens its file, puts its date
// on one of your calendars, or says whether its person can open this file.
// "Send to a task board" turns the selected lines into cards, with person
// chips as who it's assigned to and date chips as due dates.

import { actionItems, dayLabel } from '@commonplace/docs/editor'
import { dayKey, addDays } from '@commonplace/calendar/model'
import { el, toast, openMenu, dialog, selectField, plural, cleanError } from './ui.js'
import { state, cp, openFile } from './state.js'

const MAX_FILES = 6
const KIND_WORDS = { markdown: 'Document', paged: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', tasks: 'Task board', calendar: 'Calendar', whiteboard: 'Whiteboard', form: 'Form', file: 'File' }

const fileOf = (docId) => state.files.find((f) => f.docId === docId)

// ---- the @ menu ------------------------------------------------------------------

// Watches the editor for "@words" before the cursor and offers chips.
export function attachChipMenu (o) {
  const editor = o.editor
  let menu = null
  let items = []
  let active = 0
  let range = null

  const close = () => { menu?.remove(); menu = null; range = null }
  const pick = (item) => {
    if (!range) return
    const { from, to } = range
    close()
    editor.chain().focus().deleteRange({ from, to }).insertChip(item.attrs).run()
  }
  const draw = () => {
    menu.replaceChildren(...items.map((item, i) => el('button', {
      type: 'button',
      role: 'option',
      class: `chip-option${i === active ? ' active' : ''}`,
      'aria-selected': String(i === active),
      onmousedown: (e) => { e.preventDefault(); pick(item) }
    }, el('span', { class: `chip-dot cp-chip-${item.attrs.kind}` }), el('span', { class: 'chip-option-label' }, item.attrs.label), item.hint ? el('span', { class: 'chip-option-hint' }, item.hint) : null)))
  }
  const check = () => {
    if (!editor.isEditable || state.open !== o) { close(); return }
    const { $from, empty } = editor.state.selection
    const before = empty ? $from.parent.textBetween(Math.max(0, $from.parentOffset - 40), $from.parentOffset, null, '￼') : ''
    const m = /(?:^|\s)@([^@\n￼]{0,30})$/.exec(before)
    if (!m) { close(); return }
    const query = m[1]
    items = suggestions(o, query)
    if (!items.length) { close(); return }
    range = { from: $from.pos - query.length - 1, to: $from.pos }
    active = Math.min(active, items.length - 1)
    if (!menu) {
      menu = el('div', { class: 'chip-menu', role: 'listbox', 'aria-label': 'Insert a person, file or date' })
      document.body.append(menu)
      active = 0
    }
    draw()
    const at = editor.view.coordsAtPos(range.from)
    menu.style.left = `${Math.min(at.left, window.innerWidth - menu.offsetWidth - 8)}px`
    menu.style.top = `${at.bottom + menu.offsetHeight + 8 > window.innerHeight ? at.top - menu.offsetHeight - 6 : at.bottom + 6}px`
  }
  const onKey = (e) => {
    if (!menu) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      draw()
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      pick(items[active])
    } else if (e.key === 'Escape') { e.preventDefault(); close() }
  }
  editor.on('transaction', check)
  editor.on('blur', close)
  editor.view.dom.addEventListener('keydown', onKey, true)
  o.cleanup.push(() => { editor.off('transaction', check); editor.off('blur', close); editor.view.dom.removeEventListener('keydown', onKey, true); close() })
}

// People, files and dates matching what's typed after @.
function suggestions (o, query) {
  const q = query.trim().toLowerCase()
  const has = (words) => !q || words.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || words.toLowerCase().includes(q)
  const out = []
  const file = fileOf(o.docId)
  const people = [{ userId: state.me.userId, name: state.me.name }, ...(file?.members || []).filter((m) => m.userId !== state.me.userId && m.name && !m.pending)]
  for (const p of people) if (has(p.name)) out.push({ attrs: { kind: 'person', ref: p.userId, label: p.name }, hint: p.userId === state.me.userId ? 'You' : 'Has access' })
  for (const d of dateSuggestions(q)) out.push(d)
  const files = state.files.filter((f) => f.kind !== 'folder' && f.docId !== o.docId && has(f.title || 'Untitled'))
  for (const f of files.slice(0, MAX_FILES)) out.push({ attrs: { kind: 'file', ref: f.docId, label: f.title || 'Untitled' }, hint: KIND_WORDS[f.kind] || 'File' })
  return out.slice(0, 12)
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

function dateSuggestions (q) {
  const today = new Date()
  const day = (d, hint) => ({ attrs: { kind: 'date', ref: dayKey(d), label: dayLabel(dayKey(d), today) }, hint })
  const named = [['today', 0], ['tomorrow', 1], ['yesterday', -1]].map(([word, n]) => [word, addDays(today, n)])
  for (let n = 1; n <= 7; n++) { const d = addDays(today, n); named.push([WEEKDAYS[d.getDay()], d]) }
  if (!q) return [day(named[0][1], 'Today'), day(named[1][1], 'Tomorrow')]
  const out = named.filter(([word]) => word.startsWith(q)).slice(0, 3).map(([word, d]) => day(d, word[0].toUpperCase() + word.slice(1)))
  // A typed date: 2026-10-20, 10/20, Oct 20, 20 October.
  const typed = parseDay(q, today)
  if (typed) out.unshift(day(typed, 'Date'))
  return out
}

function parseDay (q, today) {
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(q)
  if (m) return valid(+m[1], +m[2], +m[3])
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(q)
  if (m) return valid(m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : today.getFullYear(), +m[1], +m[2])
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
  m = /^([a-z]{3,9})\.? (\d{1,2})(?:,? (\d{4}))?$/.exec(q) || /^(\d{1,2}) ([a-z]{3,9})(?: (\d{4}))?$/.exec(q)
  if (!m) return null
  const [word, dayNum] = /^\d/.test(m[1]) ? [m[2], m[1]] : [m[1], m[2]]
  const month = months.indexOf(word.slice(0, 3)) + 1
  return month ? valid(m[3] ? +m[3] : today.getFullYear(), month, +dayNum) : null
}

function valid (y, mo, d) {
  const date = new Date(y, mo - 1, d)
  return date.getMonth() === mo - 1 && date.getDate() === d ? date : null
}

// ---- clicking a chip ---------------------------------------------------------------------

export function openChip (o, attrs, target) {
  const anchor = target?.closest?.('.cp-chip') || target
  if (attrs.kind === 'file') {
    if (fileOf(attrs.ref)) { openFile(attrs.ref); return }
    toast(`“${attrs.label}” isn’t in your Drive. Ask whoever placed it for an invite.`)
    return
  }
  if (attrs.kind === 'person') {
    const member = (fileOf(o.docId)?.members || []).find((m) => m.userId === attrs.ref)
    const words = attrs.ref === state.me.userId ? 'That’s you.' : member ? `${member.name} can ${member.role === 'viewer' ? 'view' : member.role === 'respondent' ? 'answer' : 'edit'} this file.` : `${attrs.label} doesn’t have this file. Share it with them from Share.`
    openMenu(anchor, [{ heading: attrs.label }, { label: words, disabled: true }], { label: attrs.label })
    return
  }
  if (attrs.kind === 'date') {
    openMenu(anchor, [
      { heading: attrs.label },
      { label: 'Add to a calendar…', onSelect: () => addToCalendar(o, attrs) }
    ], { label: attrs.label })
  }
}

async function addToCalendar (o, attrs) {
  const calendars = await cp.calendars()
  if (!calendars.length) { toast('Make a calendar first (New → Calendar), then add dates to it.'); return }
  const line = lineAround(o, attrs)
  const res = await dialog({
    title: `Add to a calendar on ${attrs.label}`,
    fields: [
      el('label', { class: 'field' }, 'Event', el('input', { name: 'title', value: line, maxlength: '300', autocomplete: 'off' })),
      selectField({ label: 'Calendar', name: 'calendar', value: calendars[0].docId, options: calendars.map((c) => ({ value: c.docId, label: c.title })) }),
      el('p', { class: 'fineprint-plain' }, 'Everyone the calendar is shared with will see it.')
    ],
    confirm: 'Add event',
    validate: (d) => (d.title.trim() ? null : 'Give the event a name.')
  })
  if (res?.action !== 'confirm') return
  try {
    await cp.addEvent(res.data.calendar, { title: res.data.title.trim(), day: attrs.ref })
    toast(`Added to “${calendars.find((c) => c.docId === res.data.calendar)?.title}”`)
  } catch (err) { toast(cleanError(err)) }
}

// The words of the line a date chip sits in, as an event's name.
function lineAround (o, attrs) {
  const { doc } = o.editor.state
  let found = ''
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return !found
    let has = false
    node.forEach((c) => { if (c.type.name === 'chip' && c.attrs.ref === attrs.ref && c.attrs.kind === 'date') has = true })
    if (has) found = actionItems(doc, pos, pos + node.nodeSize)[0]?.title || ''
    return false
  })
  return found
}

// ---- action items to a task board ---------------------------------------------------------

export async function sendToTasks (o) {
  const { state: s } = o.editor
  const { from, to, empty } = s.selection
  const items = empty ? actionItems(s.doc, s.selection.$from.before(), s.selection.$from.after()) : actionItems(s.doc, from, to)
  if (!items.length) { toast('Select the lines to send. Each line becomes a task.'); return }
  let boards
  try { boards = await cp.taskBoards() } catch (err) { toast(cleanError(err)); return }
  if (!boards.length) { toast('Make a task board first (New → Task board), then send tasks to it.'); return }
  const board = selectField({ label: 'Board', name: 'board', value: boards[0].docId, options: boards.map((b) => ({ value: b.docId, label: b.title })) })
  const list = selectField({ label: 'List', name: 'list', value: boards[0].lists[0]?.id, options: boards[0].lists.map((l) => ({ value: l.id, label: l.name })) })
  board.querySelector('select').addEventListener('change', (e) => {
    const b = boards.find((x) => x.docId === e.target.value)
    list.querySelector('select').replaceChildren(...(b?.lists || []).map((l) => el('option', { value: l.id }, l.name)))
  })
  const names = new Map((fileOf(o.docId)?.members || []).map((m) => [m.userId, m.name]))
  names.set(state.me.userId, 'you')
  const preview = el('ul', { class: 'send-preview' }, ...items.slice(0, 8).map((x) => el('li', {},
    el('span', {}, x.title),
    x.assignee || x.due ? el('span', { class: 'send-meta' }, [x.assignee ? `for ${names.get(x.assignee) || 'someone'}` : '', x.due ? `due ${dayLabel(x.due)}` : ''].filter(Boolean).join(', ')) : null)),
  items.length > 8 ? el('li', { class: 'send-more' }, `and ${items.length - 8} more`) : null)
  const res = await dialog({
    title: `Send ${plural(items.length, 'task')} to a board`,
    wide: true,
    fields: [preview, el('div', { class: 'ev-when' }, board, list), el('p', { class: 'fineprint-plain' }, 'People in a line become who it’s assigned to, and dates become due dates. Everyone the board is shared with will see the tasks.')],
    confirm: 'Send'
  })
  if (res?.action !== 'confirm') return
  try {
    const title = fileOf(o.docId)?.title || 'Untitled'
    const done = await cp.addCards(res.data.board, res.data.list, items, { docId: o.docId, title })
    toast(`Added ${plural(done.added, 'task')} to ${done.list} on “${boards.find((b) => b.docId === res.data.board)?.title}”`)
  } catch (err) { toast(cleanError(err)) }
}
