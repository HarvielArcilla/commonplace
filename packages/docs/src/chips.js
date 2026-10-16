// Smart chips: a person, a file or a date placed in a document by typing @.
// A chip is a small inline node that keeps what it points at (a user id, a
// file's id, a day) and the words it showed when it was placed, so it reads
// the same for someone who doesn't have that file.
//
// Lines with chips are also action items: "Order compost @Sam @Tue, Oct 20"
// becomes a card for Sam due on the 20th when sent to a task board.

import { Node, mergeAttributes } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'

export const CHIP_KINDS = ['person', 'file', 'date']
const DAY = /^\d{4}-\d{2}-\d{2}$/

export const Chip = Node.create({
  name: 'chip',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions () { return { onOpen: null } },
  addAttributes () {
    const data = (name) => ({ default: '', parseHTML: (el) => el.getAttribute(`data-${name}`) || '', renderHTML: (a) => ({ [`data-${name}`]: a[name] }) })
    return { kind: data('kind'), ref: data('ref'), label: data('label') }
  },
  parseHTML () { return [{ tag: 'span[data-type="chip"]' }] },
  renderHTML ({ node, HTMLAttributes }) {
    const kind = CHIP_KINDS.includes(node.attrs.kind) ? node.attrs.kind : 'file'
    return ['span', mergeAttributes(HTMLAttributes, { 'data-type': 'chip', class: `cp-chip cp-chip-${kind}`, contenteditable: 'false' }), node.attrs.label || '…']
  },
  renderText ({ node }) { return node.attrs.label || '' },
  renderMarkdown (node) { return node.attrs?.label || '' },
  addCommands () {
    return {
      insertChip: (attrs) => ({ chain }) => chain().insertContent([{ type: this.name, attrs }, { type: 'text', text: ' ' }]).run()
    }
  },
  addProseMirrorPlugins () {
    const onOpen = () => this.options.onOpen
    const name = this.name
    return [new Plugin({
      props: {
        handleClickOn (view, pos, node, _nodePos, event) {
          if (node.type.name !== name) return false
          onOpen()?.(node.attrs, event.target)
          return true
        }
      }
    })]
  }
})

// The action items in a range of the document: one per line (paragraph or
// list item) that has words in it. Person chips assign, date chips set the
// due date, and the rest of the line is the title.
export function actionItems (doc, from, to) {
  const out = []
  doc.nodesBetween(from, to, (node) => {
    if (!node.isTextblock) return true
    let title = ''
    let due = null
    let assignee = null
    node.forEach((child) => {
      if (child.type.name === 'chip') {
        const { kind, ref, label } = child.attrs
        if (kind === 'date' && DAY.test(ref) && !due) { due = ref; return }
        if (kind === 'person' && ref && !assignee) { assignee = ref; return }
        title += label || ''
      } else if (child.isText) {
        title += child.text
      }
    })
    title = title.replace(/\s+/g, ' ').replace(/^[-*•\s]+/, '').trim()
    if (title) out.push({ title, due, assignee })
    return false
  })
  return out
}

// A day ('YYYY-MM-DD') as words for a chip, in the reader's language.
export function dayLabel (day, now = new Date()) {
  const [y, m, d] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: y === now.getFullYear() ? undefined : 'numeric' })
}
