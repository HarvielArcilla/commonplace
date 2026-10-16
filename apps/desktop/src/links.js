// Links between the apps, done in the background process because they
// reach into other files in your Drive: action items from a document
// become cards on a task board, a date in a document becomes a calendar
// event, and cards with due dates show on your calendars.
//
// Each file keeps its own people and keys, so nothing here shares a file
// with anyone: a card added to a board is seen by the board's people, and
// due dates are read only from boards you already have. You can only add
// to files you can edit.

import { canEdit } from '@commonplace/core'
import { readLists, allCards, addCard, updateCard } from '@commonplace/tasks/model'
import { addEvent, dayKey, fromDayKey, addDays } from '@commonplace/calendar/model'

const MAX_ITEMS = 200
const DAY = /^\d{4}-\d{2}-\d{2}$/

export function linkServices (drive) {
  const files = (kind, { editable = false } = {}) => drive.list()
    .filter((f) => f.kind === kind && drive.getDoc(f.docId) && (!editable || canEdit(f.role)))
  const editableDoc = (docId, kind) => {
    const f = drive.describe(docId)
    const doc = drive.getDoc(docId)
    if (!f || !doc || f.kind !== kind) throw new Error('That file is no longer in your Drive.')
    if (!canEdit(f.role)) throw new Error('You can only view that file, so you can’t add to it.')
    return doc
  }

  return {
    // Task boards you can add to, with their lists.
    boards: () => files('tasks', { editable: true }).map((f) => ({ docId: f.docId, title: f.title || 'Untitled board', lists: readLists(drive.getDoc(f.docId).ydoc) })),

    calendars: () => files('calendar', { editable: true }).map((f) => ({ docId: f.docId, title: f.title || 'Untitled calendar' })),

    // items: [{ title, due?: 'YYYY-MM-DD', assignee?: userId }], from a document.
    addCards (boardId, listId, items, from = null) {
      const { ydoc } = editableDoc(boardId, 'tasks')
      const lists = readLists(ydoc)
      const list = lists.find((l) => l.id === listId) || lists[0]
      if (!list) throw new Error('That board has no lists.')
      const clean = (items || []).slice(0, MAX_ITEMS)
        .map((x) => ({ title: String(x.title || '').trim().slice(0, 500), due: DAY.test(x.due || '') ? x.due : null, assignee: typeof x.assignee === 'string' ? x.assignee : null }))
        .filter((x) => x.title)
      ydoc.transact(() => {
        for (const x of clean) {
          const id = addCard(ydoc, list.id, x.title)
          updateCard(ydoc, id, { due: x.due, assignee: x.assignee, notes: from?.title ? `From “${String(from.title).slice(0, 200)}”` : '' })
        }
      }, 'local')
      return { added: clean.length, list: list.name }
    },

    // An all-day event on a day.
    addEvent (calendarId, { title, day }) {
      if (!DAY.test(day || '')) throw new Error('That isn’t a date.')
      const { ydoc } = editableDoc(calendarId, 'calendar')
      ydoc.transact(() => addEvent(ydoc, { title: String(title || '').trim().slice(0, 500) || 'Untitled event', allDay: true, start: day, end: dayKey(addDays(fromDayKey(day), 1)) }), 'local')
      return true
    },

    // Cards with due dates on every board you have, for your calendars.
    dueTasks () {
      const out = []
      for (const f of files('tasks')) {
        for (const c of allCards(drive.getDoc(f.docId).ydoc)) {
          if (c.due && DAY.test(c.due)) out.push({ docId: f.docId, board: f.title || 'Untitled board', cardId: c.id, title: c.title || 'Untitled task', due: c.due, done: Boolean(c.done) })
        }
      }
      return out
    }
  }
}
