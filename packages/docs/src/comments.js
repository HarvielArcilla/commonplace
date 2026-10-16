// Comment threads (see core/threads.js) and suggestion authors, stored in
// the document itself so they sync like everything else. No DOM code: the
// background process reads these too (for counts in Drive).
//
//   ydoc.getMap('suggestions')  id -> { userId, at }

import * as Y from 'yjs'
import { readThreads } from '@commonplace/core/threads'
import { CONTENT_FIELD } from './index.js'

// Threads are shared by every app now; documents anchor them with a mark.
export { addThread, reply, editMessage, deleteMessage, setResolved, readThreads, mentionsIn } from '@commonplace/core/threads'

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
