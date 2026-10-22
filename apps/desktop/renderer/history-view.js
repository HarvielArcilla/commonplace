// Version history: checkpoints this computer saved as people edited, a
// read-only look at any of them, and restoring one for everyone.

import { el, toast, promptText, confirmAction, cleanError } from './ui.js'
import { state, cp, can } from './state.js'
import { openPanel, closePanel, openPanelName } from './panel.js'
import { showPreview } from './doc-view.js'

export { closePanel }

let view = null // { docId, body, selected, closePreview, off }

export function toggleHistory () {
  if (openPanelName() === 'history') { closePanel(); return }
  const o = state.open
  if (!o) return
  const body = openPanel('history', { title: 'Version history', onClose: () => { view?.closePreview?.(); view?.off(); view = null } })
  view = { docId: o.docId, body, selected: null, closePreview: null, off: () => {} }
  const mine = view
  // New checkpoints arrive as people keep editing.
  view.off = cp.onDriveChanged(() => { if (view === mine && !mine.busy) render() })
  render()
}

const dayLabel = (ts) => {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(Date.now() - 864e5)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}
const timeLabel = (ts) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
const whenLabel = (ts) => `${dayLabel(ts)}, ${timeLabel(ts)}`

async function render () {
  const v = view
  if (!v) return
  const versions = await cp.listVersions(v.docId)
  if (view !== v) return
  const file = state.files.find((f) => f.docId === v.docId)
  const writable = can(file, 'edit')
  const items = []
  if (v.selected && !versions.some((x) => x.id === v.selected)) select(null)
  const selected = versions.find((x) => x.id === v.selected)
  if (selected) {
    items.push(el('div', { class: 'version-actions' },
      el('p', {}, `Showing ${whenLabel(selected.at)}`),
      writable ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => restore(selected) }, 'Restore this version') : null,
      el('button', { type: 'button', class: 'btn', onclick: () => rename(selected) }, selected.label ? 'Rename…' : 'Name this version…'),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { select(null); render() } }, 'Back to current')))
  }
  items.push(el('p', { class: 'panel-note' }, versions.length
    ? 'Saved on this computer as you and others edit. Restoring keeps the current version here too.'
    : 'Versions are saved on this computer a minute after edits pause, and every ten minutes while people keep typing.'))
  items.push(el('button', { type: 'button', class: 'version-item', 'aria-current': String(!v.selected), onclick: () => { select(null); render() } },
    el('span', { class: 'version-time' }, 'Current version')))
  let day = null
  for (const x of versions) {
    const d = dayLabel(x.at)
    if (d !== day) { items.push(el('h3', { class: 'panel-day' }, d)); day = d }
    items.push(el('button', { type: 'button', class: 'version-item', 'aria-current': String(x.id === v.selected), onclick: () => preview(x) },
      el('span', { class: 'version-time' }, timeLabel(x.at)),
      x.label ? el('span', { class: 'version-name' }, x.label) : null,
      x.kind === 'restore' && x.restoredFrom ? el('span', { class: 'version-by' }, `Restored the version from ${whenLabel(x.restoredFrom)}`) : null,
      x.names.length ? el('span', { class: 'version-by' }, x.names.join(', ')) : null))
  }
  v.body.replaceChildren(...items)
}

function select (id) {
  const v = view
  if (!v) return
  v.selected = id
  if (!id) { v.closePreview?.(); v.closePreview = null }
}

async function preview (version) {
  const v = view
  try {
    const update = await cp.getVersion(v.docId, version.id)
    if (view !== v || !update) return
    v.selected = version.id
    v.closePreview = showPreview(update)
    render()
  } catch (err) { toast(cleanError(err)) }
}

async function restore (version) {
  const v = view
  const ok = await confirmAction({
    title: `Restore the version from ${whenLabel(version.at)}?`,
    body: 'Everyone working on this file will see it. The current version stays in the history, so you can go back to it.',
    confirm: 'Restore',
    danger: false
  })
  if (!ok || view !== v) return
  try {
    select(null)
    await cp.restoreVersion(v.docId, version.id)
    toast('Restored')
    render()
  } catch (err) { toast(cleanError(err)) }
}

async function rename (version) {
  const v = view
  v.busy = true
  try {
    const label = await promptText({ title: 'Name this version', label: 'Name', value: version.label || '', confirm: 'Save', body: 'Named versions are always kept.' })
    if (label != null) await cp.nameVersion(v.docId, version.id, label)
  } finally { v.busy = false }
  render()
}
