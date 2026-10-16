// Comment threads, for every kind of file, stored in the file itself so they
// sync like everything else. No DOM or Node code: the window and the
// background process (for counts and activity) both read these.
//
//   ydoc.getMap('comments')  id -> Y.Map { quote, anchor, userId, at, resolved,
//                            resolvedBy, resolvedAt, messages: Y.Array }
//
// `anchor` says what the thread is about, in the app's own terms (a cell, a
// card, a slide...): { kind, ...ids }. Documents anchor threads to text with
// a mark instead, and leave it out. Each message is { id, userId, text, at,
// editedAt?, mentions? } where mentions lists the userIds @-mentioned in it.
// Threads and their messages are separate CRDT types, so two people
// replying at once both land.

import * as Y from 'yjs'

export const COMMENTS = 'comments'
const MAX_TEXT = 4000
const MAX_MENTIONS = 20
const newId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')
const clean = (text) => String(text ?? '').trim().slice(0, MAX_TEXT)
const cleanMentions = (list) => [...new Set((Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && /^[0-9a-f]{64}$/.test(u)))].slice(0, MAX_MENTIONS)
const cleanAnchor = (a) => {
  if (!a || typeof a !== 'object') return null
  const out = {}
  for (const [k, v] of Object.entries(a).slice(0, 8)) if (typeof v === 'string' || typeof v === 'number') out[k] = typeof v === 'string' ? v.slice(0, 100) : v
  return typeof out.kind === 'string' ? out : null
}

function message (userId, text, mentions) {
  const m = { id: newId(), userId, text: clean(text), at: Date.now() }
  const list = cleanMentions(mentions)
  if (list.length) m.mentions = list
  return m
}

export function addThread (ydoc, { id = newId(), quote = '', anchor = null, userId, text, mentions = [] }) {
  const thread = new Y.Map()
  ydoc.transact(() => {
    ydoc.getMap(COMMENTS).set(id, thread)
    thread.set('quote', String(quote || '').slice(0, 300))
    const a = cleanAnchor(anchor)
    if (a) thread.set('anchor', a)
    thread.set('userId', userId)
    thread.set('at', Date.now())
    thread.set('resolved', false)
    const messages = new Y.Array()
    thread.set('messages', messages)
    messages.push([message(userId, text, mentions)])
  })
  return id
}

export function reply (ydoc, threadId, { userId, text, mentions = [] }) {
  const thread = ydoc.getMap(COMMENTS).get(threadId)
  if (!thread) return
  ydoc.transact(() => {
    thread.get('messages').push([message(userId, text, mentions)])
    if (thread.get('resolved')) thread.set('resolved', false) // a reply reopens it
  })
}

// Only the author of a message can change or delete it.
export function editMessage (ydoc, threadId, messageId, { userId, text, mentions }) {
  const messages = ydoc.getMap(COMMENTS).get(threadId)?.get('messages')
  const i = messages ? messages.toArray().findIndex((m) => m.id === messageId) : -1
  if (i < 0 || messages.get(i).userId !== userId) return
  ydoc.transact(() => {
    const m = messages.get(i)
    const next = { ...m, text: clean(text), editedAt: Date.now() }
    if (mentions) { const list = cleanMentions(mentions); if (list.length) next.mentions = list; else delete next.mentions }
    messages.delete(i, 1)
    messages.insert(i, [next])
  })
}

export function deleteMessage (ydoc, threadId, messageId, { userId }) {
  const comments = ydoc.getMap(COMMENTS)
  const messages = comments.get(threadId)?.get('messages')
  const i = messages ? messages.toArray().findIndex((m) => m.id === messageId) : -1
  if (i < 0 || messages.get(i).userId !== userId) return
  ydoc.transact(() => {
    messages.delete(i, 1)
    if (!messages.length) comments.delete(threadId)
  })
}

export function setResolved (ydoc, threadId, resolved, { userId }) {
  const thread = ydoc.getMap(COMMENTS).get(threadId)
  if (!thread) return
  ydoc.transact(() => {
    thread.set('resolved', Boolean(resolved))
    thread.set('resolvedBy', resolved ? userId : null)
    thread.set('resolvedAt', resolved ? Date.now() : null)
  })
}

export function readThreads (ydoc) {
  const out = []
  for (const [id, t] of ydoc.getMap(COMMENTS)) {
    if (!(t instanceof Y.Map)) continue
    const messages = (t.get('messages')?.toArray() || []).filter((m) => m && typeof m === 'object')
    if (!messages.length) continue
    out.push({
      id,
      quote: t.get('quote') || '',
      anchor: cleanAnchor(t.get('anchor')),
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

export const openThreadCount = (ydoc) => readThreads(ydoc).filter((t) => !t.resolved).length

// Mentions are written "@Name" in the text; this finds who of `people`
// ([{ userId, name }]) is still mentioned, longest names first.
// "@Maya Lin" mentions Maya Lin, not Maya.
export function mentionsIn (text, people) {
  const out = []
  let rest = String(text)
  const sorted = [...people].filter((p) => p.name).sort((a, b) => b.name.length - a.name.length)
  for (const p of sorted) {
    const re = new RegExp(`@${p.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'gu')
    if (!re.test(rest)) continue
    out.push(p.userId)
    rest = rest.replace(re, ' ')
  }
  return cleanMentions(out)
}
