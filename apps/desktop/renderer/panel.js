// The side panel beside a document (version history, comments). One panel
// shows at a time; opening another replaces it.

import { $, el, svg } from './ui.js'

let current = null // { name, onClose }

export function openPanel (name, { title, onClose = () => {} }) {
  closePanel()
  const body = el('div', { class: 'panel-body' })
  const panel = $('#side-panel')
  panel.replaceChildren(
    el('div', { class: 'panel-head' },
      el('h2', {}, title),
      el('button', { type: 'button', class: 'btn btn-quiet btn-icon', 'aria-label': `Close ${title.toLowerCase()}`, onclick: () => closePanel() },
        svg('<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="m4 4 8 8M12 4l-8 8"/></svg>'))),
    body)
  panel.setAttribute('aria-label', title)
  panel.hidden = false
  current = { name, onClose }
  for (const b of document.querySelectorAll('[data-panel]')) b.setAttribute('aria-pressed', String(b.dataset.panel === name))
  return body
}

export function closePanel () {
  if (!current) return
  const { onClose } = current
  current = null
  $('#side-panel').hidden = true
  $('#side-panel').replaceChildren()
  for (const b of document.querySelectorAll('[data-panel]')) b.setAttribute('aria-pressed', 'false')
  onClose()
}

export const openPanelName = () => current?.name || null
