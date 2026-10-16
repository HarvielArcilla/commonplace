// .ics (iCalendar) import and export, for moving events to and from Google
// Calendar, Apple Calendar and Outlook.
//
// Covered: one-off and repeating events (daily, weekdays, weekly, monthly,
// yearly, with an end date), all-day events, skipped occurrences, location,
// notes and reminders. Times written with a named time zone (TZID) are read
// as this computer's local time.

import { allEvents, addEvent, COLORS } from './model.js'

const pad = (n) => String(n).padStart(2, '0')
const utcStamp = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
const dateStamp = (key) => key.replace(/-/g, '')
const escape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
const unescape = (s) => String(s || '').replace(/\\n/gi, '\n').replace(/\\([\\;,])/g, '$1')

// Lines longer than 75 octets are folded, as the format requires.
function fold (line) {
  const bytes = Buffer.from(line)
  if (bytes.length <= 75) return line
  const parts = []
  let start = 0
  while (start < bytes.length) {
    let end = Math.min(bytes.length, start + (parts.length ? 74 : 75))
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end-- // don't split a character
    parts.push(bytes.subarray(start, end).toString())
    start = end
  }
  return parts.join('\r\n ')
}

const RRULE = { daily: 'FREQ=DAILY', weekdays: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', weekly: 'FREQ=WEEKLY', monthly: 'FREQ=MONTHLY', yearly: 'FREQ=YEARLY' }

export function exportIcs (ydoc, name = 'Calendar') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//commonplace//commonCalendar//EN', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escape(name)}`]
  const now = utcStamp(new Date())
  for (const e of allEvents(ydoc)) {
    if (!e.start) continue
    lines.push('BEGIN:VEVENT', `UID:${e.id}@commonplace`, `DTSTAMP:${now}`)
    if (e.allDay) {
      lines.push(`DTSTART;VALUE=DATE:${dateStamp(e.start)}`)
      if (e.end) lines.push(`DTEND;VALUE=DATE:${dateStamp(e.end)}`)
    } else {
      lines.push(`DTSTART:${utcStamp(new Date(e.start))}`)
      if (e.end) lines.push(`DTEND:${utcStamp(new Date(e.end))}`)
    }
    lines.push(`SUMMARY:${escape(e.title)}`)
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`)
    if (e.notes) lines.push(`DESCRIPTION:${escape(e.notes)}`)
    if (RRULE[e.repeat]) {
      const until = e.until ? `;UNTIL=${e.allDay ? dateStamp(e.until) : utcStamp(new Date(`${e.until}T23:59:59`))}` : ''
      lines.push(`RRULE:${RRULE[e.repeat]}${until}`)
    }
    for (const key of e.skip || []) lines.push(e.allDay ? `EXDATE;VALUE=DATE:${dateStamp(key)}` : `EXDATE:${utcStamp(new Date(key))}`)
    if (e.reminder != null && !e.allDay) lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escape(e.title)}`, `TRIGGER:-PT${Number(e.reminder)}M`, 'END:VALARM')
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

// ---- reading ---------------------------------------------------------------------

function parseLines (text) {
  const raw = String(text).replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/)
  return raw.filter(Boolean).map((line) => {
    const colon = line.search(/:(?=(?:[^"]*"[^"]*")*[^"]*$)/) // the first colon outside quotes
    const head = line.slice(0, colon)
    const [name, ...params] = head.split(';')
    return { name: name.toUpperCase(), params: Object.fromEntries(params.map((p) => { const [k, ...v] = p.split('='); return [k.toUpperCase(), v.join('=').replace(/^"|"$/g, '')] })), value: line.slice(colon + 1) }
  })
}

// A DTSTART-style value: { allDay, date: 'YYYY-MM-DD' } or { allDay: false, iso }.
function readTime (prop) {
  const v = prop.value.trim()
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(v)
  if (!m) return null
  const [, y, mo, d, h, mi, s, z] = m
  if (prop.params.VALUE === 'DATE' || h == null) return { allDay: true, date: `${y}-${mo}-${d}` }
  const when = z ? new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0))) : new Date(+y, +mo - 1, +d, +h, +mi, +(s || 0))
  return { allDay: false, iso: when.toISOString() }
}

function readDuration (value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(value).trim())
  if (!m) return null
  const [, sign, w, d, h, mi, s] = m
  const ms = ((+(w || 0) * 7 + +(d || 0)) * 86400 + +(h || 0) * 3600 + +(mi || 0) * 60 + +(s || 0)) * 1000
  return sign === '-' ? -ms : ms
}

function readRule (value) {
  const rule = Object.fromEntries(String(value).split(';').map((p) => p.split('=')))
  if (Number(rule.INTERVAL || 1) !== 1) return { repeat: null } // every other week etc.: not supported
  let repeat = { DAILY: 'daily', WEEKLY: 'weekly', MONTHLY: 'monthly', YEARLY: 'yearly' }[rule.FREQ] || null
  if (repeat === 'weekly' && rule.BYDAY && rule.BYDAY.split(',').sort().join(',') === 'FR,MO,TH,TU,WE') repeat = 'weekdays'
  else if (repeat === 'weekly' && rule.BYDAY && rule.BYDAY.split(',').length > 1) repeat = null
  let until = null
  if (rule.UNTIL) {
    const t = readTime({ value: rule.UNTIL, params: {} })
    until = t ? (t.allDay ? t.date : new Date(t.iso).toLocaleDateString('en-CA')) : null
  }
  return { repeat, until }
}

// Adds every event in an .ics file. Returns { added, simplified }, where
// simplified counts repeating events whose rule couldn't be kept (every
// other week, say), which are added as one-off events.
export function importIcs (ydoc, text) {
  const lines = parseLines(text)
  let added = 0
  let simplified = 0
  let cur = null
  let inAlarm = false
  ydoc.transact(() => {
    for (const l of lines) {
      if (l.name === 'BEGIN' && l.value === 'VEVENT') { cur = { skip: [] }; continue }
      if (!cur) continue
      if (l.name === 'BEGIN' && l.value === 'VALARM') { inAlarm = true; continue }
      if (l.name === 'END' && l.value === 'VALARM') { inAlarm = false; continue }
      if (inAlarm) {
        if (l.name === 'TRIGGER') { const ms = readDuration(l.value); if (ms != null && ms <= 0) cur.reminder = Math.round(-ms / 60000) }
        continue
      }
      if (l.name === 'END' && l.value === 'VEVENT') {
        if (cur.start) {
          const e = {
            title: cur.title || 'Untitled event',
            location: cur.location || '',
            notes: cur.notes || '',
            allDay: cur.start.allDay,
            start: cur.start.allDay ? cur.start.date : cur.start.iso,
            end: cur.end ? (cur.start.allDay ? cur.end.date || null : cur.end.iso || null) : cur.duration != null && !cur.start.allDay ? new Date(new Date(cur.start.iso).getTime() + cur.duration).toISOString() : null,
            repeat: cur.rule?.repeat || 'none',
            until: cur.rule?.until || null,
            skip: cur.skip,
            reminder: cur.start.allDay ? null : cur.reminder ?? null,
            color: COLORS[0]
          }
          if (cur.rule && !cur.rule.repeat) simplified++
          addEvent(ydoc, e)
          added++
        }
        cur = null
        continue
      }
      if (l.name === 'SUMMARY') cur.title = unescape(l.value)
      else if (l.name === 'LOCATION') cur.location = unescape(l.value)
      else if (l.name === 'DESCRIPTION') cur.notes = unescape(l.value)
      else if (l.name === 'DTSTART') cur.start = readTime(l)
      else if (l.name === 'DTEND') cur.end = readTime(l)
      else if (l.name === 'DURATION') cur.duration = readDuration(l.value)
      else if (l.name === 'RRULE') cur.rule = readRule(l.value)
      else if (l.name === 'EXDATE') {
        for (const v of l.value.split(',')) {
          const t = readTime({ value: v, params: l.params })
          if (t) cur.skip.push(t.allDay ? t.date : t.iso)
        }
      }
    }
  }, 'local')
  return { added, simplified }
}
