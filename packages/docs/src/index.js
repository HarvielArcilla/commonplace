// CommonDocs app descriptors. No DOM code here: CommonDrive loads this in the
// background process to create files and render previews. The editor lives in
// ./editor.js and runs in the window.
//
// Two document types share one content format (a ProseMirror tree in the
// Y.XmlFragment "content"), so either can be converted to the other later:
//   markdown - flowing text, Notion-like, round-trips with .md files
//   paged    - real pages with page setup, round-trips with .docx files

import * as Y from 'yjs'
import { DEFAULT_PAGE } from './page.js'

export const CONTENT_FIELD = 'content'

function preview (ydoc) {
  const parts = []
  let length = 0
  const walk = (node) => {
    if (length > 240) return
    if (node instanceof Y.XmlText) {
      const text = node.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
      if (text) { parts.push(text); length += text.length }
    } else if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
      if (node instanceof Y.XmlElement && (node.nodeName === 'inlineMath' || node.nodeName === 'blockMath')) {
        const latex = node.getAttribute('latex')
        if (latex) { parts.push(latex); length += latex.length }
        return
      }
      node.toArray().forEach(walk)
    }
  }
  walk(ydoc.getXmlFragment(CONTENT_FIELD))
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

export const markdownApp = {
  type: 'markdown',
  kind: 'markdown',
  name: 'Markdown document',
  description: 'Flowing text with markdown shortcuts. Imports and exports .md files.',
  schemaVersion: 1,
  exports: ['md', 'docx'],
  initContent (ydoc) { ydoc.getXmlFragment(CONTENT_FIELD) },
  preview
}

export const pagedApp = {
  type: 'paged',
  kind: 'paged',
  name: 'Paged document',
  description: 'Pages, margins, fonts and alignment. Imports and exports .docx files.',
  schemaVersion: 1,
  exports: ['docx', 'pdf', 'md'],
  initContent (ydoc) {
    ydoc.getXmlFragment(CONTENT_FIELD)
    ydoc.getMap('page').set('setup', { ...DEFAULT_PAGE, margins: { ...DEFAULT_PAGE.margins } })
  },
  preview
}

// Files created before there were two types used "docs"; they are markdown.
export const docsApp = { ...markdownApp, type: 'docs', hidden: true }

export const docsApps = [markdownApp, pagedApp, docsApp]

export default docsApp
