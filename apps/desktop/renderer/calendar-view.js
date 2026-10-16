// commonCalendar window: a month or a week, events you can add, open,
// change and drag to another day. Everything edits the file's Y.Doc through
// @commonplace/calendar/model; times show in this computer's time zone.

import * as Y from 'yjs'
import {
  occurrences, addEvent, updateEvent, deleteEvent, skipOccurrence, readEvent, dayKey, fromDayKey, addDays,
  COLORS, REPEATS, EVENTS
} from '@commonplace/calendar/model'
import { $, el, svg, dialog, selectField, toast } from './ui.js'
import { toolButton, labeledButton, toolbarGroups, setToolbar } from './toolbar.js'
import { countBy, badges } from './comment-marks.js'
import { cp, openFile } from './state.js'

const ICON = {
  prev: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m10 3-5 5 5 5"/></svg>',
  next: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 5 5-5 5"/></svg>',
  add: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  undo: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4 2 7l3 3"/><path d="M2.5 7H10a3.5 3.5 0 0 1 0 7H7"/></svg>',
  redo: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="m11 4 3 3-3 3"/><path d="M13.5 7H6a3.5 3.5 0 0 0 0 7h3"/></svg>'
}
const VIEW_KEY = 'commonplace.calendarView'
const TASKS_KEY = 'commonplace.calendarTasks'
const HOUR_PX = 44
const DRAG = 'application/x-commonplace-event'
const REMINDERS = [['', 'No reminder'], ['0', 'At the start'], ['5', '5 minutes before'], ['10', '10 minutes before'], ['30', '30 minutes before'], ['60', '1 hour before'], ['1440', '1 day before']]

export function mountCalendar (o) {
  const v = {
    o,
    ydoc: o.ydoc,
    writable: true,
    layout: (() => { try { return localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'month' } catch { return 'month' } })(),
    cursor: new Date(), // a day in the period shown
    // Cards with due dates from your task boards: yours to show or hide,
    // read from boards you already have, never copied into the calendar.
    showTasks: (() => { try { return localStorage.getItem(TASKS_KEY) !== 'off' } catch { return true } })(),
    tasks: [],
    undo: new Y.UndoManager([o.ydoc.getMap(EVENTS)], { trackedOrigins: new Set([null]) })
  }
  v.root = el('div', { class: 'cal-app' })
  $('#desk').replaceChildren(v.root)
  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); o.refreshMargin() }) }
  o.ydoc.getMap(EVENTS).observeDeep(schedule)
  // Keep "now" current in the week view.
  const tick = setInterval(() => { if (v.layout === 'week') render(v) }, 60e3)
  const onKey = (e) => {
    if (!v.writable || e.target.closest?.('input, textarea, select, dialog')) return
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? v.undo.redo() : v.undo.undo() }
  }
  document.addEventListener('keydown', onKey)
  const loadTasks = async () => {
    try { v.tasks = await cp.dueTasks() } catch { v.tasks = [] }
    schedule()
  }
  const taskTick = setInterval(loadTasks, 60e3)
  window.addEventListener('focus', loadTasks)
  loadTasks()
  v.destroy = () => { cancelAnimationFrame(frame); o.ydoc.getMap(EVENTS).unobserveDeep(schedule); clearInterval(tick); clearInterval(taskTick); window.removeEventListener('focus', loadTasks); document.removeEventListener('keydown', onKey); v.undo.destroy() }
  renderToolbar(v)
  render(v)
  if (v.layout === 'week') requestAnimationFrame(() => { const s = v.root.querySelector('.week-scroll'); if (s) s.scrollTop = HOUR_PX * 7.5 })

  return {
    focus: () => {},
    setEditable (writable) { if (writable !== v.writable) { v.writable = writable; render(v) } },
    notes () {
      const now = new Date()
      const next = occurrences(v.ydoc, now, addDays(now, 365))[0]
      const n = v.ydoc.getMap(EVENTS).size
      return [{ text: `${n} event${n === 1 ? '' : 's'}` }, next ? { text: `Next: ${next.event.title || 'Untitled event'}, ${when(next)}` } : null].filter(Boolean)
    },
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const shown = el('div', { class: 'cal-app' }, monthGrid({ ...v, ydoc, writable: false, showTasks: false }))
      $('#desk').append(shown)
      return { title: ydoc.getMap('meta').get('title') || '', close () { shown.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    async exportPayload () { return { payload: {} } },
    comments: {
      current: () => { const e = v.picked && readEvent(v.ydoc, v.picked); return e ? { anchor: { kind: 'event', id: v.picked }, label: `“${e.title || 'Untitled event'}”` } : null },
      label: (a) => { const e = readEvent(v.ydoc, a.id); return e ? `Event “${e.title || 'Untitled event'}”` : null },
      reveal: (a) => {
        const e = readEvent(v.ydoc, a.id)
        if (!e) return
        const next = occurrences(v.ydoc, addDays(new Date(), -1), addDays(new Date(), 400)).find((x) => x.id === a.id) || occurrences(v.ydoc, addDays(new Date(), -3650), addDays(new Date(), 3650)).find((x) => x.id === a.id)
        if (next) v.cursor = v.layout === 'month' ? new Date(next.start.getFullYear(), next.start.getMonth(), 1) : next.start
        v.picked = a.id
        render(v)
      },
      mark: (threads) => { v.commentCounts = countBy(threads, 'event'); badges(v.root, '.cal-event[data-event]', 'data-event', v.commentCounts) }
    },
    exportFormats: { ics: 'Calendar file (.ics)' },
    exportHints: { ics: 'Opens in Google Calendar, Apple Calendar and Outlook' },
    destroy: () => v.destroy()
  }
}

const time = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
function when (occ) {
  const day = occ.start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  return occ.event.allDay ? day : `${day}, ${time(occ.start)}`
}

// ---- drawing ---------------------------------------------------------------------

function render (v) {
  const scroll = v.root.querySelector('.week-scroll')?.scrollTop
  v.root.replaceChildren(head(v), v.layout === 'week' ? weekGrid(v) : monthGrid(v))
  if (scroll != null) { const s = v.root.querySelector('.week-scroll'); if (s) s.scrollTop = scroll }
  badges(v.root, '.cal-event[data-event]', 'data-event', v.commentCounts)
}

// Moving around is for everyone, so it's here rather than in the toolbar
// (which people who can only view don't get).
function head (v) {
  const go = (by) => {
    v.cursor = v.layout === 'month' ? new Date(v.cursor.getFullYear(), v.cursor.getMonth() + by, 1) : addDays(v.cursor, 7 * by)
    render(v)
  }
  const setLayout = (layout) => {
    v.layout = layout
    try { localStorage.setItem(VIEW_KEY, layout) } catch {}
    render(v)
    if (layout === 'week') requestAnimationFrame(() => { const s = v.root.querySelector('.week-scroll'); if (s) s.scrollTop = HOUR_PX * 7.5 })
  }
  const nav = (label, icon, fn) => el('button', { type: 'button', class: 'tool', title: label, 'aria-label': label, onclick: fn }, svg(icon))
  return el('header', { class: 'cal-head' },
    el('button', { type: 'button', class: 'btn', onclick: () => { v.cursor = new Date(); render(v) } }, 'Today'),
    nav('Previous', ICON.prev, () => go(-1)),
    nav('Next', ICON.next, () => go(1)),
    el('h2', { class: 'cal-period' }, periodLabel(v)),
    el('button', {
      type: 'button',
      class: 'btn btn-quiet cal-tasks-toggle',
      'aria-pressed': String(v.showTasks),
      title: 'Show the due dates of tasks on your task boards (only you see this)',
      onclick: () => { v.showTasks = !v.showTasks; try { localStorage.setItem(TASKS_KEY, v.showTasks ? 'on' : 'off') } catch {} render(v) }
    }, v.showTasks ? 'Hide tasks' : 'Show tasks'),
    el('div', { class: 'seg', role: 'group', 'aria-label': 'Show' },
      el('button', { type: 'button', 'aria-pressed': String(v.layout === 'month'), onclick: () => setLayout('month') }, 'Month'),
      el('button', { type: 'button', 'aria-pressed': String(v.layout === 'week'), onclick: () => setLayout('week') }, 'Week')))
}

function periodLabel (v) {
  if (v.layout === 'month') return v.cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
  const start = weekStart(v.cursor)
  const end = addDays(start, 6)
  const md = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  if (start.getFullYear() !== end.getFullYear()) return `${md(start)}, ${start.getFullYear()} – ${md(end)}, ${end.getFullYear()}`
  return `${md(start)} – ${start.getMonth() === end.getMonth() ? end.getDate() : md(end)}, ${end.getFullYear()}`
}

const weekStart = (d) => addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -d.getDay())

function monthGrid (v) {
  const first = new Date(v.cursor.getFullYear(), v.cursor.getMonth(), 1)
  const start = addDays(first, -first.getDay())
  const end = addDays(start, 42)
  const occs = occurrences(v.ydoc, start, end)
  const today = dayKey(new Date())
  const names = Array.from({ length: 7 }, (_, i) => addDays(start, i).toLocaleDateString(undefined, { weekday: 'short' }))
  const cells = []
  for (let i = 0; i < 42; i++) {
    const day = addDays(start, i)
    const key = dayKey(day)
    const next = addDays(day, 1)
    const here = occs.filter((o) => o.start < next && o.end > day)
    const due = tasksOn(v, key)
    const room = Math.max(0, 4 - due.length)
    const cell = el('div', {
      class: `month-day${day.getMonth() !== first.getMonth() ? ' other' : ''}${key === today ? ' today' : ''}`,
      'data-day': key,
      ondblclick: (e) => { if (v.writable && !e.target.closest('.cal-event')) editDialog(v, null, { day }) }
    },
    el('span', { class: 'day-num' }, String(day.getDate())),
    ...due.slice(0, 4).map(taskChip),
    ...here.slice(0, room).map((o) => eventChip(v, o, day)),
    here.length > room ? el('button', { type: 'button', class: 'more-events', onclick: () => { v.layout = 'week'; v.cursor = day; render(v) } }, `${here.length - room} more`) : null)
    if (v.writable) wireDayDrop(v, cell, day)
    cells.push(cell)
  }
  return el('div', { class: 'month' },
    el('div', { class: 'month-names' }, ...names.map((n) => el('span', {}, n))),
    el('div', { class: 'month-grid' }, ...cells))
}

function eventChip (v, o, day) {
  const e = o.event
  const continues = !e.allDay && o.start < day // started on an earlier day
  return el('button', {
    type: 'button',
    class: `cal-event${e.allDay || o.end - o.start >= 864e5 ? ' all-day' : ''}${v.picked === o.id ? ' picked' : ''}`,
    'data-event': o.id,
    style: `--ev:${e.color || COLORS[0]}`,
    title: `${e.title || 'Untitled event'}\n${when(o)}${e.location ? `\n${e.location}` : ''}`,
    draggable: v.writable ? 'true' : null,
    ondragstart: (ev) => { ev.dataTransfer.setData(DRAG, JSON.stringify({ id: o.id, from: dayKey(o.start) })); ev.dataTransfer.effectAllowed = 'move' },
    onclick: () => { v.picked = o.id; editDialog(v, o) }
  },
  !e.allDay && !continues && o.end - o.start < 864e5 ? el('span', { class: 'ev-time' }, time(o.start)) : null,
  el('span', { class: 'ev-title' }, e.title || 'Untitled event'))
}

const tasksOn = (v, key) => (v.showTasks ? v.tasks.filter((t) => t.due === key) : [])

// A task due that day; opens its board.
function taskChip (t) {
  return el('button', {
    type: 'button',
    class: `cal-task${t.done ? ' done' : ''}`,
    title: `${t.title}\nDue on “${t.board}”${t.done ? ' (done)' : ''}`,
    onclick: () => openFile(t.docId)
  }, el('span', { class: 'cal-task-box', 'aria-hidden': 'true' }), el('span', { class: 'ev-title' }, t.title))
}

// Dropping an event on another day moves it (the whole series, if it repeats).
function wireDayDrop (v, cell, day) {
  cell.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DRAG)) { e.preventDefault(); cell.classList.add('drop-over') } })
  cell.addEventListener('dragleave', () => cell.classList.remove('drop-over'))
  cell.addEventListener('drop', (e) => {
    cell.classList.remove('drop-over')
    let data
    try { data = JSON.parse(e.dataTransfer.getData(DRAG)) } catch { return }
    e.preventDefault()
    const shift = Math.round((day - fromDayKey(data.from)) / 864e5)
    if (shift) shiftEvent(v, data.id, shift)
  })
}

function shiftEvent (v, id, days) {
  const e = readEvent(v.ydoc, id)
  if (!e) return
  if (e.allDay) {
    updateEvent(v.ydoc, id, { start: dayKey(addDays(fromDayKey(e.start), days)), end: e.end ? dayKey(addDays(fromDayKey(e.end), days)) : null })
  } else {
    updateEvent(v.ydoc, id, { start: addDays(new Date(e.start), days).toISOString(), end: e.end ? addDays(new Date(e.end), days).toISOString() : null })
  }
}

function weekGrid (v) {
  const start = weekStart(v.cursor)
  const end = addDays(start, 7)
  const occs = occurrences(v.ydoc, start, end)
  const today = dayKey(new Date())
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i))
  const long = (o) => o.event.allDay || o.end - o.start >= 864e5
  const head = el('div', { class: 'week-head' }, el('span'), ...days.map((d) => el('span', { class: `week-day${dayKey(d) === today ? ' today' : ''}` },
    el('span', { class: 'wd-name' }, d.toLocaleDateString(undefined, { weekday: 'short' })), el('span', { class: 'wd-num' }, String(d.getDate())))))
  const allDay = el('div', { class: 'week-allday' }, el('span', { class: 'hour-label' }, 'All day'), ...days.map((d) => {
    const cell = el('div', { class: 'allday-cell', 'data-day': dayKey(d), ondblclick: (e) => { if (v.writable && !e.target.closest('.cal-event')) editDialog(v, null, { day: d }) } },
      ...tasksOn(v, dayKey(d)).map(taskChip),
      ...occs.filter((o) => long(o) && o.start < addDays(d, 1) && o.end > d).map((o) => eventChip(v, o, d)))
    if (v.writable) wireDayDrop(v, cell, d)
    return cell
  }))
  const hours = el('div', { class: 'hour-labels' }, ...Array.from({ length: 24 }, (_, h) => el('span', { class: 'hour-label', style: `top:${h * HOUR_PX}px` }, h ? new Date(2000, 0, 1, h).toLocaleTimeString(undefined, { hour: 'numeric' }) : '')))
  const cols = days.map((d) => {
    const dayEnd = addDays(d, 1)
    const col = el('div', {
      class: `week-col${dayKey(d) === today ? ' today' : ''}`,
      style: `height:${24 * HOUR_PX}px`,
      onclick: (e) => {
        if (!v.writable || e.target.closest('.cal-event')) return
        const r = col.getBoundingClientRect()
        const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor(((e.clientY - r.top) / HOUR_PX) * 2) * 30))
        editDialog(v, null, { day: d, minutes })
      }
    })
    const here = occs.filter((o) => !long(o) && o.start < dayEnd && o.end > d)
    layoutColumn(here).forEach(({ o, lane, lanes }) => {
      const s = Math.max(o.start, d)
      const e = Math.min(o.end, dayEnd)
      const top = ((s - d) / 3600e3) * HOUR_PX
      const height = Math.max(18, ((e - s) / 3600e3) * HOUR_PX - 2)
      const chip = eventChip(v, o, d)
      chip.classList.add('timed')
      chip.style.cssText += `;top:${top}px;height:${height}px;left:calc(${(lane / lanes) * 100}% + 2px);width:calc(${100 / lanes}% - 4px)`
      col.append(chip)
    })
    if (dayKey(d) === today) {
      const now = new Date()
      col.append(el('div', { class: 'now-line', style: `top:${((now - d) / 3600e3) * HOUR_PX}px` }))
    }
    return col
  })
  return el('div', { class: 'week' }, head, allDay, el('div', { class: 'week-scroll' }, el('div', { class: 'week-body' }, hours, ...cols)))
}

// Side by side when events overlap: each gets a lane within its group.
function layoutColumn (occs) {
  const out = []
  let group = []
  let groupEnd = 0
  const flush = () => { const lanes = Math.max(1, ...group.map((g) => g.lane + 1)); group.forEach((g) => out.push({ ...g, lanes })); group = [] }
  for (const o of occs.slice().sort((a, b) => a.start - b.start)) {
    if (group.length && o.start >= groupEnd) flush()
    const used = new Set(group.filter((g) => g.o.end > o.start).map((g) => g.lane))
    let lane = 0
    while (used.has(lane)) lane++
    group.push({ o, lane })
    groupEnd = Math.max(groupEnd, o.end.getTime())
  }
  flush()
  return out
}

// ---- the event dialog -------------------------------------------------------------

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
const atTime = (key, t) => { const d = fromDayKey(key); const [h, m] = String(t || '00:00').split(':').map(Number); d.setHours(h, m); return d }

// occ: the occurrence clicked (null for a new event). New events start on
// `day`, at `minutes` past midnight if given.
async function editDialog (v, occ, { day = new Date(), minutes = null } = {}) {
  const e = occ ? readEvent(v.ydoc, occ.id) : null
  if (occ && !e) return
  if (occ && !v.writable) return showDialog(v, occ)
  const base = new Date(day.getFullYear(), day.getMonth(), day.getDate())
  const start0 = e ? (e.allDay ? fromDayKey(e.start) : new Date(e.start)) : minutes != null ? new Date(base.getTime() + minutes * 60e3) : new Date(base.getFullYear(), base.getMonth(), base.getDate(), Math.min(23, new Date().getHours() + 1))
  const end0 = e ? (e.allDay ? addDays(fromDayKey(e.end || e.start), e.end ? -1 : 0) : new Date(e.end || start0.getTime() + 3600e3)) : new Date(start0.getTime() + 3600e3)
  const allDay0 = e ? e.allDay : minutes == null && v.layout === 'month'
  const f = {
    title: el('input', { name: 'title', value: e?.title || '', placeholder: 'Add a title', autocomplete: 'off', class: 'ev-title-input' }),
    allDay: el('input', { type: 'checkbox', name: 'allDay', checked: allDay0 || null }),
    startDay: el('input', { type: 'date', name: 'startDay', value: dayKey(start0), required: true }),
    startTime: el('input', { type: 'time', name: 'startTime', value: hhmm(start0), step: '300' }),
    endDay: el('input', { type: 'date', name: 'endDay', value: dayKey(end0) }),
    endTime: el('input', { type: 'time', name: 'endTime', value: hhmm(end0), step: '300' }),
    until: el('input', { type: 'date', name: 'until', value: e?.until || '' }),
    location: el('input', { name: 'location', value: e?.location || '', placeholder: 'Where', autocomplete: 'off' }),
    notes: el('textarea', { name: 'notes', rows: '3', placeholder: 'Notes' }, e?.notes || '')
  }
  let color = e?.color || COLORS[0]
  const pick = (ev, c) => { color = c; ev.currentTarget.parentNode.querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b === ev.currentTarget))) }
  const swatches = el('div', { class: 'ev-colors', role: 'radiogroup', 'aria-label': 'Color' }, ...COLORS.map((c) =>
    el('button', { type: 'button', class: 'swatch-btn', style: `--swatch:${c}`, role: 'radio', 'aria-checked': String(c === color), 'aria-label': c, onclick: (ev) => pick(ev, c) })))
  const timeRow = () => { for (const n of [f.startTime, f.endTime]) n.hidden = f.allDay.checked }
  f.allDay.addEventListener('change', timeRow)
  timeRow()
  const repeat = selectField({ label: 'Repeats', name: 'repeat', value: e?.repeat || 'none', options: Object.entries(REPEATS).map(([value, label]) => ({ value, label })) })
  const reminder = selectField({ label: 'Reminder', name: 'reminder', value: e?.reminder != null ? String(e.reminder) : '', options: REMINDERS.map(([value, label]) => ({ value, label })) })
  const untilField = el('label', { class: 'field' }, 'Repeats until (optional)', f.until)
  const showUntil = () => { untilField.hidden = repeat.querySelector('select').value === 'none' }
  repeat.querySelector('select').addEventListener('change', showUntil)
  showUntil()
  const res = await dialog({
    title: e ? 'Event' : 'New event',
    wide: true,
    fields: [
      f.title,
      el('div', { class: 'ev-when' },
        el('label', { class: 'field' }, 'Starts', el('span', { class: 'ev-pair' }, f.startDay, f.startTime)),
        el('label', { class: 'field' }, 'Ends', el('span', { class: 'ev-pair' }, f.endDay, f.endTime))),
      el('label', { class: 'check' }, f.allDay, 'All day'),
      el('div', { class: 'ev-when' }, repeat, untilField),
      el('label', { class: 'field' }, 'Location', f.location),
      el('label', { class: 'field' }, 'Notes', f.notes),
      el('div', { class: 'ev-when' }, reminder, el('div', { class: 'field' }, 'Color', swatches)),
      el('p', { class: 'fineprint-plain' }, 'Times are shown in each person’s own time zone. Reminders appear while commonplace is running.')
    ],
    confirm: e ? 'Save' : 'Add event',
    extraActions: e ? [{ label: 'Delete', value: 'delete', danger: true }] : [],
    validate: (d) => {
      if (!d.startDay) return 'Choose a day.'
      const s = d.allDay ? fromDayKey(d.startDay) : atTime(d.startDay, d.startTime)
      const en = d.allDay ? fromDayKey(d.endDay || d.startDay) : atTime(d.endDay || d.startDay, d.endTime)
      return en < s ? 'It ends before it starts.' : null
    }
  })
  if (!res) return
  if (res.action === 'delete') return removeDialog(v, occ, e)
  if (res.action !== 'confirm') return
  const d = res.data
  const fields = {
    title: d.title.trim(),
    allDay: Boolean(d.allDay),
    location: d.location.trim(),
    notes: d.notes,
    color,
    repeat: d.repeat,
    until: d.repeat !== 'none' && d.until ? d.until : null,
    reminder: d.reminder === '' || d.allDay ? null : Number(d.reminder)
  }
  if (fields.allDay) {
    fields.start = d.startDay
    fields.end = dayKey(addDays(fromDayKey(d.endDay || d.startDay), 1)) // the day after the last
  } else {
    fields.start = atTime(d.startDay, d.startTime).toISOString()
    fields.end = atTime(d.endDay || d.startDay, d.endTime).toISOString()
  }
  if (e) updateEvent(v.ydoc, e.id, fields)
  else { addEvent(v.ydoc, fields); toast(`Added “${fields.title || 'Untitled event'}”`) }
}

async function removeDialog (v, occ, e) {
  if (e.repeat === 'none') { deleteEvent(v.ydoc, e.id); return }
  const res = await dialog({
    title: 'Delete a repeating event',
    body: `“${e.title || 'Untitled event'}” repeats. Delete just this one, or every time?`,
    confirm: 'Every time',
    danger: true,
    extraActions: [{ label: 'Just this one', value: 'one' }]
  })
  if (res?.action === 'one') skipOccurrence(v.ydoc, e.id, occ.key)
  else if (res?.action === 'confirm') deleteEvent(v.ydoc, e.id)
}

// For people who can only view.
function showDialog (v, occ) {
  const e = occ.event
  dialog({
    title: e.title || 'Untitled event',
    fields: [
      el('p', {}, occ.event.allDay ? when(occ) : `${when(occ)} – ${time(occ.end)}`),
      e.repeat !== 'none' ? el('p', { class: 'fineprint-plain' }, REPEATS[e.repeat]) : null,
      e.location ? el('p', {}, e.location) : null,
      e.notes ? el('p', { class: 'ev-notes' }, e.notes) : null
    ],
    confirm: 'Close',
    cancel: null
  })
}

// ---- toolbar ---------------------------------------------------------------------

function renderToolbar (v) {
  setToolbar(toolbarGroups([
    [labeledButton('newEvent', 'New event', ICON.add, () => editDialog(v, null, { day: v.cursor.getMonth() === new Date().getMonth() ? new Date() : new Date(v.cursor.getFullYear(), v.cursor.getMonth(), 1) }))],
    [toolButton('undo', 'Undo', ICON.undo, () => v.undo.undo(), { key: 'Mod-Z' }), toolButton('redo', 'Redo', ICON.redo, () => v.undo.redo(), { key: 'Mod-Shift-Z' })]
  ]))
}
