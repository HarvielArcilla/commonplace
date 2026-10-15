// The rich-text editor inside a slide's text box or shape (runs in the
// window). Each box edits its own Y.XmlFragment, so people typing in
// different boxes never touch each other's text.

import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Collaboration from '@tiptap/extension-collaboration'
import { TextStyleKit } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'

export function createTextEditor ({ element, fragment, editable = true, placeholder = '', onUpdate = () => {}, onFocus = () => {}, onBlur = () => {} }) {
  return new Editor({
    element,
    editable,
    extensions: [
      StarterKit.configure({ undoRedo: false, heading: false, codeBlock: false, blockquote: false, horizontalRule: false, link: false, trailingNode: false }),
      Collaboration.configure({ fragment }),
      TextStyleKit.configure({ backgroundColor: false, lineHeight: false, fontFamily: false }),
      Placeholder.configure({ placeholder })
    ],
    editorProps: { attributes: { class: 'slide-text', spellcheck: 'true' } },
    onUpdate,
    onSelectionUpdate: onUpdate,
    onFocus,
    onBlur
  })
}
