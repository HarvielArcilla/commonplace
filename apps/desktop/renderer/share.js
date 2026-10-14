// Sharing (who has access, with which role) and moving your Drive to
// another computer.

import { $, el, toast, dialog, confirmAction, cleanError, listNames } from './ui.js'
import { state, cp } from './state.js'

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }

function currentFile (docId) {
  return state.files.find((f) => f.docId === docId)
}

// ---- share dialog ---------------------------------------------------------

export function shareDialog (docId) {
  const d = el('dialog', { class: 'dialog dialog-wide share' })
  document.body.append(d)
  const render = () => {
    const f = currentFile(docId)
    if (!f) { d.close(); return }
    const isOwner = f.role === 'owner'
    const body = el('div', { class: 'share-body' })

    if (!f.access.managed && !isOwner) {
      // A file made before membership whose owner hasn't been online since.
      body.append(
        el('p', {}, 'This file was shared before Commonplace had roles. Anyone with its link can edit it until the owner next opens Commonplace.'),
        el('div', { class: 'invite-row' }, el('button', { type: 'button', class: 'btn btn-primary', onclick: () => copyLink(docId, 'editor') }, 'Copy invite link')))
    } else if (isOwner) {
      const role = el('select', { class: 'tool-select', 'aria-label': 'Role for people who use this link' },
        el('option', { value: 'editor' }, 'Can edit'), el('option', { value: 'viewer' }, 'Can view'))
      body.append(el('div', { class: 'invite-row' },
        el('span', { class: 'invite-label' }, 'Anyone with the link'), role,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => copyLink(docId, role.value) }, 'Copy invite link')),
      el('p', { class: 'fineprint-plain' }, 'People who open the link join right away. After you\u2019ve removed someone from this file, new people can join only while you\u2019re online.'))
    } else {
      body.append(el('p', {}, `Only ${f.owner?.name || 'the owner'} can invite people or change access.`))
    }

    const list = el('ul', { class: 'people', 'aria-label': 'People with access' })
    const members = f.members.length ? f.members : (f.owner ? [{ userId: f.owner.userId, name: f.owner.name, role: 'owner' }] : [])
    for (const m of members) {
      const isMe = m.userId === state.me.userId
      const controls = el('div', { class: 'person-controls' })
      if (isOwner && m.role !== 'owner') {
        const select = el('select', { class: 'tool-select', 'aria-label': `Role for ${m.name}`, onchange: (e) => act(() => cp.setMemberRole(docId, m.userId, e.target.value)) },
          el('option', { value: 'editor', selected: m.role === 'editor' || null }, 'Can edit'),
          el('option', { value: 'viewer', selected: m.role === 'viewer' || null }, 'Can view'))
        controls.append(select,
          el('button', { type: 'button', class: 'btn btn-quiet', title: 'Make this person the owner', onclick: () => transfer(docId, m) }, 'Make owner'),
          el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => removePerson(docId, m) }, 'Remove'))
      } else {
        controls.append(el('span', { class: 'person-role' }, ROLE_LABEL[m.role] || m.role))
      }
      list.append(el('li', { class: 'person' },
        el('span', { class: `presence-dot${m.online ? ' on' : ''}`, title: m.online ? 'Online' : 'Offline', 'aria-hidden': 'true' }),
        el('span', { class: 'person-name' }, isMe ? `${m.name} (you)` : m.name, m.pending ? el('span', { class: 'person-note' }, 'Joining with a link') : null),
        controls))
    }
    body.append(el('h3', {}, 'People with access'), list)

    if (isOwner && f.access.managed) {
      body.append(el('div', { class: 'share-footer' },
        el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => resetLinks(docId) }, 'Stop all invite links…'),
        el('span', { class: 'fineprint-plain' }, 'Removing someone stops sending them changes. Anything they already have stays on their computer.')))
    }

    d.replaceChildren(el('form', { method: 'dialog' },
      el('h2', {}, `Share “${f.title || 'Untitled'}”`),
      body,
      el('div', { class: 'dialog-actions' }, el('button', { class: 'btn btn-primary', value: 'done' }, 'Done'))))
  }
  render()
  const off = cp.onDriveChanged(() => setTimeout(() => { if (d.open && !d.querySelector('select:focus')) render() }, 0))
  d.addEventListener('close', () => { off(); d.remove() })
  d.showModal()
}

async function copyLink (docId, role) {
  try {
    await cp.copyInvite(docId, role)
    toast(role === 'viewer' ? 'View-only invite link copied.' : 'Invite link copied. Anyone with it can edit.')
  } catch (err) { toast(cleanError(err)) }
}

async function act (fn) {
  try { await fn() } catch (err) { toast(cleanError(err)) }
}

async function removePerson (docId, m) {
  const ok = await confirmAction({
    title: `Remove ${m.name}?`,
    body: `${m.name} stops receiving changes and can no longer edit. What they already have stays on their computer. Everyone else moves to a new key automatically, and existing invite links stop working.`,
    confirm: 'Remove'
  })
  if (ok) { await act(() => cp.removeMember(docId, m.userId)); toast(`${m.name} was removed`) }
}

async function transfer (docId, m) {
  const ok = await confirmAction({
    title: `Make ${m.name} the owner?`,
    body: `${m.name} will be able to invite people, change roles and remove people, including you. You’ll stay on as an editor. This can only be undone by ${m.name}.`,
    confirm: 'Make owner'
  })
  if (ok) { await act(() => cp.transferOwnership(docId, m.userId)); toast(`${m.name} now owns this file`) }
}

async function resetLinks (docId) {
  const ok = await confirmAction({
    title: 'Stop all invite links?',
    body: 'Every invite link you’ve shared stops working. People already in the list keep their access. You can copy a new link afterwards.',
    confirm: 'Stop links'
  })
  if (ok) { await act(() => cp.resetInvites(docId)); toast('Old invite links no longer work') }
}

export async function setSyncMode (docId, mode) {
  await cp.setSyncMode(docId, mode)
  toast(mode === 'open' ? 'This file now syncs only while it’s open' : 'This file now syncs whenever Commonplace is running')
}

// ---- moving the Drive -----------------------------------------------------

export async function moveOutDialog () {
  const status = el('p', { class: 'move-status', role: 'status' }, 'Getting a code…')
  const codeBox = el('code', { class: 'move-code' }, '…')
  const copy = el('button', { type: 'button', class: 'btn', disabled: true }, 'Copy code')
  const d = el('dialog', { class: 'dialog dialog-wide' }, el('form', { method: 'dialog' },
    el('h2', {}, 'Move your Drive to another computer'),
    el('p', {}, 'Your identity, folders and every file move to the other computer. When it confirms it has everything, this computer signs out and deletes its copies. Both computers need to be online.'),
    el('ol', { class: 'move-steps' },
      el('li', {}, 'On the other computer, install Commonplace and open it.'),
      el('li', {}, 'Choose “Bring my Drive here” and paste this code.')),
    el('div', { class: 'move-code-row' }, codeBox, copy),
    el('p', { class: 'fineprint-plain' }, 'Anyone with this code can take your Drive while this window is open. Only paste it on your own computer. It expires in 15 minutes.'),
    status,
    el('div', { class: 'dialog-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => d.close() }, 'Cancel'))))
  document.body.append(d)
  let finished = false
  const off = cp.onMoveStatus((s) => {
    if (s.phase === 'connected') status.textContent = 'Connected to the other computer.'
    else if (s.phase === 'sending') status.textContent = 'Sending your Drive…'
    else if (s.phase === 'confirmed') status.textContent = 'The other computer has everything. Signing out here…'
    else if (s.phase === 'signed-out') { finished = true; status.textContent = 'Done. This computer is signed out.' }
    else if (s.phase === 'error') status.textContent = s.message
  })
  d.addEventListener('close', () => { off(); if (!finished) cp.cancelMove(); d.remove() })
  d.showModal()
  const code = await cp.startMove()
  codeBox.textContent = code
  copy.disabled = false
  copy.onclick = async () => { await cp.copyText(code); toast('Code copied') }
  status.textContent = 'Waiting for the other computer…'
}

export async function moveInDialog () {
  const input = el('textarea', { name: 'code', rows: '2', placeholder: 'cpmove1.…', spellcheck: 'false' })
  const status = el('p', { class: 'move-status', role: 'status' })
  const off = cp.onMoveStatus((s) => {
    if (s.phase === 'connected') status.textContent = 'Connected. Receiving your Drive…'
    else if (s.phase === 'receiving') status.textContent = `Received ${s.count} file${s.count === 1 ? '' : 's'}…`
    else if (s.phase === 'done') status.textContent = 'All here. Opening your Drive…'
  })
  const res = await dialog({
    title: 'Bring my Drive here',
    body: 'On your other computer, choose “Move to another computer” and paste the code it shows. This computer must not have any files of its own yet.',
    fields: [el('label', { class: 'field' }, 'Code', input), status],
    confirm: 'Bring it here',
    validate: (data) => (/cpmove1\.[A-Za-z0-9_-]{32}/.test(data.code) ? null : 'Paste the code from your other computer.')
  })
  if (res?.action !== 'confirm') { off(); return }
  toast('Connecting to your other computer…')
  try {
    const result = await cp.receiveMove(res.data.code)
    toast(`Moved ${result.count} file${result.count === 1 ? '' : 's'} here`)
  } catch (err) {
    toast(cleanError(err))
  } finally { off() }
}

export function accessSummary (f) {
  if (!f.members.length) return ''
  const others = f.members.filter((m) => m.userId !== state.me.userId && !m.pending)
  return others.length ? `Shared with ${listNames(others)}` : 'Only you'
}

export { $ }
