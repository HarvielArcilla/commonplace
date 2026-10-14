// Block-level pagination for paged documents.
//
// The document stays one continuous ProseMirror editor. After each change we
// measure every top-level block and decide which page it lands on. When a
// block would cross the bottom margin, an invisible spacer is inserted before
// it (a widget decoration, never part of the document or the CRDT) that is
// exactly tall enough to push it to the top of the next page. Page sheets are
// drawn behind the text by the host, from the page count we report.
//
// Limit: a single block taller than a page is not split; it runs over.

import { Extension, Node, mergeAttributes } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { pageGeometry } from './page.js'

export const paginationKey = new PluginKey('cp-pagination')

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

function sameBreaks (a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i].pos !== b[i].pos || a[i].height !== b[i].height) return false
  return true
}

// Decide where pages break, given each top-level block's measured box.
// blocks: [{ pos, height, marginTop, forced }] where `forced` means
// "a manual page break node": the next block must start a new page.
export function computeBreaks (blocks, geo) {
  const usable = geo.contentHeight
  const spacer = (used) => Math.max(0, usable - used) + geo.margins.bottom + geo.gap + geo.margins.top
  const breaks = []
  let used = 0
  let pages = 1
  let forceNext = false
  for (const b of blocks) {
    if (forceNext) {
      breaks.push({ pos: b.pos, height: spacer(used) })
      pages++
      used = 0
      forceNext = false
    }
    const top = used === 0 ? 0 : b.marginTop
    if (used > 0 && used + top + b.height > usable) {
      breaks.push({ pos: b.pos, height: spacer(used) })
      pages++
      used = 0
    }
    if (b.forced) {
      used += (used === 0 ? 0 : b.marginTop) + b.height
      forceNext = true
      continue
    }
    const h = (used === 0 ? 0 : b.marginTop) + b.height
    if (used === 0 && h > usable) {
      // Taller than a page: it overflows; count the extra sheets it covers.
      const stride = usable + geo.margins.bottom + geo.gap + geo.margins.top
      const extra = Math.ceil((h - usable) / stride)
      pages += extra
      used = Math.min(usable, h - extra * stride)
    } else {
      used += h
    }
  }
  return { breaks, pages }
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
          return { breaks: prev.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos) })) }
        }
      },
      props: {
        decorations (state) {
          const { breaks } = paginationKey.getState(state)
          if (!breaks.length) return DecorationSet.empty
          return DecorationSet.create(state.doc, breaks.map((b) => Decoration.widget(b.pos, () => {
            const el = document.createElement('div')
            el.className = 'cp-pagebreak'
            el.style.height = `${b.height}px`
            el.setAttribute('contenteditable', 'false')
            el.setAttribute('aria-hidden', 'true')
            return el
          }, { side: -1, key: `pb:${b.pos}:${b.height}`, ignoreSelection: true })))
        }
      },
      view (view) {
        let frame = 0
        const measure = () => {
          frame = 0
          if (view.isDestroyed) return
          const geo = pageGeometry(ext.options.getSetup())
          const zoom = ext.options.getZoom() || 1
          const blocks = []
          const marginOf = (dom) => parseFloat(getComputedStyle(dom).marginTop) || 0
          view.state.doc.forEach((node, offset) => {
            const dom = view.nodeDOM(offset)
            if (!(dom instanceof HTMLElement)) return
            // Lists paginate item by item, so a long list can span pages.
            if ((node.type.name === 'bulletList' || node.type.name === 'orderedList') && node.childCount > 1) {
              node.forEach((child, childOffset, index) => {
                const pos = offset + 1 + childOffset
                const li = view.nodeDOM(pos)
                if (!(li instanceof HTMLElement)) return
                blocks.push({
                  // A break before the first item goes before the whole list.
                  pos: index === 0 ? offset : pos,
                  height: li.getBoundingClientRect().height / zoom,
                  marginTop: index === 0 ? marginOf(dom) : marginOf(li)
                })
              })
              return
            }
            blocks.push({
              pos: offset,
              height: dom.getBoundingClientRect().height / zoom,
              marginTop: marginOf(dom),
              forced: node.type.name === 'pageBreak'
            })
          })
          const { breaks, pages } = computeBreaks(blocks, geo)
          const current = paginationKey.getState(view.state).breaks
          if (!sameBreaks(current, breaks)) {
            view.dispatch(view.state.tr.setMeta(paginationKey, { breaks }).setMeta('addToHistory', false))
          }
          ext.storage.pages = pages
          ext.options.onLayout({ pages, geometry: geo })
        }
        const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
        ext.storage.refresh = schedule
        const resize = new ResizeObserver(schedule)
        resize.observe(view.dom)
        // Images change height when they finish loading.
        const onLoad = (e) => { if (e.target instanceof HTMLImageElement) schedule() }
        view.dom.addEventListener('load', onLoad, true)
        schedule()
        return {
          update (v, prev) { if (!v.state.doc.eq(prev.doc)) schedule() },
          destroy () {
            resize.disconnect()
            view.dom.removeEventListener('load', onLoad, true)
            if (frame) cancelAnimationFrame(frame)
          }
        }
      }
    })]
  }
})
