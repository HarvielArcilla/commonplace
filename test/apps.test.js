// commonTasks, commonCalendar and commonBoard: their models, concurrent
// edits, conflicts, exports and imports, and calendar reminders.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as Y from 'yjs'
import { findConflicts } from '@commonplace/core'
import { tasksApp } from '@commonplace/tasks'
import { readLists, cardsIn, addCard, moveCard, updateCard, deleteList, readCard } from '@commonplace/tasks/model'
import { exportCsv as tasksCsv, exportMarkdown } from '@commonplace/tasks/convert'
import { addEvent, occurrences, skipOccurrence, readEvent, allEvents } from '@commonplace/calendar/model'
import { exportIcs, importIcs } from '@commonplace/calendar/ics'
import { whiteboardApp } from '@commonplace/whiteboard'
import { addShape, shapeText, readShape, allShapes, moveShapes } from '@commonplace/whiteboard/model'
import { boardSvg, wrap, hits } from '@commonplace/whiteboard/render'
import { Reminders } from '../apps/desktop/src/reminders.js'

const sync = (a, b) => { Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b))); Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a))) }
const copy = (d) => { const c = new Y.Doc(); Y.applyUpdate(c, Y.encodeStateAsUpdate(d)); return c }

// ---- commonTasks ------------------------------------------------------------------

test('tasks: cards keep their order, move between lists, and merge', () => {
  const a = new Y.Doc()
  tasksApp.initContent(a)
  const [todo, doing, done] = readLists(a).map((l) => l.id)
  assert.deepEqual(readLists(a).map((l) => l.name), ['To do', 'Doing', 'Done'])
  const x = addCard(a, todo, 'Order seedlings')
  const y = addCard(a, todo, 'Fix the gate')
  const z = addCard(a, todo, 'Call the city')
  moveCard(a, z, todo, x) // to the top
  assert.deepEqual(cardsIn(a, todo).map((c) => c.title), ['Call the city', 'Order seedlings', 'Fix the gate'])

  // Two people move different cards at once: both moves stick.
  const b = copy(a)
  moveCard(a, x, doing, null)
  moveCard(b, y, done, null)
  sync(a, b)
  assert.deepEqual(cardsIn(a, doing).map((c) => c.title), ['Order seedlings'])
  assert.deepEqual(cardsIn(b, done).map((c) => c.title), ['Fix the gate'])

  // Deleting a list moves its cards to the first remaining list.
  deleteList(a, doing)
  assert.equal(readCard(a, x).list, todo)
  updateCard(a, x, { done: true, due: '2026-11-02', notes: 'Tomatoes\nBeans' })
  const csv = tasksCsv(a)
  assert.match(csv, /^List,Task,Done,Due,Assigned to,Notes\r\n/)
  assert.match(csv, /To do,Order seedlings,yes,2026-11-02,,"Tomatoes\nBeans"/)
  assert.match(exportMarkdown(a, 'Garden'), /- \[x\] Order seedlings \(due 2026-11-02\)\n {2}Tomatoes/)
})

test('tasks: the same card changed on both sides is a conflict the owner resolves', () => {
  const base = new Y.Doc()
  tasksApp.initContent(base)
  const todo = readLists(base)[0].id
  const id = addCard(base, todo, 'Buy soil')
  const mine = copy(base)
  const theirs = copy(base)
  updateCard(mine, id, { title: 'Buy 30 bags of soil' })
  updateCard(theirs, id, { title: 'Buy compost' })
  const found = findConflicts({ base, mine, theirs, units: tasksApp.units })
  assert.equal(found.length, 1)
  const { key } = found[0]
  const rec = { kind: found[0].mine.kind, unit: key, versions: [found[0].mine, found[0].theirs].map((u) => ({ exists: true, text: u.text, snapshot: tasksApp.snapshotUnit(u) })) }
  const merged = copy(mine)
  Y.applyUpdate(merged, Y.encodeStateAsUpdate(theirs))
  tasksApp.resolve(merged, rec, 'both')
  assert.deepEqual(cardsIn(merged, todo).map((c) => c.title).sort(), ['Buy 30 bags of soil', 'Buy compost'])
})

// ---- commonCalendar ---------------------------------------------------------------

test('calendar: repeats, skipped days and end dates', () => {
  const d = new Y.Doc()
  const standup = addEvent(d, { title: 'Standup', start: new Date(2026, 9, 12, 9).toISOString(), end: new Date(2026, 9, 12, 9, 15).toISOString(), repeat: 'weekdays' })
  addEvent(d, { title: 'Rent', allDay: true, start: '2026-01-31', repeat: 'monthly' })
  addEvent(d, { title: 'Trip', allDay: true, start: '2026-10-20', end: '2026-10-23' })
  addEvent(d, { title: 'Class', start: new Date(2026, 9, 1, 18).toISOString(), repeat: 'weekly', until: '2026-10-22' })
  const oct = occurrences(d, new Date(2026, 9, 1), new Date(2026, 10, 1))
  const count = (t) => oct.filter((o) => o.event.title === t).length
  assert.equal(count('Standup'), 15) // Oct 12 – 30, weekdays
  assert.equal(count('Rent'), 1) // Oct 31
  assert.equal(count('Trip'), 1)
  assert.equal(count('Class'), 4) // Oct 1, 8, 15, 22
  assert.equal(occurrences(d, new Date(2026, 10, 1), new Date(2026, 11, 1)).filter((o) => o.event.title === 'Rent').length, 0) // no Nov 31
  // A 9am meeting stays at 9am every day, through daylight saving changes.
  assert.ok(oct.filter((o) => o.event.title === 'Standup').every((o) => o.start.getHours() === 9))
  const first = oct.find((o) => o.event.title === 'Standup')
  skipOccurrence(d, standup, first.key)
  assert.equal(occurrences(d, new Date(2026, 9, 1), new Date(2026, 10, 1)).filter((o) => o.event.title === 'Standup').length, 14)
  // A trip that spans days covers each of them.
  const trip = oct.find((o) => o.event.title === 'Trip')
  assert.equal((trip.end - trip.start) / 864e5, 3)
})

test('calendar: .ics export and import, including other apps’ files', () => {
  const d = new Y.Doc()
  const id = addEvent(d, { title: 'Work day; bring gloves, water', location: 'Elm Street', notes: 'Line one\nLine two', start: new Date(2026, 9, 18, 9).toISOString(), end: new Date(2026, 9, 18, 12, 30).toISOString(), repeat: 'weekly', until: '2026-12-31', reminder: 30 })
  skipOccurrence(d, id, new Date(2026, 9, 25, 9).toISOString())
  addEvent(d, { title: 'Harvest festival', allDay: true, start: '2026-11-07', end: '2026-11-09' })
  const ics = exportIcs(d, 'Garden')
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/)
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75))
  const back = new Y.Doc()
  assert.deepEqual(importIcs(back, ics), { added: 2, simplified: 0 })
  const strip = ({ id, created, color, ...e }) => e
  const sortByTitle = (list) => list.map(strip).sort((x, y) => x.title.localeCompare(y.title))
  assert.deepEqual(sortByTitle(allEvents(back)), sortByTitle(allEvents(d)))

  // A file like the ones Google Calendar writes.
  const google = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'DTSTART;TZID=America/Los_Angeles:20261020T180000', 'DTEND;TZID=America/Los_Angeles:20261020T193000',
    'RRULE:FREQ=WEEKLY;INTERVAL=2', 'SUMMARY:Board meeting', 'DESCRIPTION:Agenda:\\nbudget', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART:20261101T170000Z', 'DURATION:PT45M', 'SUMMARY:Call', 'BEGIN:VALARM', 'TRIGGER:-PT10M', 'ACTION:DISPLAY', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20261126', 'SUMMARY:Thanks', 'giving', 'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n').replace('SUMMARY:Thanks\r\ngiving', 'SUMMARY:Thanks\r\n giving')
  const g = new Y.Doc()
  assert.deepEqual(importIcs(g, google), { added: 3, simplified: 1 })
  const byTitle = Object.fromEntries(allEvents(g).map((e) => [e.title, e]))
  assert.equal(byTitle.Thanksgiving.allDay, true)
  assert.equal(byTitle['Board meeting'].repeat, 'none') // every other week isn't kept
  assert.equal(byTitle['Board meeting'].notes, 'Agenda:\nbudget')
  assert.equal(new Date(byTitle.Call.end) - new Date(byTitle.Call.start), 45 * 60e3)
  assert.equal(byTitle.Call.reminder, 10)
})

test('calendar: reminders go out once, while the app runs', () => {
  const ydoc = new Y.Doc()
  const now = Date.now()
  addEvent(ydoc, { title: 'Water the beds', start: new Date(now + 9 * 60e3).toISOString(), reminder: 10, location: 'Plot 3' })
  addEvent(ydoc, { title: 'Later', start: new Date(now + 3 * 3600e3).toISOString(), reminder: 10 })
  addEvent(ydoc, { title: 'No reminder', start: new Date(now + 5 * 60e3).toISOString() })
  const drive = { list: () => [{ docId: 'c1', kind: 'calendar', title: 'Garden' }], getDoc: () => ({ ydoc }) }
  const shown = []
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-rem-'))
  const r = new Reminders({ drive, dataDir: dir, notify: (n) => shown.push(n) })
  assert.equal(r.check(now), 1)
  assert.equal(shown[0].title, 'Water the beds')
  assert.match(shown[0].body, /Plot 3 · Garden/)
  assert.equal(r.check(now + 1000), 0) // once
  r.destroy()
  const again = new Reminders({ drive, dataDir: dir, notify: (n) => shown.push(n) })
  assert.equal(again.check(now + 2000), 0) // and not again after a restart
  again.destroy()
  assert.equal(readEvent(ydoc, allEvents(ydoc)[0].id).title, 'Water the beds')
})

// ---- commonBoard -----------------------------------------------------------------

test('whiteboard: two people type in one note and move different shapes', () => {
  const a = new Y.Doc()
  const note = addShape(a, { type: 'sticky', x: 0, y: 0, text: 'Beds' })
  const shed = addShape(a, { type: 'rect', x: 300, y: 0, text: 'Shed' })
  const b = copy(a)
  shapeText(a, note).insert(4, ' by the fence')
  shapeText(b, note).insert(0, 'Six ')
  moveShapes(a, [note], 10, 20, new Map([[note, { x: 0, y: 0 }]]))
  moveShapes(b, [shed], -50, 0, new Map([[shed, { x: 300, y: 0 }]]))
  sync(a, b)
  assert.equal(readShape(a, note).text, 'Six Beds by the fence')
  assert.equal(readShape(b, note).x, 10)
  assert.equal(readShape(a, shed).x, 250)
  assert.deepEqual(allShapes(a).map((s) => s.id), allShapes(b).map((s) => s.id))
  assert.equal(hits(readShape(a, note), 50, 50), true)
  assert.equal(hits(readShape(a, note), 500, 500), false)
})

test('whiteboard: text wraps, and the export is plain SVG', () => {
  const measure = (s, size) => s.length * size * 0.5
  assert.deepEqual(wrap('one two three four', 60, 10, measure), ['one two', 'three four'])
  assert.deepEqual(wrap('first line\nsecond', 200, 10, measure), ['first line', 'second'])
  assert.deepEqual(wrap('abcdefghijklmnop', 40, 10, measure), ['abcdefgh', 'ijklmnop'])
  const d = new Y.Doc()
  addShape(d, { type: 'sticky', x: 0, y: 0, text: 'Plant <tomatoes> & beans' })
  addShape(d, { type: 'arrow', x: 200, y: 0, w: 100, h: 50 })
  addShape(d, { type: 'pen', x: 0, y: 200, points: [0, 0, 10, 5, 20, 0] })
  const svg = boardSvg(allShapes(d), { measure })
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /Plant &lt;tomatoes&gt;<\/tspan><tspan[^>]*>&amp; beans/) // escaped, and wrapped
  assert.doesNotMatch(svg, /foreignObject/)
  assert.equal(whiteboardApp.preview(d), 'Plant <tomatoes> & beans')
})
