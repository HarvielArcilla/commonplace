// Sharing (who has access, with which role) and moving your Drive to
// another computer.

import { $, el, toast, dialog, confirmAction, cleanError, listNames } from './ui.js'
import { state, cp } from './state.js'

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }

function currentFile (docId) {
  return state.files.find((f) => f.docId === docId)
}

// ---- share dialog ---------------------------------------------------------

// The invite controls are built once; the lists below them re-render as
// people come and go (skipped while one of their menus is in use).
export function shareDialog (docId) {
  const f = currentFile(docId)
  if (!f) return
  const isOwner = f.role === 'owner'
  const live = el('div', { class: 'share-live' })
  const title = el('h2', {})
  const d = el('dialog', { class: 'dialog dialog-wide share' }, el('form', { method: 'dialog' },
    title,
    el('div', { class: 'share-body' },
      isOwner ? inviteControls(docId) : el('p', {}, `Only ${f.owner?.name || 'the owner'} can invite people or change access.`),
      live),
    el('div', { class: 'dialog-actions' }, el('button', { class: 'btn btn-primary', value: 'done' }, 'Done'))))
  const render = () => {
    const f = currentFile(docId)
    if (!f) { d.close(); return }
    title.textContent = `Share “${f.title || 'Untitled'}”`
    live.replaceChildren(...shareLists(docId, f))
  }
  render()
  document.body.append(d)
  const off = cp.onDriveChanged(() => setTimeout(() => { if (d.open && !live.querySelector('select:focus')) render() }, 0))
  d.addEventListener('close', () => { off(); d.remove() })
  d.showModal()
}

function shareLists (docId, f) {
  const isOwner = f.role === 'owner'
  const out = []
  if (isOwner && f.requests?.length) out.push(el('h3', {}, 'Asking to join'), requestList(docId, f.requests))
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
  out.push(el('h3', {}, 'People with access'), list)
  if (isOwner && f.access.managed) {
    out.push(el('div', { class: 'share-footer' },
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => resetLinks(docId) }, 'Stop all invite links…'),
      el('span', { class: 'fineprint-plain' }, 'Removing someone stops sending them changes. Anything they already have stays on their computer.')))
  }
  return out
}

// ---- invite links ------------------------------------------------------------

const INVITE_KEY = 'commonplace.invite.options'
const EXPIRY = [
  { value: '3600000', label: 'Works for 1 hour' },
  { value: '86400000', label: 'Works for 1 day' },
  { value: '604800000', label: 'Works for 7 days' },
  { value: '2592000000', label: 'Works for 30 days' },
  { value: '', label: 'Never expires' }
]
const loadInviteOptions = () => {
  try { return { role: 'editor', expiresIn: '604800000', once: false, ask: false, ...JSON.parse(localStorage.getItem(INVITE_KEY) || '{}') } } catch { return { role: 'editor', expiresIn: '604800000', once: false, ask: false } }
}
const saveInviteOptions = (o) => { try { localStorage.setItem(INVITE_KEY, JSON.stringify(o)) } catch {} }

function inviteControls (docId) {
  const o = loadInviteOptions()
  const role = el('select', { class: 'tool-select', 'aria-label': 'Role for people who use this link' },
    el('option', { value: 'editor', selected: o.role === 'editor' || null }, 'Can edit'),
    el('option', { value: 'viewer', selected: o.role === 'viewer' || null }, 'Can view'))
  const expiry = el('select', { class: 'tool-select', 'aria-label': 'How long the link works' },
    ...EXPIRY.map((e) => el('option', { value: e.value, selected: e.value === String(o.expiresIn || '') || null }, e.label)))
  const once = el('input', { type: 'checkbox', checked: o.once || null })
  const ask = el('input', { type: 'checkbox', checked: o.ask || null })
  const note = el('p', { class: 'fineprint-plain' })
  const options = () => ({ role: role.value, expiresIn: expiry.value, once: once.checked, ask: ask.checked })
  const explain = () => {
    const v = options()
    note.textContent = v.ask
      ? 'Each person who opens the link shows up here, and gets nothing until you approve them. You need to be online to approve.'
      : v.once
        ? 'The first person you let in uses up the link. They get the file once you\u2019re online.'
        : 'People who open the link join right away, from you or anyone else who has the file.'
  }
  for (const c of [role, expiry, once, ask]) c.addEventListener('change', () => { saveInviteOptions(options()); explain() })
  explain()
  return el('div', { class: 'invite-box' },
    el('div', { class: 'invite-row' }, el('span', { class: 'invite-label' }, 'Invite link'), role, expiry,
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => copyLink(docId, options()) }, 'Copy invite link')),
    el('div', { class: 'invite-options' },
      el('label', { class: 'check' }, once, 'One person only'),
      el('label', { class: 'check' }, ask, 'I approve each person')),
    note)
}

async function copyLink (docId, { role, expiresIn, once, ask }) {
  try {
    await cp.copyInvite(docId, role, { expiresIn: Number(expiresIn) || null, once, ask })
    const what = role === 'viewer' ? 'View-only invite link copied.' : 'Invite link copied.'
    toast(ask ? `${what} You\u2019ll approve each person.` : what)
  } catch (err) { toast(cleanError(err)) }
}

function requestList (docId, requests) {
  return el('ul', { class: 'people', 'aria-label': 'People asking to join' }, ...requests.map((r) => {
    const role = el('select', { class: 'tool-select', 'aria-label': `Role for ${r.name}` },
      el('option', { value: 'editor', selected: r.role === 'editor' || null }, 'Can edit'),
      el('option', { value: 'viewer', selected: r.role === 'viewer' || null }, 'Can view'))
    return el('li', { class: 'person' },
      el('span', { class: 'presence-dot on', 'aria-hidden': 'true' }),
      el('span', { class: 'person-name' }, r.name, el('span', { class: 'person-note' }, 'Asking to join')),
      el('div', { class: 'person-controls' }, role,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => act(async () => { await cp.approveRequest(docId, r.userId, role.value); toast(`${r.name} can now open the file`) }) }, 'Let in'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => act(() => cp.declineRequest(docId, r.userId)) }, 'Decline')))
  }))
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
