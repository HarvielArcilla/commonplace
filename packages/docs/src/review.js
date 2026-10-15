// Reviewing a document: comments and suggested changes (runs in the window).
//
// Comments are anchored with a `comment` mark on the text they're about, so
// the anchor moves with the text as people edit. Several comments can cover
// the same words. The threads themselves live in the document's 'comments'
// map (see ./comments.js).
//
// Suggesting mode turns every edit into a tracked change instead: inserted
// text gets an `insertion` mark, deleted text a `deletion` mark and stays
// visible, formatting changes a `modification` mark. Anyone who can edit can
// accept or reject each suggestion. Who suggested what is kept in the
// document's 'suggestions' map, by suggestion id.

import { Extension, Mark, mergeAttributes } from '@tiptap/core'
import { Document } from '@tiptap/extension-document'
import {
  suggestChanges, suggestChangesKey, isSuggestChangesEnabled, transformToSuggestionTransaction,
  applySuggestion, revertSuggestion, enableSuggestChanges, disableSuggestChanges
} from '@handlewithcare/prosemirror-suggest-changes'

const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('')

// ---- comments ---------------------------------------------------------------

export const CommentMark = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '', // overlapping comments on the same words
  addAttributes () {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-comment'), renderHTML: (a) => ({ 'data-comment': a.id }) } }
  },
  parseHTML () { return [{ tag: 'span[data-comment]' }] },
  renderHTML ({ HTMLAttributes }) { return ['span', mergeAttributes(HTMLAttributes, { class: 'cp-comment' }), 0] },
  addCommands () {
    return {
      addComment: (id) => ({ tr, state, dispatch }) => {
        const { from, to, empty } = state.selection
        if (empty) return false
        // Commenting isn't an edit, even in suggesting mode.
        if (dispatch) dispatch(tr.addMark(from, to, state.schema.marks.comment.create({ id })).setMeta(suggestChangesKey, { skip: true }))
        return true
      },
      removeComment: (id) => ({ tr, state, dispatch }) => {
        const type = state.schema.marks.comment
        state.doc.descendants((node, pos) => {
          for (const m of node.marks) if (m.type === type && m.attrs.id === id) tr.removeMark(pos, pos + node.nodeSize, m)
        })
        if (dispatch) dispatch(tr.setMeta(suggestChangesKey, { skip: true }))
        return true
      }
    }
  }
})

// Where each comment's text is now: Map(id -> { from, to, text }).
export function commentAnchors (editor) {
  const out = new Map()
  const type = editor.schema.marks.comment
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText) return
    for (const m of node.marks) {
      if (m.type !== type) continue
      const a = out.get(m.attrs.id)
      if (a) { a.to = pos + node.nodeSize; a.text += node.text } else out.set(m.attrs.id, { from: pos, to: pos + node.nodeSize, text: node.text })
    }
  })
  return out
}

// ---- suggestions --------------------------------------------------------------

const suggestionMark = (name, tag, excludes, extraAttrs = {}) => Mark.create({
  name,
  inclusive: false,
  excludes,
  addAttributes () {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-id'), renderHTML: (a) => ({ 'data-id': a.id }) },
      ...extraAttrs
    }
  },
  parseHTML () { return [{ tag: `${tag}[data-id]` }] },
  renderHTML ({ HTMLAttributes }) { return [tag, mergeAttributes(HTMLAttributes, { class: `cp-${name}` }), 0] }
})

const Insertion = suggestionMark('insertion', 'ins', 'deletion modification insertion')
const Deletion = suggestionMark('deletion', 'del', 'insertion modification deletion')
const Modification = suggestionMark('modification', 'span', 'deletion insertion', {
  type: { default: null, rendered: false },
  attrName: { default: null, rendered: false },
  previousValue: { default: null, rendered: false },
  newValue: { default: null, rendered: false }
})

// Block-level suggestions (a whole new paragraph) mark the block itself.
export const ReviewDocument = Document.extend({ marks: 'insertion modification deletion' })

const tracked = (tr) => {
  const y = tr.getMeta('y-sync$') || {}
  return !tr.getMeta('history$') && !tr.getMeta('collab$') && !y.isUndoRedoOperation && !y.isChangeOrigin && !('skip' in (tr.getMeta(suggestChangesKey) || {}))
}

export const Suggestions = Extension.create({
  name: 'suggestions',
  addOptions () { return { onNewSuggestion: () => {} } },
  addExtensions () { return [Insertion, Deletion, Modification] },
  addProseMirrorPlugins () {
    return [suggestChanges()]
  },
  // In suggesting mode, every edit I make becomes a suggestion.
  dispatchTransaction ({ transaction, next }) {
    const state = this.editor.state
    if (!isSuggestChangesEnabled(state) || !transaction.docChanged || !tracked(transaction)) return next(transaction)
    const created = []
    const tr = transformToSuggestionTransaction(transaction, state, () => { const id = newId(); created.push(id); return id })
    next(tr)
    if (created.length) queueMicrotask(() => this.options.onNewSuggestion(created))
  },
  addCommands () {
    const run = (cmd) => ({ state, dispatch }) => cmd(state, dispatch)
    return {
      setSuggesting: (on) => run(on ? enableSuggestChanges : disableSuggestChanges),
      acceptSuggestion: (id) => run(applySuggestion(id)),
      rejectSuggestion: (id) => run(revertSuggestion(id))
    }
  }
})

export const isSuggesting = (editor) => isSuggestChangesEnabled(editor.state)

// Every suggestion in document order: [{ id, kinds, inserted, deleted, from }].
export function suggestionList (editor) {
  const { insertion, deletion, modification } = editor.schema.marks
  const out = new Map()
  editor.state.doc.descendants((node, pos) => {
    for (const m of node.marks) {
      if (m.type !== insertion && m.type !== deletion && m.type !== modification) continue
      const s = out.get(m.attrs.id) || { id: m.attrs.id, kinds: new Set(), inserted: '', deleted: '', from: pos }
      s.kinds.add(m.type.name)
      const text = node.isText ? node.text.replace(/​/g, '') : (node.isBlock ? '\n' : '')
      if (m.type === insertion) s.inserted += text
      if (m.type === deletion) s.deleted += text
      out.set(m.attrs.id, s)
    }
  })
  return [...out.values()].map((s) => ({ ...s, kinds: [...s.kinds], inserted: s.inserted.trim(), deleted: s.deleted.trim() }))
}

// The document as it would be if every pending suggestion were rejected:
// what exports use, since suggestions aren't part of the text until accepted.
export function withoutSuggestions (editor) {
  let state = editor.state
  for (const { id } of suggestionList(editor)) revertSuggestion(id)(state, (tr) => { state = state.apply(tr) })
  return state.doc.toJSON()
}
