// Pagination for paged documents.
//
// The document stays one continuous ProseMirror editor. After each change we
// measure where every block and every line of text would sit with no page
// breaks at all, then decide where pages end. Where a page runs out we insert
// an invisible spacer (a widget decoration, never part of the document or the
// CRDT) tall enough to push what follows to the top of the next page:
//
//   - between blocks, for things that can't be split (images, tables, math,
//     code, list items), and
//   - inside a paragraph or heading, right before the first line that
//     doesn't fit, so long paragraphs continue on the next page like in Word.
//
// Measuring with the spacers temporarily hidden is what keeps this stable: the
// result never depends on the spacers it produces, so it can't oscillate.
// Hiding and restoring happen in the same frame, so nothing flickers.
//
// Widow and orphan control: a paragraph never leaves a single line at the
// bottom of a page or carries a single line onto the next one, when it has
// enough lines to avoid it.

import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { pageGeometry } from './page.js'

export const paginationKey = new PluginKey('cp-pagination')

const EPS = 0.5
const SPLITTABLE = new Set(['paragraph', 'heading'])

export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML () {
    return [
      { tag: 'div[data-type="page-break"]' },
      { tag: 'hr[data-type="page-break"]' }
    ]
  },
  renderHTML ({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'page-break', class: 'cp-manual-break', contenteditable: 'false' })]
  },
  renderMarkdown () {
    return '<div data-type="page-break"></div>'
  },
  addCommands () {
    return {
      setPageBreak: () => ({ chain }) => chain().insertContent({ type: this.name }).createParagraphNear().run()
    }
  },
  addKeyboardShortcuts () {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() }
  }
})

// Decides where pages break.
//
// units: top-level pieces in document order, positions in natural layout
// (no spacers), relative to the top of the first page's text area:
//   { top, bottom }                  - a block that moves as a whole
//   { top, bottom, lines: [{top,bottom}] } - a paragraph that may split
//   { top, bottom, forced: true }    - a manual page break
// Returns { breaks: [{ unit, line?, height }], pages }.
// `line` (index into unit.lines) means "break inside the paragraph, before
// that line"; without it the break goes before the whole unit.
export function computeBreaks (units, geo) {
  const usable = geo.contentHeight
  const stride = geo.height + geo.gap
  const breaks = []
  let page = 0
  let shift = 0
  let force = false

  const pageTop = () => page * stride
  const pageEnd = () => page * stride + usable
  const atPageTop = (naturalTop) => naturalTop + shift <= pageTop() + EPS
  const breakBefore = (naturalTop, unit, line) => {
    page++
    const height = pageTop() - (naturalTop + shift)
    if (height > 0) {
      breaks.push(line == null ? { unit, height } : { unit, line, height })
      shift += height
    }
  }
  // Content taller than a page runs onto the next sheets.
  const overflow = (naturalBottom) => {
    while (naturalBottom + shift > pageEnd() + EPS) page++
  }

  units.forEach((u, i) => {
    if (force) {
      force = false
      if (!atPageTop(u.top)) breakBefore(u.top, i)
    }
    if (u.forced) {
      overflow(u.bottom)
      force = true
      return
    }
    const lines = u.lines
    if (!lines || lines.length < 2) {
      if (u.bottom + shift > pageEnd() + EPS && !atPageTop(u.top)) breakBefore(u.top, i)
      overflow(u.bottom)
      return
    }
    for (let j = 0; j < lines.length; j++) {
      const ln = lines[j]
      if (ln.bottom + shift <= pageEnd() + EPS) continue
      if (atPageTop(ln.top)) { overflow(ln.bottom); continue }
      // Choose where to break: never strand one line at the bottom (orphan)
      // or carry just the last line over (widow), if there are enough lines.
      let at = j
      if (lines.length >= 3 && at === lines.length - 1) at = at - 1
      if (at === 1 && lines.length >= 2) at = 0
      if (at === 0) {
        if (atPageTop(u.top)) { overflow(ln.bottom); continue }
        breakBefore(u.top, i)
      } else {
        breakBefore(lines[at].top, i, at)
      }
      j = at // re-check from the line that now starts the page
    }
    overflow(u.bottom)
  })
  return { breaks, pages: page + 1 }
}

// Groups the client rects of a block's text into line boxes.
function lineBoxes (dom, toLocal) {
  const range = document.createRange()
  range.selectNodeContents(dom)
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0)
  range.detach?.()
  rects.sort((a, b) => a.top - b.top)
  const lines = []
  for (const r of rects) {
    const top = toLocal(r.top)
    const bottom = toLocal(r.bottom)
    const last = lines[lines.length - 1]
    // Same line if it overlaps vertically with the line so far.
    if (last && top < last.bottom - 2) {
      last.top = Math.min(last.top, top)
      last.bottom = Math.max(last.bottom, bottom)
    } else {
      lines.push({ top, bottom })
    }
  }
  return lines
}

// Finds the document position where a given line of a textblock starts.
function lineStartPos (view, blockPos, node, lineTop, toLocal) {
  let lo = blockPos + 1
  let hi = blockPos + node.nodeSize - 1
  let found = hi
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    let top
    try { top = toLocal(view.coordsAtPos(mid, 1).top) } catch { top = -Infinity }
    if (top >= lineTop - 2) { found = mid; hi = mid - 1 } else lo = mid + 1
  }
  return found
}

function sameBreaks (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].pos !== b[i].pos || a[i].inline !== b[i].inline || Math.abs(a[i].height - b[i].height) > 0.5) return false
  }
  return true
}

export const Pagination = Extension.create({
  name: 'pagination',

  addOptions () {
    return {
      getSetup: () => null, // returns the current page setup
      getZoom: () => 1, // CSS zoom applied to the pages (measured boxes are divided by it)
      onLayout: () => {} // ({ pages, geometry }) after each layout pass
    }
  },

  addStorage () {
    return { refresh: () => {}, pages: 1 }
  },

  addProseMirrorPlugins () {
    const ext = this
    return [new Plugin({
      key: paginationKey,
      state: {
        init: () => ({ breaks: [] }),
        apply (tr, prev) {
          const meta = tr.getMeta(paginationKey)
          if (meta) return meta
          if (!tr.docChanged) return prev
          return { breaks: prev.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos, -1) })) }
        }
      },
      props: {
        decorations (state) {
          const { breaks } = paginationKey.getState(state)
          if (!breaks.length) return DecorationSet.empty
          return DecorationSet.create(state.doc, breaks.map((b) => Decoration.widget(b.pos, () => {
            const el = document.createElement(b.inline ? 'span' : 'div')
            el.className = b.inline ? 'cp-pagebreak cp-pagebreak-inline' : 'cp-pagebreak'
            el.style.height = `${b.height}px`
            el.setAttribute('contenteditable', 'false')
            el.setAttribute('aria-hidden', 'true')
            return el
          }, { side: -1, key: `pb:${b.inline ? 'i' : 'b'}:${b.pos}:${Math.round(b.height * 2)}`, ignoreSelection: true })))
        }
      },
      view (view) {
        let frame = 0
        const measure = () => {
          frame = 0
          if (view.isDestroyed) return
          const geo = pageGeometry(ext.options.getSetup())
          const zoom = ext.options.getZoom() || 1

          // Measure the natural layout: hide every spacer for the duration.
          const spacers = [...view.dom.querySelectorAll('.cp-pagebreak')]
          for (const s of spacers) s.style.display = 'none'
          const base = view.dom.getBoundingClientRect().top / zoom + geo.margins.top
          const toLocal = (y) => y / zoom - base
          const units = []
          view.state.doc.forEach((node, offset) => {
            const dom = view.nodeDOM(offset)
            if (!(dom instanceof HTMLElement)) return
            // Lists move item by item, so long lists can span pages.
            if ((node.type.name === 'bulletList' || node.type.name === 'orderedList') && node.childCount > 1) {
              node.forEach((child, childOffset, index) => {
                const pos = offset + 1 + childOffset
                const li = view.nodeDOM(pos)
                if (!(li instanceof HTMLElement)) return
                const r = li.getBoundingClientRect()
                // A break before the first item goes before the whole list.
                const top = index === 0 ? toLocal(dom.getBoundingClientRect().top) : toLocal(r.top)
                units.push({ pos: index === 0 ? offset : pos, top, bottom: toLocal(r.bottom) })
              })
              return
            }
            const r = dom.getBoundingClientRect()
            const unit = { pos: offset, node, top: toLocal(r.top), bottom: toLocal(r.bottom), forced: node.type.name === 'pageBreak' }
            if (SPLITTABLE.has(node.type.name) && node.textContent.length) {
              const lines = lineBoxes(dom, toLocal)
              if (lines.length > 1) unit.lines = lines
            }
            units.push(unit)
          })

          const { breaks, pages } = computeBreaks(units, geo)
          // Turn line breaks into document positions while still measuring
          // the natural layout.
          const resolved = breaks.map((b) => {
            const u = units[b.unit]
            if (b.line == null) return { pos: u.pos, height: b.height, inline: false }
            return { pos: lineStartPos(view, u.pos, u.node, u.lines[b.line].top, toLocal), height: b.height, inline: true }
          })
          for (const s of spacers) s.style.display = ''

          const current = paginationKey.getState(view.state).breaks
          if (!sameBreaks(current, resolved)) {
            view.dispatch(view.state.tr.setMeta(paginationKey, { breaks: resolved }).setMeta('addToHistory', false))
          }
          ext.storage.pages = pages
          ext.options.onLayout({ pages, geometry: geo })
        }
        const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
        ext.storage.refresh = schedule
        const resize = new ResizeObserver(schedule)
        resize.observe(view.dom)
        // Images change height when they finish loading; fonts too.
        const onLoad = (e) => { if (e.target instanceof HTMLImageElement) schedule() }
        view.dom.addEventListener('load', onLoad, true)
        document.fonts?.addEventListener?.('loadingdone', schedule)
        schedule()
        return {
          update (v, prev) { if (!v.state.doc.eq(prev.doc)) schedule() },
          destroy () {
            resize.disconnect()
            view.dom.removeEventListener('load', onLoad, true)
            document.fonts?.removeEventListener?.('loadingdone', schedule)
            if (frame) cancelAnimationFrame(frame)
          }
        }
      }
    })]
  }
})
