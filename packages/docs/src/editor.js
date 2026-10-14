// CommonDocs editor (runs in the window). The editor edits a local Y.Doc
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
import { Pagination, PageBreak } from './pagination.js'

export { pageGeometry, readPage, normalizePage, PAGE_SIZES, DEFAULT_PAGE } from './page.js'

const SizedImage = Image.extend({
  addAttributes () {
    return {
      ...this.parent?.(),
      width: { default: null, parseHTML: (el) => numberAttr(el, 'width'), renderHTML: (a) => (a.width ? { width: a.width } : {}) },
      height: { default: null, parseHTML: (el) => numberAttr(el, 'height'), renderHTML: (a) => (a.height ? { height: a.height } : {}) }
    }
  }
})

function numberAttr (el, name) {
  const v = parseInt(el.getAttribute(name), 10)
  return Number.isFinite(v) ? v : null
}

// kind: 'markdown' | 'paged'
export function createDocsEditor ({ kind, element, ydoc, awareness, user, editable = true, onUpdate, onEditMath, onOpenLink, getPageSetup, getZoom, onLayout }) {
  const paged = kind === 'paged'
  const extensions = [
    // The CRDT keeps its own undo history (per user), so disable the default one.
    StarterKit.configure({
      undoRedo: false,
      heading: { levels: [1, 2, 3] },
      link: { openOnClick: false, autolink: true, linkOnPaste: true, defaultProtocol: 'https', HTMLAttributes: { rel: 'noopener noreferrer', target: null } }
    }),
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
    SizedImage.configure({ allowBase64: true, inline: false }),
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
    color: style.color || '',
    highlight: e.getAttributes('highlight').color || (e.isActive('highlight') ? 'yes' : '')
  }
}

export function setBlock (e, block) {
  const c = e.chain().focus()
  if (block === 'p') return c.setParagraph().run()
  if (block === 'code') return c.toggleCodeBlock().run()
  return c.setHeading({ level: Number(block.slice(1)) }).run()
}
