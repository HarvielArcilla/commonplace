// commonDocs editor (runs in the window). The editor edits a local Y.Doc
// directly; whoever created that Y.Doc is responsible for syncing it.
// That keeps this file free of any networking or Electron code.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { Mathematics } from '@tiptap/extension-mathematics'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import TextAlign from '@tiptap/extension-text-align'
import { TextStyleKit } from '@tiptap/extension-text-style'
import Highlight from '@tiptap/extension-highlight'
import { Markdown } from '@tiptap/markdown'
import { CONTENT_FIELD } from './index.js'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Extension } from '@tiptap/core'
import { ySyncPluginKey } from '@tiptap/y-tiptap'
import { Pagination, PageBreak } from './pagination.js'
import { blockKey } from './index.js'
import { Indent } from './indent.js'
import { CommentMark, Suggestions, ReviewDocument } from './review.js'

export { commentAnchors, suggestionList, isSuggesting, withoutSuggestions } from './review.js'

export { pageGeometry, readPage, normalizePage, PAGE_SIZES, DEFAULT_PAGE } from './page.js'

// What paged documents use when no font or size is set on the text. These
// match the .docx export, so a file looks the same in Word.
export const PAGED_DEFAULTS = {
  font: 'Georgia',
  mono: 'Courier New',
  size: { p: 12, h1: 20, h2: 16, h3: 13, code: 10 } // points
}

function applyImageSize (view, node) {
  const img = view.element
  if (!img) return
  const { width, height } = node.attrs
  const w = width ? `${width}px` : ''
  const h = height ? `${height}px` : ''
  if (img.style.width !== w) img.style.width = w
  if (img.style.height !== h) img.style.height = h
  if (width && height) view.aspectRatio = width / height
}

// Images can be resized by dragging their corners. The width never exceeds
// the text column (getMaxWidth), and the aspect ratio is kept.
function resizableImage (getMaxWidth) {
  return Image.extend({
    addNodeView () {
      const make = this.parent?.()
      if (!make) return null
      return (props) => {
        const view = make(props)
        if (!view) return view
        const max = getMaxWidth?.()
        if (max) view.maxSize = { width: max, height: Infinity }
        // TipTap only applies width/height when the view is created, so a
        // resize made by someone else (or undone) wouldn't show until the
        // file was reopened. Apply them on every update too.
        const update = view.update.bind(view)
        view.update = (node, decorations, inner) => {
          const ok = update(node, decorations, inner)
          if (ok !== false && !view.isResizing) applyImageSize(view, node)
          return ok
        }
        return view
      }
    }
  }).configure({
    allowBase64: true,
    inline: false,
    resize: { enabled: true, directions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'], minWidth: 40, minHeight: 20, alwaysPreserveAspectRatio: true }
  })
}

// Marks paragraphs that have an open conflict. Blocks are matched to their
// CRDT element, the same key conflicts are recorded with.
const conflictKey = new PluginKey('cp-conflicts')
const ConflictHighlight = Extension.create({
  name: 'conflictHighlight',
  addStorage () { return { keys: new Set() } },
  addCommands () {
    return {
      setConflicts: (keys) => ({ tr, dispatch }) => {
        this.storage.keys = new Set(keys)
        if (dispatch) dispatch(tr.setMeta(conflictKey, true).setMeta('addToHistory', false))
        return true
      }
    }
  },
  addProseMirrorPlugins () {
    const storage = this.storage
    return [new Plugin({
      key: conflictKey,
      props: {
        decorations (state) {
          if (!storage.keys.size) return DecorationSet.empty
          const mapping = ySyncPluginKey.getState(state)?.binding?.mapping
          if (!mapping) return DecorationSet.empty
          const byNode = new Map()
          for (const [yType, pmNode] of mapping) {
            const key = blockKey(yType)
            if (key && storage.keys.has(key)) byNode.set(pmNode, key)
          }
          const decos = []
          state.doc.forEach((node, offset) => {
            if (byNode.has(node)) decos.push(Decoration.node(offset, offset + node.nodeSize, { class: 'cp-conflict', 'data-conflict': byNode.get(node) }))
          })
          return DecorationSet.create(state.doc, decos)
        }
      }
    })]
  }
})

// kind: 'markdown' | 'paged'
export function createDocsEditor ({ kind, element, ydoc, awareness, user, editable = true, onUpdate = () => {}, onEditMath, onOpenLink, getPageSetup, getZoom, getMaxImageWidth, onLayout, onNewSuggestion }) {
  const paged = kind === 'paged'
  const extensions = [
    // The CRDT keeps its own undo history (per user), so disable the default one.
    StarterKit.configure({
      undoRedo: false,
      document: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer', target: null } }
    }),
    ReviewDocument,
    Collaboration.configure({ document: ydoc, field: CONTENT_FIELD }),
    CollaborationCaret.configure({
      provider: { awareness },
      user: { name: user.name, color: user.color },
      render (u) {
        const caret = document.createElement('span')
        caret.className = 'cp-caret'
        caret.style.setProperty('--caret-color', u.color)
        const label = document.createElement('span')
        label.className = 'cp-caret-label'
        label.textContent = u.name
        caret.append(label)
        return caret
      },
      selectionRender (u) {
        return { style: `background-color: ${u.color}2e`, class: 'cp-selection' }
      }
    }),
    Mathematics.configure({
      katexOptions: { throwOnError: false, strict: 'ignore' },
      inlineOptions: { onClick: (node, pos) => onEditMath?.({ display: false, latex: node.attrs.latex, pos }) },
      blockOptions: { onClick: (node, pos) => onEditMath?.({ display: true, latex: node.attrs.latex, pos }) }
    }),
    TableKit.configure({ table: { resizable: false } }),
    resizableImage(getMaxImageWidth),
    Indent,
    ConflictHighlight,
    CommentMark,
    Suggestions.configure({ onNewSuggestion: onNewSuggestion || (() => {}) }),
    Markdown,
    PageBreak
  ]
  if (paged) {
    extensions.push(
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      TextStyleKit.configure({ backgroundColor: false, lineHeight: false }),
      Highlight.configure({ multicolor: true }),
      Pagination.configure({ getSetup: getPageSetup, getZoom, onLayout })
    )
  }

  return new Editor({
    element,
    editable,
    extensions,
    editorProps: {
      attributes: { class: `cp-page cp-${kind}`, spellcheck: 'true' },
      handleClick (view, pos, event) {
        // Links open with Ctrl/Cmd+click, so a plain click can still edit them.
        const a = event.target.closest?.('a[href]')
        if (a && (event.metaKey || event.ctrlKey)) {
          onOpenLink?.(a.getAttribute('href'))
          return true
        }
        return false
      }
    },
    onUpdate,
    onSelectionUpdate: onUpdate
  })
}

// Formatting state the toolbar reflects.
export function activeFormats (e) {
  const block = e.isActive('heading', { level: 1 }) ? 'h1'
    : e.isActive('heading', { level: 2 }) ? 'h2'
      : e.isActive('heading', { level: 3 }) ? 'h3'
        : e.isActive('codeBlock') ? 'code'
          : 'p'
  const style = e.getAttributes('textStyle')
  const { font, size } = effectiveTextStyle(e, block)
  return {
    block,
    bold: e.isActive('bold'),
    italic: e.isActive('italic'),
    underline: e.isActive('underline'),
    strike: e.isActive('strike'),
    code: e.isActive('code'),
    link: e.isActive('link'),
    bulletList: e.isActive('bulletList'),
    orderedList: e.isActive('orderedList'),
    blockquote: e.isActive('blockquote'),
    table: e.isActive('table'),
    align: ['center', 'right', 'justify'].find((a) => e.isActive({ textAlign: a })) || 'left',
    fontFamily: style.fontFamily || '',
    fontSize: style.fontSize || '',
    // What the text actually uses, defaults included; 'mixed' if the
    // selection spans more than one.
    font,
    size,
    indent: e.state.selection.$from.parent.attrs.indent || 0,
    color: style.color || '',
    highlight: e.getAttributes('highlight').color || (e.isActive('highlight') ? 'yes' : '')
  }
}

const firstFamily = (stack) => String(stack).split(',')[0].trim().replace(/^["']|["']$/g, '')
const toPt = (v) => {
  const m = /^([\d.]+)\s*(px|pt)?$/.exec(String(v || '').trim())
  if (!m) return null
  const n = parseFloat(m[1])
  return Math.round((m[2] === 'pt' ? n : n * 0.75) * 2) / 2
}
const blockOf = (node) => node.type.name === 'heading' ? `h${node.attrs.level}` : node.type.name === 'codeBlock' ? 'code' : 'p'

// The font and size (in points) of the selected text, defaults included.
export function effectiveTextStyle (e, block) {
  const { state } = e
  const { from, to, empty, $from } = state.selection
  const fonts = new Set()
  const sizes = new Set()
  const add = (marks, b) => {
    const ts = marks.find((m) => m.type.name === 'textStyle')?.attrs || {}
    const code = b === 'code' || marks.some((m) => m.type.name === 'code')
    fonts.add(ts.fontFamily ? firstFamily(ts.fontFamily) : (code ? PAGED_DEFAULTS.mono : PAGED_DEFAULTS.font))
    sizes.add(toPt(ts.fontSize) ?? PAGED_DEFAULTS.size[b])
  }
  if (empty) {
    add(state.storedMarks || $from.marks(), block)
  } else {
    state.doc.nodesBetween(from, to, (node, pos, parent) => {
      if (node.isText) add(node.marks, blockOf(parent))
    })
    if (!fonts.size) add($from.marks(), block)
  }
  return {
    font: fonts.size === 1 ? [...fonts][0] : 'mixed',
    size: sizes.size === 1 ? [...sizes][0] : 'mixed'
  }
}

export function setBlock (e, block) {
  const c = e.chain().focus()
  if (block === 'p') return c.setParagraph().run()
  if (block === 'code') return c.toggleCodeBlock().run()
  return c.setHeading({ level: Number(block.slice(1)) }).run()
}
