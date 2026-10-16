// Activity: mentions, replies, comments on my files and files shared folders
// brought me, newest first. It lives on this computer only.

import { $, el, ago } from './ui.js'
import { cp } from './state.js'

const WHAT = {
  mention: (i) => [el('strong', {}, i.byName), ' mentioned you in ', el('em', {}, i.title)],
  reply: (i) => [el('strong', {}, i.byName), ' replied in ', el('em', {}, i.title)],
  comment: (i) => [el('strong', {}, i.byName), ' commented on ', el('em', {}, i.title)],
  shared: (i) => [el('strong', {}, i.byName || 'Someone'), ' shared ', el('em', {}, i.title), i.folderName ? ` in “${i.folderName}”` : '']
}

export function showActivityCount (n) {
  const badge = $('#activity-count')
  if (!badge) return
  badge.hidden = !n
  badge.textContent = n > 99 ? '99+' : String(n)
}

// openThread(docId, threadId | null) opens the file (and the thread).
export async function openActivity ({ openThread }) {
  const items = await cp.listActivity()
  const list = el('ul', { class: 'activity-list', 'aria-label': 'Activity' })
  const d = el('dialog', { class: 'dialog dialog-wide activity' },
    el('form', { method: 'dialog' },
      el('h2', {}, 'Activity'),
      items.length ? list : el('p', { class: 'panel-note' }, 'Nothing yet. When someone mentions you, replies to you, comments on a file of yours or shares one through a folder, it shows here.'),
      el('div', { class: 'dialog-actions' },
        items.some((i) => !i.read) ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => { await cp.markActivityRead(); d.close() } }, 'Mark all as read') : null,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn-primary', value: 'done' }, 'Done'))))
  for (const i of items) {
    list.append(el('li', {},
      el('button', {
        type: 'button',
        class: `activity-item${i.read ? '' : ' unread'}`,
        onclick: async () => { d.close(); await cp.markActivityRead([i.id]); openThread(i.docId, i.threadId || null) }
      },
      el('span', { class: 'activity-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'activity-main' },
        el('span', { class: 'activity-what' }, ...WHAT[i.kind](i)),
        i.text ? el('span', { class: 'activity-text' }, i.text) : null),
      el('span', { class: 'activity-time' }, ago(i.at)))))
  }
  document.body.append(d)
  d.addEventListener('close', () => d.remove())
  d.showModal()
}
