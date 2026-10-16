// commonCalendar reminders: while commonplace runs, a notification for each
// event whose reminder time has come, in every calendar in the Drive.
// Checked every half minute; each occurrence is announced once (what's been
// announced is remembered on disk, so a restart doesn't repeat it).

import fs from 'node:fs'
import path from 'node:path'
import { occurrences } from '@commonplace/calendar/model'

const EVERY_MS = 30e3
const LOOK_BACK_MS = 10 * 60e3 // also announce what came due while the app was starting

export class Reminders {
  constructor ({ drive, dataDir, notify }) {
    this.drive = drive
    this.notify = notify
    this.file = path.join(dataDir, 'reminders.json')
    try { this.sent = new Set(JSON.parse(fs.readFileSync(this.file, 'utf8'))) } catch { this.sent = new Set() }
    this.timer = setInterval(() => this.check(), EVERY_MS)
    this.timer.unref?.()
    setTimeout(() => this.check(), 5000).unref?.()
  }

  check (now = Date.now()) {
    const due = []
    for (const f of this.drive.list()) {
      if (f.kind !== 'calendar') continue
      const ydoc = this.drive.getDoc(f.docId)?.ydoc
      if (!ydoc) continue
      // Reminders can be up to a day early, so look a day ahead.
      for (const o of occurrences(ydoc, new Date(now - LOOK_BACK_MS), new Date(now + 864e5 + 60e3))) {
        const r = o.event.reminder
        if (r == null || o.event.allDay) continue
        const at = o.start.getTime() - r * 60e3
        const key = `${f.docId}|${o.id}|${o.key}|${r}`
        if (at <= now && at > now - LOOK_BACK_MS && !this.sent.has(key)) due.push({ key, o, calendar: f.title })
      }
    }
    for (const { key, o, calendar } of due) {
      this.sent.add(key)
      const t = o.start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      this.notify({ title: o.event.title || 'Untitled event', body: `${o.event.reminder ? `At ${t}` : 'Now'}${o.event.location ? ` · ${o.event.location}` : ''} · ${calendar}` })
    }
    if (due.length) this._save()
    return due.length
  }

  _save () {
    // Keep only recent keys: the file stays small.
    const keep = [...this.sent].slice(-2000)
    this.sent = new Set(keep)
    try { fs.writeFileSync(this.file, JSON.stringify(keep)) } catch {}
  }

  destroy () { clearInterval(this.timer) }
}
