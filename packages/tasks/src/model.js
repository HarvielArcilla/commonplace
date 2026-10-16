// commonTasks data model, on top of the file's Y.Doc. No DOM code.
//
//   ydoc.getArray('lists')     list (column) ids, in order
//   ydoc.getMap('listData')    id -> Y.Map { name }
//   ydoc.getMap('cards')       id -> Y.Map {
//                                title, notes: text
//                                list:  the list it's in
//                                pos:   a number that orders cards within a list
//                                done:  bool
//                                due:   'YYYY-MM-DD' or null
//                                assignee: userId or null
//                                created: ms
//                              }
//
// Cards are a map rather than arrays per list, so moving a card is setting
// two fields: two people moving different cards never collide, and moving
// the same card ends wherever the last move put it. A card's place within
// a list is a number between its neighbors'.

import * as Y from 'yjs'

export const LISTS = 'lists'
export const LIST_DATA = 'listData'
export const CARDS = 'cards'

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

export function initTasks (ydoc) {
  ydoc.transact(() => {
    for (const name of ['To do', 'Doing', 'Done']) addList(ydoc, name)
  })
}

export function addList (ydoc, name = 'New list', { after = null } = {}) {
  const id = newId()
  ydoc.transact(() => {
    const l = new Y.Map()
    ydoc.getMap(LIST_DATA).set(id, l)
    l.set('name', name)
    const order = ydoc.getArray(LISTS)
    const at = after ? order.toArray().indexOf(after) + 1 : order.length
    order.insert(Math.max(0, at), [id])
  })
  return id
}

export function renameList (ydoc, id, name) {
  ydoc.getMap(LIST_DATA).get(id)?.set('name', name)
}

// Removes a list; its cards move to the first other list (or go, if none).
export function deleteList (ydoc, id) {
  ydoc.transact(() => {
    const moving = allCards(ydoc).filter((c) => c.list === id)
    const order = ydoc.getArray(LISTS)
    const i = order.toArray().indexOf(id)
    if (i >= 0) order.delete(i, 1)
    ydoc.getMap(LIST_DATA).delete(id)
    const target = readLists(ydoc)[0]?.id
    for (const c of moving) {
      if (target) moveCard(ydoc, c.id, target, null)
      else ydoc.getMap(CARDS).delete(c.id)
    }
  })
}

export function moveList (ydoc, id, by) {
  const order = ydoc.getArray(LISTS)
  const ids = order.toArray()
  const i = ids.indexOf(id)
  const j = i + by
  if (i < 0 || j < 0 || j >= ids.length) return
  ydoc.transact(() => { order.delete(i, 1); order.insert(j, [id]) })
}

export function readLists (ydoc) {
  const data = ydoc.getMap(LIST_DATA)
  const seen = new Set()
  return ydoc.getArray(LISTS).toArray().filter((id) => data.has(id) && !seen.has(id) && seen.add(id)).map((id) => ({ id, name: data.get(id).get('name') || '' }))
}

export function readCard (ydoc, id) {
  const c = ydoc.getMap(CARDS).get(id)
  return c ? { id, ...c.toJSON() } : null
}

export function allCards (ydoc) {
  return [...ydoc.getMap(CARDS).keys()].map((id) => readCard(ydoc, id))
}

// Cards in a list, in order. Cards whose list is gone show in the first list.
export function cardsIn (ydoc, listId) {
  const lists = readLists(ydoc)
  const known = new Set(lists.map((l) => l.id))
  const home = (c) => (known.has(c.list) ? c.list : lists[0]?.id)
  return allCards(ydoc).filter((c) => home(c) === listId).sort((a, b) => (a.pos - b.pos) || (a.id < b.id ? -1 : 1))
}

export function addCard (ydoc, listId, title = '', { top = false } = {}) {
  const id = newId()
  const cards = cardsIn(ydoc, listId)
  const pos = !cards.length ? 1 : top ? cards[0].pos - 1 : cards[cards.length - 1].pos + 1
  ydoc.transact(() => {
    const c = new Y.Map()
    ydoc.getMap(CARDS).set(id, c)
    c.set('title', title)
    c.set('notes', '')
    c.set('list', listId)
    c.set('pos', pos)
    c.set('done', false)
    c.set('due', null)
    c.set('assignee', null)
    c.set('created', Date.now())
  })
  return id
}

export function updateCard (ydoc, id, patch) {
  const c = ydoc.getMap(CARDS).get(id)
  if (!c) return
  ydoc.transact(() => { for (const [k, v] of Object.entries(patch)) c.set(k, v) })
}

export function deleteCard (ydoc, id) {
  ydoc.getMap(CARDS).delete(id)
}

// Moves a card into a list, before `beforeId` (or to the end).
export function moveCard (ydoc, id, listId, beforeId = null) {
  const others = cardsIn(ydoc, listId).filter((c) => c.id !== id)
  const i = beforeId ? others.findIndex((c) => c.id === beforeId) : -1
  let pos
  if (!others.length) pos = 1
  else if (i < 0) pos = others[others.length - 1].pos + 1
  else if (i === 0) pos = others[0].pos - 1
  else pos = (others[i - 1].pos + others[i].pos) / 2
  updateCard(ydoc, id, { list: listId, pos })
}

export function counts (ydoc) {
  const cards = allCards(ydoc)
  return { total: cards.length, done: cards.filter((c) => c.done).length }
}

export function preview (ydoc) {
  const { total, done } = counts(ydoc)
  if (!total) return 'No tasks yet'
  const open = allCards(ydoc).filter((c) => !c.done).slice(0, 3).map((c) => c.title || 'Untitled task')
  return `${done} of ${total} done${open.length ? ` · ${open.join(' · ')}` : ''}`
}

export function thumbnail (ydoc) {
  return {
    lists: readLists(ydoc).slice(0, 4).map((l) => ({ name: l.name, cards: cardsIn(ydoc, l.id).slice(0, 4).map((c) => ({ title: c.title, done: c.done })), count: cardsIn(ydoc, l.id).length }))
  }
}
