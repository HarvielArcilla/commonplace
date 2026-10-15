// Comment threads and suggestion authors, stored in the document itself so
// they sync like everything else. No DOM code: the background process reads
// these too (for counts in Drive).
//
//   ydoc.getMap('comments')     id -> Y.Map { quote, userId, at, resolved,
//                               resolvedBy, resolvedAt, messages: Y.Array }
//   ydoc.getMap('suggestions')  id -> { userId, at }
//
// Each message is { id, userId, text, at, editedAt? }. Threads and their
// messages are separate CRDT types, so two people replying at once both land.

import * as Y from 'yjs'
import { CONTENT_FIELD } from './index.js'

const MAX_TEXT = 4000
const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
const clean = (text) => String(text ?? '').trim().slice(0, MAX_TEXT)

export function addThread (ydoc, { id = newId(), quote, userId, text }) {
  const thread = new Y.Map()
  ydoc.transact(() => {
    ydoc.getMap('comments').set(id, thread)
    thread.set('quote', String(quote || '').slice(0, 300))
    thread.set('userId', userId)
    thread.set('at', Date.now())
    thread.set('resolved', false)
    const messages = new Y.Array()
    thread.set('messages', messages)
    messages.push([{ id: newId(), userId, text: clean(text), at: Date.now() }])
  })
  return id
}

export function reply (ydoc, threadId, { userId, text }) {
  const thread = ydoc.getMap('comments').get(threadId)
  if (!thread) return
  ydoc.transact(() => {
    thread.get('messages').push([{ id: newId(), userId, text: clean(text), at: Date.now() }])
    if (thread.get('resolved')) thread.set('resolved', false) // a reply reopens it
  })
}

// Only the author of a message can change or delete it.
export function editMessage (ydoc, threadId, messageId, { userId, text }) {
  const messages = ydoc.getMap('comments').get(threadId)?.get('messages')
  const i = messages ? messages.toArray().findIndex((m) => m.id === messageId) : -1
  if (i < 0 || messages.get(i).userId !== userId) return
  ydoc.transact(() => {
    const m = messages.get(i)
    messages.delete(i, 1)
    messages.insert(i, [{ ...m, text: clean(text), editedAt: Date.now() }])
  })
}

export function deleteMessage (ydoc, threadId, messageId, { userId }) {
  const comments = ydoc.getMap('comments')
  const messages = comments.get(threadId)?.get('messages')
  const i = messages ? messages.toArray().findIndex((m) => m.id === messageId) : -1
  if (i < 0 || messages.get(i).userId !== userId) return
  ydoc.transact(() => {
    messages.delete(i, 1)
    if (!messages.length) comments.delete(threadId)
  })
}

export function setResolved (ydoc, threadId, resolved, { userId }) {
  const thread = ydoc.getMap('comments').get(threadId)
  if (!thread) return
  ydoc.transact(() => {
    thread.set('resolved', Boolean(resolved))
    thread.set('resolvedBy', resolved ? userId : null)
    thread.set('resolvedAt', resolved ? Date.now() : null)
  })
}

export function readThreads (ydoc) {
  const out = []
  for (const [id, t] of ydoc.getMap('comments')) {
    if (!(t instanceof Y.Map)) continue
    const messages = t.get('messages')?.toArray() || []
    if (!messages.length) continue
    out.push({
      id,
      quote: t.get('quote') || '',
      userId: t.get('userId'),
      at: t.get('at') || 0,
      resolved: Boolean(t.get('resolved')),
      resolvedBy: t.get('resolvedBy') || null,
      resolvedAt: t.get('resolvedAt') || null,
      messages
    })
  }
  return out.sort((a, b) => a.at - b.at)
}

export function recordSuggestions (ydoc, ids, userId) {
  const map = ydoc.getMap('suggestions')
  ydoc.transact(() => { for (const id of ids) if (!map.has(id)) map.set(id, { userId, at: Date.now() }) })
}

export const suggestionAuthor = (ydoc, id) => ydoc.getMap('suggestions').get(id) || null

// Open comments and pending suggestions, for the Drive list.
export function reviewCounts (ydoc) {
  const comments = readThreads(ydoc).filter((t) => !t.resolved).length
  const ids = new Set()
  const walk = (node) => {
    if (node instanceof Y.XmlText) {
      for (const d of node.toDelta()) {
        for (const [key, value] of Object.entries(d.attributes || {})) {
          if (/^(insertion|deletion|modification)(--|$)/.test(key) && value?.id != null) ids.add(value.id)
        }
      }
    } else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      node.toArray().forEach(walk)
    }
  }
  walk(ydoc.getXmlFragment(CONTENT_FIELD))
  return { comments, suggestions: ids.size }
}
