// CommonDocs app descriptor. This file must stay free of DOM code: CommonDrive
// loads it in the background process to create files and render previews.
// The editor itself lives in ./editor.js and runs in the window.

import * as Y from 'yjs'

export const CONTENT_FIELD = 'content' // Y.XmlFragment holding the ProseMirror doc

export const docsApp = {
  type: 'docs',
  name: 'CommonDocs',
  schemaVersion: 1,

  initContent (ydoc) {
    ydoc.getXmlFragment(CONTENT_FIELD)
  },

  preview (ydoc) {
    const parts = []
    const walk = (node) => {
      if (parts.join(' ').length > 200) return
      if (node instanceof Y.XmlText) {
        parts.push(node.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join(''))
      } else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
        node.toArray().forEach(walk)
      }
    }
    walk(ydoc.getXmlFragment(CONTENT_FIELD))
    return parts.filter(Boolean).join(' · ')
  }
}

export default docsApp
