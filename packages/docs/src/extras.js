// Find and replace, footnotes, a table of contents and word counts for
// commonDocs. Runs in the window, as part of the editor.

import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

// ---- find and replace ---------------------------------------------------------------

const searchKey = new PluginKey('cp-search')

// Every match of `query` in the text, as document positions. Text is read
// per textblock, so a match never spans two paragraphs.
export function findMatches (doc, query, { caseSensitive = false } = {}) {
  const out = []
  if (!query) return out
  const needle = caseSensitive ? query : query.toLocaleLowerCase()
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    let text = ''
    const map = [] // text offset -> document position
    node.forEach((child, offset) => {
      if (child.isText) { for (let i = 0; i < child.text.length; i++) map.push(pos + 1 + offset + i); text += child.text } else { map.push(-1); text += '￼' }
    })
    const hay = caseSensitive ? text : text.toLocaleLowerCase()
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + Math.max(1, needle.length))) {
      const from = map[i]
      const to = map[i + needle.length - 1]
      if (from >= 0 && to >= 0) out.push({ from, to: to + 1 })
    }
    return false
  })
  return out
}

export const Search = Extension.create({
  name: 'search',
  addStorage () { return { query: '', caseSensitive: false, matches: [], current: -1 } },
  addCommands () {
    const s = this.storage
    const refresh = (tr, dispatch) => { if (dispatch) dispatch(tr.setMeta(searchKey, true).setMeta('addToHistory', false)); return true }
    const select = (editor, i) => {
      const m = s.matches[i]
      if (!m) return
      s.current = i
      const { view } = editor
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to)).setMeta(searchKey, true).scrollIntoView())
    }
    return {
      setSearch: (query, { caseSensitive = false } = {}) => ({ tr, dispatch }) => {
        s.query = String(query || '')
        s.caseSensitive = Boolean(caseSensitive)
        s.current = -1
        return refresh(tr, dispatch)
      },
      findNext: () => ({ editor }) => {
        if (!s.matches.length) return false
        const at = editor.state.selection.to
        const i = s.current >= 0 ? (s.current + 1) % s.matches.length : Math.max(0, s.matches.findIndex((m) => m.from >= at))
        select(editor, i)
        return true
      },
      findPrevious: () => ({ editor }) => {
        if (!s.matches.length) return false
        select(editor, s.current > 0 ? s.current - 1 : s.matches.length - 1)
        return true
      },
      replaceMatch: (text) => ({ editor }) => {
        const m = s.matches[s.current]
        if (!m) return editor.commands.findNext()
        editor.chain().insertContentAt({ from: m.from, to: m.to }, text).run()
        s.current = -1
        return editor.commands.findNext()
      },
      // One transaction, last match first, so positions stay valid.
      replaceAll: (text) => ({ state, dispatch }) => {
        const matches = findMatches(state.doc, s.query, s)
        if (!matches.length) return false
        const tr = state.tr
        for (const m of [...matches].reverse()) {
          if (text) tr.insertText(text, m.from, m.to)
          else tr.delete(m.from, m.to)
        }
        if (dispatch) dispatch(tr)
        s.lastReplaced = matches.length
        return true
      }
    }
  },
  addProseMirrorPlugins () {
    const s = this.storage
    return [new Plugin({
      key: searchKey,
      state: {
        init: () => DecorationSet.empty,
        apply (tr, old, _prev, next) {
          if (!s.query) { s.matches = []; return DecorationSet.empty }
          if (!tr.docChanged && !tr.getMeta(searchKey)) return old.map(tr.mapping, tr.doc)
          s.matches = findMatches(next.doc, s.query, s)
          if (s.current >= s.matches.length) s.current = -1
          return DecorationSet.create(next.doc, s.matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === s.current ? 'cp-found current' : 'cp-found' })))
        }
      },
      props: { decorations (state) { return this.getState(state) } }
    })]
  }
})

// ---- footnotes ---------------------------------------------------------------------

// A footnote is a small inline node holding its own text. The number is
// its place in the document, so notes renumber themselves; all notes are
// listed at the end, under "Notes".
const notesKey = new PluginKey('cp-footnotes')

export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions () { return { onEdit: null } },
  addAttributes () {
    return { text: { default: '', parseHTML: (el) => el.getAttribute('data-text') || '', renderHTML: (a) => ({ 'data-text': a.text }) } }
  },
  parseHTML () { return [{ tag: 'sup[data-type="footnote"]' }] },
  renderHTML ({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { 'data-type': 'footnote', class: 'cp-footnote' })]
  },
  // Placeholders; the exporter adds the notes themselves at the end.
  renderMarkdown () { return '[^cp-note]' },
  addCommands () {
    return {
      insertFootnote: (text = '') => ({ chain }) => chain().insertContent({ type: this.name, attrs: { text } }).run(),
      setFootnote: (pos, text) => ({ tr, dispatch }) => {
        const node = tr.doc.nodeAt(pos)
        if (node?.type.name !== this.name) return false
        if (dispatch) dispatch(tr.setNodeMarkup(pos, null, { ...node.attrs, text }))
        return true
      }
    }
  },
  addKeyboardShortcuts () {
    return { 'Mod-Alt-f': () => { this.options.onEdit?.({ text: '', pos: null }); return true } }
  },
  addProseMirrorPlugins () {
    const onEdit = this.options.onEdit
    const name = this.name
    return [new Plugin({
      key: notesKey,
      props: {
        decorations (state) {
          const decos = []
          const notes = []
          state.doc.descendants((node, pos) => {
            if (node.type.name !== name) return true
            notes.push({ n: notes.length + 1, text: node.attrs.text, pos })
            decos.push(Decoration.node(pos, pos + node.nodeSize, { 'data-n': String(notes.length) }))
            return false
          })
          if (notes.length) {
            decos.push(Decoration.widget(state.doc.content.size, () => {
              const box = document.createElement('section')
              box.className = 'cp-notes'
              box.contentEditable = 'false'
              const h = document.createElement('p')
              h.className = 'cp-notes-title'
              h.textContent = 'Notes'
              const ol = document.createElement('ol')
              for (const note of notes) {
                const li = document.createElement('li')
                li.textContent = note.text || 'Empty note'
                if (!note.text) li.classList.add('empty')
                li.addEventListener('mousedown', (e) => { e.preventDefault(); onEdit?.({ text: note.text, pos: note.pos }) })
                ol.append(li)
              }
              box.append(h, ol)
              return box
            }, { side: 1, key: `notes:${notes.map((x) => x.text).join('\u0000')}` }))
          }
          return DecorationSet.create(state.doc, decos)
        },
        handleClickOn (view, pos, node) {
          if (node.type.name !== name) return false
          onEdit?.({ text: node.attrs.text, pos })
          return true
        }
      }
    })]
  }
})

// Footnotes in order: [{ n, text }], for exports.
export function footnotesOf (json) {
  const out = []
  const walk = (n) => {
    if (n.type === 'footnote') out.push({ n: out.length + 1, text: n.attrs?.text || '' })
    for (const c of n.content || []) walk(c)
  }
  walk(json || {})
  return out
}

// ---- table of contents ---------------------------------------------------------------

// A block that lists the document's headings, kept up to date as they
// change; clicking one goes there.
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML () { return [{ tag: 'nav[data-type="toc"]' }] },
  renderHTML ({ HTMLAttributes }) { return ['nav', mergeAttributes(HTMLAttributes, { 'data-type': 'toc', class: 'cp-toc' })] },
  renderMarkdown () { return '[[toc]]' },
  addCommands () {
    return { insertTableOfContents: () => ({ chain }) => chain().insertContent({ type: this.name }).createParagraphNear().run() }
  },
  addNodeView () {
    return ({ editor, getPos }) => {
      const dom = document.createElement('nav')
      dom.className = 'cp-toc'
      dom.setAttribute('data-type', 'toc')
      dom.contentEditable = 'false'
      let sig = ''
      const draw = () => {
        const items = headingsOf(editor.state.doc, typeof getPos === 'function' ? getPos() : 0)
        const next = JSON.stringify(items.map((h) => [h.level, h.text]))
        if (next === sig) return
        sig = next
        const title = document.createElement('p')
        title.className = 'cp-toc-title'
        title.textContent = 'Contents'
        const list = document.createElement('ol')
        for (const h of items) {
          const li = document.createElement('li')
          li.className = `cp-toc-${h.level}`
          li.textContent = h.text || 'Untitled heading'
          li.addEventListener('mousedown', (e) => {
            e.preventDefault()
            editor.chain().setTextSelection(h.pos + 1).scrollIntoView().run()
            editor.view.dom.querySelectorAll('h1, h2, h3')[h.index]?.scrollIntoView({ block: 'center' })
          })
          list.append(li)
        }
        if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Headings you add will be listed here.'; list.append(li) }
        dom.replaceChildren(title, list)
      }
      draw()
      editor.on('update', draw)
      return { dom, ignoreMutation: () => true, stopEvent: () => false, destroy: () => editor.off('update', draw) }
    }
  }
})

// Headings in the document: [{ level, text, pos, index }].
export function headingsOf (doc) {
  const out = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') { out.push({ level: node.attrs.level, text: node.textContent.trim(), pos, index: out.length }); return false }
    return !node.isTextblock
  })
  return out
}

// ---- word count -----------------------------------------------------------------------

const WORD = /[\p{L}\p{N}]+(?:['’\-.][\p{L}\p{N}]+)*/gu

export function countText (text) {
  return { words: (String(text).match(WORD) || []).length, characters: [...String(text).replace(/\s/g, '')].length }
}

// Words in the document (or the selection): footnotes count, comments don't.
export function wordCount (state, { selection = false } = {}) {
  const { from, to } = selection ? state.selection : { from: 0, to: state.doc.content.size }
  let text = ''
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.isText) text += node.text.slice(Math.max(0, from - pos), to - pos) + ' '
    else if (node.type.name === 'footnote') text += ` ${node.attrs.text} `
    else if (node.isBlock) text += '\n'
    return true
  })
  let paragraphs = 0
  state.doc.nodesBetween(from, to, (node) => { if (node.isTextblock && node.textContent.trim()) paragraphs++; return !node.isTextblock })
  return { ...countText(text), paragraphs }
}
