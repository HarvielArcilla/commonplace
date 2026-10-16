// commonCalendar data model, on top of the file's Y.Doc. No DOM code.
//
//   ydoc.getMap('events')   id -> Y.Map {
//     title, location, notes: text
//     allDay: bool
//     start, end: timed events: ISO times in UTC ('2026-10-16T17:00:00.000Z'),
//                 so everyone sees the same moment in their own time zone;
//                 all-day events: dates ('2026-10-16'), end not included
//     color: one of COLORS
//     repeat: 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
//     until: last date it repeats on ('YYYY-MM-DD') or null
//     skip: start keys of occurrences that were deleted on their own
//     reminder: minutes before (timed) or null
//     created: ms
//   }
//
// Each event is its own map, so two people changing different events (or
// different fields of one) never collide.

import * as Y from 'yjs'

export const EVENTS = 'events'
export const COLORS = ['#3b6fd8', '#2f8a5b', '#c2562f', '#8a4fb8', '#b88a1b', '#2d8aa3', '#c03a5b', '#5c6270']
export const REPEATS = { none: 'Does not repeat', daily: 'Every day', weekdays: 'Every weekday', weekly: 'Every week', monthly: 'Every month', yearly: 'Every year' }
const DAY = 864e5

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

export function initCalendar () {}

export function addEvent (ydoc, fields) {
  const id = fields.id || newId()
  ydoc.transact(() => {
    const e = new Y.Map()
    ydoc.getMap(EVENTS).set(id, e)
    const all = { title: '', location: '', notes: '', allDay: false, color: COLORS[0], repeat: 'none', until: null, skip: [], reminder: null, created: Date.now(), ...fields }
    delete all.id
    for (const [k, v] of Object.entries(all)) e.set(k, v)
  })
  return id
}

export function updateEvent (ydoc, id, patch) {
  const e = ydoc.getMap(EVENTS).get(id)
  if (!e) return
  ydoc.transact(() => { for (const [k, v] of Object.entries(patch)) e.set(k, v) })
}

export function deleteEvent (ydoc, id) {
  ydoc.getMap(EVENTS).delete(id)
}

// Deletes just one occurrence of a repeating event.
export function skipOccurrence (ydoc, id, key) {
  const e = ydoc.getMap(EVENTS).get(id)
  if (!e) return
  e.set('skip', [...new Set([...(e.get('skip') || []), key])])
}

export function readEvent (ydoc, id) {
  const e = ydoc.getMap(EVENTS).get(id)
  return e ? { id, ...e.toJSON() } : null
}

export const allEvents = (ydoc) => [...ydoc.getMap(EVENTS).keys()].map((id) => readEvent(ydoc, id))

// ---- times -------------------------------------------------------------------

// A date string for a local day, and back.
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const fromDayKey = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d) }
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes())

// An event's first occurrence as local Dates.
function span (e) {
  if (e.allDay) {
    const start = fromDayKey(e.start)
    const end = e.end && e.end > e.start ? fromDayKey(e.end) : addDays(start, 1)
    return { start, end }
  }
  const start = new Date(e.start)
  const end = e.end ? new Date(e.end) : new Date(start.getTime() + 3600e3)
  return { start, end: end > start ? end : new Date(start.getTime() + 3600e3) }
}

// The nth occurrence's start, stepping in local time (so a 9am meeting
// stays at 9am across daylight-saving changes).
function step (start, repeat, n) {
  const d = new Date(start)
  if (repeat === 'daily') d.setDate(d.getDate() + n)
  else if (repeat === 'weekly') d.setDate(d.getDate() + 7 * n)
  else if (repeat === 'monthly') {
    const day = d.getDate()
    d.setDate(1)
    d.setMonth(d.getMonth() + n)
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
    if (day > last) return null // no 31st this month
    d.setDate(day)
  } else if (repeat === 'yearly') {
    const m = d.getMonth()
    d.setFullYear(d.getFullYear() + n)
    if (d.getMonth() !== m) return null // Feb 29
  }
  return d
}

// The key that names one occurrence (its local start day, plus the time for
// timed events), used to skip it.
export const occurrenceKey = (e, start) => (e.allDay ? dayKey(start) : start.toISOString())

// Every occurrence that overlaps [from, to), sorted by start.
// Each: { id, key, start, end, event }.
export function occurrences (ydoc, from, to) {
  const out = []
  for (const e of allEvents(ydoc)) {
    if (!e.start) continue
    const { start, end } = span(e)
    const length = end - start
    const repeat = REPEATS[e.repeat] && e.repeat !== 'none' ? e.repeat : null
    const until = e.until ? addDays(fromDayKey(e.until), 1) : null
    const skip = new Set(e.skip || [])
    const push = (s) => {
      const key = occurrenceKey(e, s)
      if (!skip.has(key)) out.push({ id: e.id, key, start: s, end: new Date(s.getTime() + length), event: e })
    }
    if (!repeat) { if (start < to && end > from) push(start); continue }
    if (repeat === 'weekdays') {
      // Start from the first week that could overlap, then day by day.
      let d = start
      if (from - length > start) d = new Date(Math.max(start.getTime(), from.getTime() - length - 7 * DAY))
      d = new Date(d.getFullYear(), d.getMonth(), d.getDate(), start.getHours(), start.getMinutes())
      const stop = until && until < to ? until : to
      for (let i = 0; i < 4000 && d < stop; i++, d = addDays(d, 1)) {
        if (d < start || d.getDay() === 0 || d.getDay() === 6) continue
        if (d.getTime() + length > from.getTime()) push(d)
      }
      continue
    }
    // Skip ahead to near `from` instead of walking from the first occurrence.
    const approx = { daily: DAY, weekly: 7 * DAY, monthly: 28 * DAY, yearly: 365 * DAY }[repeat]
    let n = Math.max(0, Math.floor((from - length - start) / approx) - 2)
    for (let guard = 0; guard < 2000; guard++, n++) {
      const s = step(start, repeat, n)
      if (s === null) continue
      if (s >= to || (until && s >= until)) break
      if (s.getTime() + length > from.getTime()) push(s)
    }
  }
  return out.sort((a, b) => (a.start - b.start) || (b.event.allDay - a.event.allDay))
}

export function preview (ydoc) {
  const now = new Date()
  const soon = occurrences(ydoc, now, addDays(now, 60)).slice(0, 3)
  const n = ydoc.getMap(EVENTS).size
  if (!n) return 'No events yet'
  if (!soon.length) return `${n} event${n === 1 ? '' : 's'}, none coming up`
  return soon.map((o) => `${o.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${o.event.title || 'Untitled event'}`).join(' · ')
}

export function thumbnail (ydoc) {
  const now = new Date()
  const first = new Date(now.getFullYear(), now.getMonth(), 1)
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 1)
  const busy = {}
  for (const o of occurrences(ydoc, first, last)) busy[o.start.getDate()] = o.event.color || COLORS[0]
  return { year: now.getFullYear(), month: now.getMonth(), startsOn: first.getDay(), days: new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), busy, today: now.getDate() }
}
