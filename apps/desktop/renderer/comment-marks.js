// Small badges showing how many open comment threads something has, for
// the apps whose threads are about a card, a slide, a question...

import { el } from './ui.js'

// Open threads per anchor id, for one kind of anchor.
export function countBy (threads, kind, key = 'id') {
  const out = new Map()
  for (const t of threads) if (t.anchor?.kind === kind) out.set(t.anchor[key], (out.get(t.anchor[key]) || 0) + 1)
  return out
}

// Puts (or updates, or removes) a badge on each node matching `selector`,
// keyed by its `attr` attribute.
export function badges (root, selector, attr, counts = new Map()) {
  if (!root) return
  for (const node of root.querySelectorAll(selector)) {
    const n = counts.get(node.getAttribute(attr)) || 0
    let b = node.querySelector(':scope > .comment-badge')
    if (!n) { b?.remove(); continue }
    if (!b) { b = el('span', { class: 'comment-badge' }); node.append(b) }
    b.textContent = String(n)
    b.setAttribute('aria-label', n === 1 ? '1 comment' : `${n} comments`)
    b.title = b.getAttribute('aria-label')
  }
}
