// Indentation, Word-style. Tab is reserved for indenting and never moves
// focus out of the document:
//
//   Tab at the start of a paragraph   first-line indent (or, if it already
//                                     has one, indent the whole paragraph)
//   Tab anywhere else                 indent the whole paragraph(s)
//   Shift+Tab                         undo one step of indent
//   Backspace at the start            removes the first-line indent, then
//                                     the paragraph indent, before joining
//
// In lists Tab nests the item and in tables it moves to the next cell (those
// extensions handle it first). Pressing Enter keeps the indent: a new
// paragraph starts the way the one before it did.

import { Extension } from '@tiptap/core'

export const INDENT_STEP_IN = 0.5
const MAX_LEVEL = 8
const TYPES = ['paragraph', 'heading']

const inches = (v) => {
  const m = /^(-?[\d.]+)(in|px|pt|cm|mm)?$/.exec(String(v || '').trim())
  if (!m) return 0
  const n = parseFloat(m[1])
  return { in: n, px: n / 96, pt: n / 72, cm: n / 2.54, mm: n / 25.4 }[m[2] || 'px']
}
const toLevel = (v) => Math.max(0, Math.min(MAX_LEVEL, Math.round(inches(v) / INDENT_STEP_IN)))

export const Indent = Extension.create({
  name: 'indent',
  priority: 50, // after lists and tables, so their Tab handling wins

  addGlobalAttributes () {
    return [{
      types: TYPES,
      attributes: {
        indent: {
          default: 0,
          keepOnSplit: true,
          parseHTML: (el) => toLevel(el.style.marginLeft),
          renderHTML: (a) => (a.indent ? { style: `margin-left: ${a.indent * INDENT_STEP_IN}in` } : {})
        },
        firstLine: {
          default: 0,
          keepOnSplit: true,
          parseHTML: (el) => (inches(el.style.textIndent) > 0.05 ? 1 : 0),
          renderHTML: (a) => (a.firstLine ? { style: `text-indent: ${INDENT_STEP_IN}in` } : {})
        }
      }
    }]
  },

  addCommands () {
    // Applies fn(attrs) to every paragraph/heading touched by the selection.
    const update = (fn) => ({ tr, state, dispatch }) => {
      const { from, to } = state.selection
      let changed = false
      state.doc.nodesBetween(from, to, (node, pos) => {
        if (!TYPES.includes(node.type.name)) return
        const next = fn(node.attrs)
        if (next && (next.indent !== node.attrs.indent || next.firstLine !== node.attrs.firstLine)) {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next })
          changed = true
        }
        return false
      })
      if (changed && dispatch) dispatch(tr)
      return changed
    }
    return {
      indent: () => update((a) => ({ indent: Math.min(MAX_LEVEL, a.indent + 1), firstLine: a.firstLine })),
      outdent: () => update((a) => (a.indent > 0 ? { indent: a.indent - 1, firstLine: a.firstLine } : { indent: 0, firstLine: 0 })),
      firstLineIndent: () => update((a) => ({ indent: a.indent, firstLine: 1 }))
    }
  },

  addKeyboardShortcuts () {
    const inList = () => this.editor.isActive('listItem')
    return {
      Tab: () => {
        const e = this.editor
        if (e.isActive('codeBlock')) return e.commands.insertContent('  ')
        if (inList() || e.isActive('table')) return true // they had their turn; don't leave the editor
        const { selection } = e.state
        const { $from } = selection
        if (!TYPES.includes($from.parent.type.name)) return true
        if (selection.empty && $from.parentOffset === 0 && !$from.parent.attrs.firstLine) return e.commands.firstLineIndent()
        e.commands.indent()
        return true
      },
      'Shift-Tab': () => {
        const e = this.editor
        if (inList() || e.isActive('table') || e.isActive('codeBlock')) return true
        e.commands.outdent()
        return true
      },
      Backspace: () => {
        const e = this.editor
        const { selection } = e.state
        const { $from } = selection
        if (!selection.empty || $from.parentOffset !== 0 || !TYPES.includes($from.parent.type.name) || inList()) return false
        const { indent, firstLine } = $from.parent.attrs
        if (firstLine) return e.commands.command(({ tr }) => { tr.setNodeMarkup($from.before(), undefined, { ...$from.parent.attrs, firstLine: 0 }); return true })
        if (indent) return e.commands.outdent()
        return false
      }
    }
  }
})
