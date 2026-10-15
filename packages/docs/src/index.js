// commonDocs app descriptors. No DOM code here: commonDrive loads this in the
// background process to create files and render previews. The editor lives in
// ./editor.js and runs in the window.
//
// Two document types share one content format (a ProseMirror tree in the
// Y.XmlFragment "content"), so either can be converted to the other later:
//   markdown - flowing text, Notion-like, round-trips with .md files
//   paged    - real pages with page setup, round-trips with .docx files

import * as Y from 'yjs'
import { DEFAULT_PAGE } from './page.js'
import { reviewCounts } from './comments.js'

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

// Conflict units: each top-level block of the content (paragraph, heading,
// list, table, image...) plus the title. A block is identified by the CRDT
// item that created it, so the same paragraph has the same key everywhere.
const plainText = (node) => {
  if (node instanceof Y.XmlText) return node.toDelta().map((d) => (typeof d.insert === 'string' ? d.insert : '')).join('')
  if (node instanceof Y.XmlElement && (node.nodeName === 'inlineMath' || node.nodeName === 'blockMath')) return `$${node.getAttribute('latex') || ''}$`
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    const parts = node.toArray().map(plainText)
    return node instanceof Y.XmlElement && ['paragraph', 'heading', 'listItem', 'tableCell', 'tableHeader'].includes(node.nodeName) ? parts.join('') : parts.join('\n')
  }
  return ''
}

export const blockKey = (el) => (el?._item ? `${el._item.id.client}:${el._item.id.clock}` : null)

export function snapshotBlock (el) {
  const d = new Y.Doc()
  d.getXmlFragment('block').insert(0, [el.clone()])
  return Buffer.from(Y.encodeStateAsUpdate(d)).toString('base64')
}

function units (ydoc) {
  const out = new Map()
  let prev = null
  ydoc.getXmlFragment(CONTENT_FIELD).toArray().forEach((el, index) => {
    const key = blockKey(el)
    if (!key) return
    out.set(key, { kind: 'block', name: el.nodeName, sig: el.toString(), text: plainText(el), prev, index, el })
    prev = key
  })
  const title = ydoc.getMap('meta').get('title')
  if (title != null) out.set('title', { kind: 'title', sig: String(title), text: String(title), prev: null })
  return out
}

// Applies the owner's decision. choice: 'v0' | 'v1' (one version), 'both'
// (one after the other), or 'current' (keep what the merge produced).
function resolve (ydoc, rec, choice) {
  if (choice === 'current') return
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  if (rec.kind === 'title') {
    const v = picked.find((x) => x.exists)
    if (v) ydoc.getMap('meta').set('title', choice === 'both' ? picked.filter((x) => x.exists).map((x) => x.text).join(' / ') : v.text)
    return
  }
  const frag = ydoc.getXmlFragment(CONTENT_FIELD)
  const arr = frag.toArray()
  let at = arr.findIndex((el) => blockKey(el) === rec.unit)
  if (at >= 0) frag.delete(at, 1)
  else {
    // The merge deleted it: put it back after the block that came before it.
    const p = rec.prev ? arr.findIndex((el) => blockKey(el) === rec.prev) : -1
    at = p >= 0 ? p + 1 : Math.min(rec.index ?? 0, arr.length)
  }
  const clones = picked.filter((v) => v.exists && v.snapshot).map((v) => {
    const d = new Y.Doc()
    Y.applyUpdate(d, Buffer.from(v.snapshot, 'base64'))
    return d.getXmlFragment('block').get(0).clone()
  })
  if (clones.length) frag.insert(at, clones)
}

export const markdownApp = {
  type: 'markdown',
  kind: 'markdown',
  name: 'Markdown document',
  description: 'Flowing text with markdown shortcuts. Imports and exports .md files.',
  schemaVersion: 1,
  exports: ['md', 'docx'],
  initContent (ydoc) { ydoc.getXmlFragment(CONTENT_FIELD) },
  preview,
  units,
  resolve,
  snapshotBlock,
  review: reviewCounts,
  // What restoring an old version puts back (the title always comes back).
  history: { roots: [{ name: CONTENT_FIELD, type: 'xml' }] }
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
  preview,
  units,
  resolve,
  snapshotBlock,
  review: reviewCounts,
  history: { roots: [{ name: CONTENT_FIELD, type: 'xml' }, { name: 'page', type: 'map' }] }
}

// Files created before there were two types used "docs"; they are markdown.
export const docsApp = { ...markdownApp, type: 'docs', hidden: true }

export const docsApps = [markdownApp, pagedApp, docsApp]

export default docsApp
