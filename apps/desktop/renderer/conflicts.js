// Reviewing conflicts: the same paragraph (or the title) changed by two
// people while they were apart. The owner picks what stays; everyone else
// can see both versions.

import { el, toast, cleanError } from './ui.js'
import { state, cp } from './state.js'

// Word-level diff of `text` against `base`: marks what's new in this version.
function diffWords (base, text) {
  const a = base.split(/(\s+)/)
  const b = text.split(/(\s+)/)
  const n = a.length
  const m = b.length
  if (n * m > 400000) return [el('span', {}, text)] // very long paragraph: just show it
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const out = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push(el('span', {}, b[j])); i++; j++ } else if (j < m && (i === n || dp[i][j + 1] >= dp[i + 1][j])) { out.push(el('ins', {}, b[j])); j++ } else { out.push(el('del', {}, a[i])); i++ }
  }
  return out
}

function versionCard (label, v, base) {
  return el('div', { class: 'version' },
    el('p', { class: 'version-label' }, label),
    v.exists
      ? el('p', { class: 'version-text' }, ...diffWords(base, v.text))
      : el('p', { class: 'version-text version-deleted' }, 'Deleted this paragraph'))
}

export async function conflictsDialog (docId) {
  const d = el('dialog', { class: 'dialog dialog-wide conflicts' })
  document.body.append(d)
  const render = async () => {
    const file = state.files.find((f) => f.docId === docId)
    const isOwner = file?.role === 'owner'
    let list = []
    try { list = await cp.listConflicts(docId) } catch (err) { toast(cleanError(err)) }
    if (!list.length) { d.close(); toast('No conflicts left'); return }
    const items = list.map((c) => {
      const what = c.kind === 'title' ? 'The title' : 'A paragraph'
      const names = c.versions.map((v) => (v.userId === state.me.userId ? 'you' : v.name))
      const choices = isOwner
        ? el('div', { class: 'conflict-actions' },
          ...c.versions.map((v, i) => el('button', {
            type: 'button',
            class: 'btn',
            onclick: () => decide(c.id, `v${i}`, v.exists ? `Kept ${names[i] === 'you' ? 'your' : `${names[i]}’s`} version` : 'Removed it')
          }, v.exists ? `Keep ${names[i] === 'you' ? 'yours' : `${names[i]}’s`}` : 'Delete it')),
          c.versions.every((v) => v.exists) ? el('button', { type: 'button', class: 'btn', onclick: () => decide(c.id, 'both', 'Kept both') }, c.kind === 'title' ? 'Combine both' : 'Keep both') : null,
          el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => decide(c.id, 'current', 'Kept the merged text') }, 'Keep merged text'))
        : null
      return el('section', { class: 'conflict' },
        el('h3', {}, `${what} was changed by ${names[0]} and ${names[1]}`),
        el('p', { class: 'version-base' }, el('span', { class: 'version-label' }, 'Before: '), c.base.text || '(empty)'),
        el('div', { class: 'versions' }, ...c.versions.map((v, i) => versionCard(names[i] === 'you' ? 'Your version' : `${names[i]}’s version`, v, c.base.text))),
        el('p', { class: 'version-base' }, el('span', { class: 'version-label' }, 'In the document now: '), c.current.exists ? (c.current.text || '(empty)') : '(deleted)'),
        choices)
    })
    d.replaceChildren(el('form', { method: 'dialog' },
      el('h2', {}, list.length === 1 ? '1 conflict' : `${list.length} conflicts`),
      el('p', {}, isOwner
        ? 'These were edited by two people while their computers weren’t connected. Everything else merged on its own. Choose what to keep; your choice reaches everyone.'
        : `These were edited by two people while their computers weren’t connected. ${file?.owner?.name || 'The owner'} decides what stays. You can keep working in the meantime.`),
      el('div', { class: 'conflict-list' }, ...items),
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn btn-primary', value: 'done' }, 'Done'))))
  }
  const decide = async (id, choice, done) => {
    try {
      await cp.resolveConflict(docId, id, choice)
      toast(done)
      await render()
    } catch (err) { toast(cleanError(err)) }
  }
  await render()
  if (d.isConnected && !d.open) d.showModal()
  d.addEventListener('close', () => d.remove())
}
