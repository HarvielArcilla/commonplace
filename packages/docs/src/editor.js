// CommonDocs editor (runs in the window). The editor edits a local Y.Doc
// directly; whoever created that Y.Doc is responsible for syncing it.
// That keeps this file free of any networking or Electron code.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import CollaborationCaret from '@tiptap/extension-collaboration-caret'
import { CONTENT_FIELD } from './index.js'

export function createDocsEditor ({ element, ydoc, awareness, user, editable = true, onUpdate }) {
  return new Editor({
    element,
    editable,
    extensions: [
      // The CRDT keeps its own undo history (per user), so disable the default one.
      StarterKit.configure({ undoRedo: false }),
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
      })
    ],
    editorProps: { attributes: { class: 'cp-page', spellcheck: 'true' } },
    onUpdate,
    onSelectionUpdate: onUpdate
  })
}

// Toolbar commands, kept here so every host renders the same set.
export const docsCommands = [
  { id: 'bold', label: 'Bold', key: 'Mod-B', run: (e) => e.chain().focus().toggleBold().run(), active: (e) => e.isActive('bold') },
  { id: 'italic', label: 'Italic', key: 'Mod-I', run: (e) => e.chain().focus().toggleItalic().run(), active: (e) => e.isActive('italic') },
  { id: 'strike', label: 'Strikethrough', run: (e) => e.chain().focus().toggleStrike().run(), active: (e) => e.isActive('strike') },
  { sep: true },
  { id: 'h1', label: 'Heading', run: (e) => e.chain().focus().toggleHeading({ level: 1 }).run(), active: (e) => e.isActive('heading', { level: 1 }) },
  { id: 'h2', label: 'Subheading', run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(), active: (e) => e.isActive('heading', { level: 2 }) },
  { id: 'bullet', label: 'Bulleted list', run: (e) => e.chain().focus().toggleBulletList().run(), active: (e) => e.isActive('bulletList') },
  { id: 'ordered', label: 'Numbered list', run: (e) => e.chain().focus().toggleOrderedList().run(), active: (e) => e.isActive('orderedList') },
  { id: 'quote', label: 'Quote', run: (e) => e.chain().focus().toggleBlockquote().run(), active: (e) => e.isActive('blockquote') },
  { id: 'code', label: 'Code block', run: (e) => e.chain().focus().toggleCodeBlock().run(), active: (e) => e.isActive('codeBlock') },
  { sep: true },
  { id: 'undo', label: 'Undo your last change', key: 'Mod-Z', run: (e) => e.chain().focus().undo().run(), active: () => false },
  { id: 'redo', label: 'Redo', key: 'Mod-Shift-Z', run: (e) => e.chain().focus().redo().run(), active: () => false }
]
