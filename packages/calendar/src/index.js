// commonCalendar app descriptor: what commonDrive needs to create, preview,
// merge and restore calendars. The calendar view lives in the desktop app.

import * as Y from 'yjs'
import { initCalendar, preview, thumbnail, allEvents, EVENTS } from './model.js'

// Conflict units: each event, and the title.
function units (ydoc) {
  const out = new Map()
  for (const e of allEvents(ydoc)) {
    const { id, ...props } = e
    const when = e.allDay ? e.start : new Date(e.start).toLocaleString()
    out.set(`event|${id}`, { kind: 'event', sig: JSON.stringify(props), text: `${e.title || 'Untitled event'} (${when})${e.location ? `\n${e.location}` : ''}`, props, prev: null })
  }
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

const snapshotUnit = (u) => (u?.props ? JSON.stringify(u.props) : null)

// The owner's decision: one version of an event; 'both' keeps both events.
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  const present = picked.filter((v) => v.exists)
  if (rec.kind === 'title') { if (present.length) ydoc.getMap('meta').set('title', present.map((v) => v.text).join(' / ')); return }
  const id = rec.unit.split('|')[1]
  const events = ydoc.getMap(EVENTS)
  if (!present.length) { events.delete(id); return }
  present.forEach((v, n) => {
    const e = new Y.Map()
    events.set(n === 0 ? id : `${id}-${n}`, e)
    for (const [k, val] of Object.entries(JSON.parse(v.snapshot))) e.set(k, val)
  })
}

export const calendarApp = {
  type: 'calendar',
  kind: 'calendar',
  name: 'Calendar',
  description: 'Events for everyone it’s shared with, in each person’s own time zone. Imports and exports .ics.',
  schemaVersion: 1,
  exports: ['ics'],
  initContent (ydoc) { initCalendar(ydoc) },
  preview,
  thumbnail,
  units,
  resolve,
  snapshotUnit,
  history: { roots: [{ name: EVENTS, type: 'map' }] }
}

export default calendarApp
