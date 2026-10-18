// Sharing (who has access, with which role) and moving your Drive to
// another computer.

import { $, el, ago, toast, dialog, confirmAction, cleanError, listNames } from './ui.js'
import { state, cp, when } from './state.js'

const ROLE_LABEL = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view', respondent: 'Can answer' }

// The roles someone can be given in a file: forms are answered, not viewed.
const rolesFor = (kind) => (kind === 'form' ? ['respondent', 'editor'] : ['editor', 'viewer'])
const roleOptions = (kind, selected) => rolesFor(kind).map((r) => el('option', { value: r, selected: r === selected || null }, ROLE_LABEL[r]))

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
    f.kind === 'folder' ? el('p', { class: 'share-folder-note' }, 'Everyone in this folder gets every file in it: editors can edit them, viewers can view them (and answer forms). Leaving the folder takes away what they had only through it.') : null,
    el('div', { class: 'share-body' },
      isOwner ? inviteControls(docId, f.kind) : el('p', {}, `Only ${f.owner?.name || 'the owner'} can invite people or change access.`),
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
  const off = cp.onDriveChanged(() => setTimeout(() => { if (d.open && !live.querySelector('select:focus, input:focus')) render() }, 0))
  d.addEventListener('close', () => { off(); d.remove() })
  d.showModal()
}

function shareLists (docId, f) {
  const isOwner = f.role === 'owner'
  const out = []
  if (isOwner && f.requests?.length) out.push(el('h3', {}, 'Asking to join'), requestList(docId, f.requests, f.kind))
  const list = el('ul', { class: 'people', 'aria-label': 'People with access' })
  const members = f.members.length ? f.members : (f.owner ? [{ userId: f.owner.userId, name: f.owner.name, role: 'owner' }] : [])
  for (const m of members) {
    const isMe = m.userId === state.me.userId
    const controls = el('div', { class: 'person-controls' })
    if (isOwner && m.role !== 'owner') {
      const select = el('select', { class: 'tool-select', 'aria-label': `Role for ${m.name}`, onchange: (e) => act(() => cp.setMemberRole(docId, m.userId, e.target.value)) },
        ...roleOptions(f.kind, m.role))
      controls.append(select,
        m.via ? null : el('button', { type: 'button', class: 'btn btn-quiet', title: 'When their access ends', onclick: () => accessDialog(docId, m) }, m.until ? 'Change end' : 'Set an end'),
        el('button', { type: 'button', class: 'btn btn-quiet', title: 'Make this person the owner', onclick: () => transfer(docId, m) }, 'Make owner'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => removePerson(docId, m) }, 'Remove'))
    } else {
      controls.append(el('span', { class: 'person-role' }, ROLE_LABEL[m.role] || m.role))
    }
    list.append(el('li', { class: 'person' },
      el('span', { class: `presence-dot${m.online ? ' on' : ''}`, title: m.online ? 'Online' : 'Offline', 'aria-hidden': 'true' }),
      el('span', { class: 'person-name' }, isMe ? `${m.name} (you)` : m.name,
        m.pending ? el('span', { class: 'person-note' }, 'Joining with a link') : m.via ? el('span', { class: 'person-note' }, m.via.name ? `Through the shared folder “${m.via.name}”` : 'Through a shared folder') : null,
        m.until ? el('span', { class: 'person-note' }, `Until ${when(m.until)}${m.after === 'hide' ? ', then their copy is removed' : ', then read-only'}`) : null),
      controls))
  }
  out.push(el('h3', {}, 'People with access'), list)
  if (isOwner && f.guests?.length) out.push(el('h3', {}, 'Guests, only while you’re online'), guestList(f.guests, f.kind))
  out.push(...relaySection(docId, f))
  if (isOwner && f.access.managed) {
    out.push(el('div', { class: 'share-footer' },
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => resetLinks(docId) }, 'Stop all invite links…'),
      el('span', { class: 'fineprint-plain' }, 'Removing someone, or their access ending, stops sending them changes and moves everyone else to a new key. commonplace can remove their copy if you choose, but can’t stop someone who saved it another way.')))
  }
  return out
}

// ---- always-on relays ---------------------------------------------------------

export function relayStatus (h) {
  return h.online ? 'Connected' : h.lastSyncedAt ? `Last reached ${ago(h.lastSyncedAt)}` : 'Not reached yet'
}

function relaySection (docId, f) {
  const writable = f.role === 'owner' || f.role === 'editor'
  const relays = f.sync.relays || []
  if (!writable && !relays.length) return []
  const list = el('ul', { class: 'people', 'aria-label': 'Always-on relays' }, ...relays.map((h) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${h.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, el('code', { class: 'relay-key', title: h.address }, `${h.address.slice(0, 18)}…`), el('span', { class: 'person-note' }, relayStatus(h))),
    writable ? el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => act(() => cp.removeRelay(docId, h.key)) }, 'Remove') : null)))
  const input = el('input', { class: 'relay-input', placeholder: 'Paste a relay address (cpr1.…)', 'aria-label': 'Relay address', spellcheck: 'false' })
  const add = async () => {
    try { await cp.addRelay(docId, input.value); input.value = ''; toast('Relay added. It keeps an encrypted copy from now on.') } catch (err) { toast(cleanError(err)) }
  }
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add() } })
  return [
    el('h3', {}, 'Always-on relay'),
    el('p', { class: 'fineprint-plain' }, 'A computer that stays on and keeps an encrypted copy it can\u2019t read, so this file syncs even when nobody else who has it is online. Anyone can run one; see the README.'),
    relays.length ? list : null,
    writable ? el('div', { class: 'invite-row' }, input, el('button', { type: 'button', class: 'btn', onclick: add }, 'Add relay')) : null
  ].filter(Boolean)
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
const INVITE_DEFAULTS = { role: 'editor', expiresIn: '604800000', once: false, ask: false, access: 'always', after: 'keep' }
const loadInviteOptions = () => {
  try { return { ...INVITE_DEFAULTS, ...JSON.parse(localStorage.getItem(INVITE_KEY) || '{}') } } catch { return { ...INVITE_DEFAULTS } }
}
const saveInviteOptions = (o) => { try { localStorage.setItem(INVITE_KEY, JSON.stringify(o)) } catch {} }

function inviteControls (docId, kind) {
  const o = loadInviteOptions()
  if (kind === 'form' || !rolesFor(kind).includes(o.role)) o.role = rolesFor(kind)[0] // a form's link is for answering
  const role = el('select', { class: 'tool-select', 'aria-label': 'Role for people who use this link' }, ...roleOptions(kind, o.role))
  const expiry = el('select', { class: 'tool-select', 'aria-label': 'How long the link works' },
    ...EXPIRY.map((e) => el('option', { value: e.value, selected: e.value === String(o.expiresIn || '') || null }, e.label)))
  const once = el('input', { type: 'checkbox', checked: o.once || null })
  const ask = el('input', { type: 'checkbox', checked: o.ask || null })
  // How long the access the link gives lasts, and what happens after.
  const access = el('select', { class: 'tool-select', 'aria-label': 'How long their access lasts' },
    ...ACCESS.map(([value, label]) => el('option', { value, selected: value === o.access || null }, label)))
  const untilInput = el('input', { type: 'datetime-local', class: 'tool-select', 'aria-label': 'Access ends', value: localInput(Date.now() + 7 * 864e5) })
  const after = el('select', { class: 'tool-select', 'aria-label': 'When access ends' },
    ...AFTER.map(([value, label]) => el('option', { value, selected: value === o.after || null }, label)))
  const accessRow = el('div', { class: 'invite-row invite-access' }, el('span', { class: 'invite-label' }, 'Access'), access, untilInput, after)
  const note = el('p', { class: 'fineprint-plain' })
  const options = () => ({ role: role.value, expiresIn: expiry.value, once: once.checked, ask: ask.checked, access: access.value, until: access.value === 'until' ? new Date(untilInput.value).getTime() : null, after: after.value })
  const explain = () => {
    const v = options()
    untilInput.hidden = v.access !== 'until'
    after.hidden = v.access === 'always'
    // A guest link is for one person, admitted by your computer.
    once.disabled = ask.disabled = v.access === 'online'
    const ends = v.access === 'online'
      ? ` They never get the file\u2019s keys: your computer passes changes to them while it\u2019s on, and ${v.after === 'hide' ? 'their copy is removed while you\u2019re away' : 'their copy is read-only while you\u2019re away'}.`
      : v.access === 'until' ? ` Their access ends on its own; then ${v.after === 'hide' ? 'commonplace removes their copy' : 'they keep a read-only copy'}.` : ''
    note.textContent = (v.access === 'online'
      ? 'A guest link works for one person.'
      : v.ask
        ? 'Each person who opens the link shows up here, and gets nothing until you approve them. You need to be online to approve.'
        : v.once
          ? 'The first person you let in uses up the link. They get the file once you\u2019re online.'
          : 'People who open the link join right away, from you or anyone else who has the file.') + ends
  }
  // Remember the choices, but not a form's role as the default for other files.
  for (const c of [role, expiry, once, ask, access, after, untilInput]) c.addEventListener('change', () => { const v = options(); saveInviteOptions({ role: kind === 'form' ? loadInviteOptions().role : v.role, expiresIn: v.expiresIn, once: v.once, ask: v.ask, access: v.access, after: v.after }); explain() })
  explain()
  return el('div', { class: 'invite-box' },
    el('div', { class: 'invite-row' }, el('span', { class: 'invite-label' }, 'Invite link'), role, expiry,
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => copyLink(docId, options()) }, 'Copy invite link')),
    kind === 'folder' ? null : accessRow,
    el('div', { class: 'invite-options' },
      el('label', { class: 'check' }, once, 'One person only'),
      el('label', { class: 'check' }, ask, 'I approve each person')),
    note)
}

const ACCESS = [['always', 'Until I remove them'], ['until', 'Until a date'], ['online', 'Only while I’m online']]
const AFTER = [['keep', 'Then they keep a read-only copy'], ['hide', 'Then their copy is removed']]
// A time as a datetime-local value, in this computer's time zone.
const localInput = (ms) => { const d = new Date(ms); d.setMinutes(d.getMinutes() - d.getTimezoneOffset(), 0, 0); return d.toISOString().slice(0, 16) }

async function copyLink (docId, { role, expiresIn, once, ask, access, until, after }) {
  if (access === 'until' && !(until > Date.now())) { toast('Choose when their access ends, later than now.'); return }
  try {
    await cp.copyInvite(docId, role, { expiresIn: Number(expiresIn) || null, once, ask, access, until, after })
    const what = access === 'online' ? 'Guest link copied. It works for one person, while you’re online.' : role === 'viewer' ? 'View-only invite link copied.' : role === 'respondent' ? 'Link to answer the form copied.' : 'Invite link copied.'
    toast(ask && access !== 'online' ? `${what} You\u2019ll approve each person.` : what)
  } catch (err) { toast(cleanError(err)) }
}

// People using guest links on this file.
function guestList (guests, kind) {
  return el('ul', { class: 'people', 'aria-label': 'Guests' }, ...guests.map((g) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${g.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, g.guest?.name || 'A guest link nobody has used yet',
      el('span', { class: 'person-note' }, `${ROLE_LABEL[g.role] || g.role} · ${g.after === 'hide' ? 'copy removed while you’re away' : 'read-only while you’re away'}`)),
    el('div', { class: 'person-controls' },
      el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => endGuest(g) }, g.guest ? 'End access' : 'Cancel link')))))
}

async function endGuest (g) {
  const name = g.guest?.name
  if (name && !await confirmAction({ title: `End ${name}’s access?`, body: g.after === 'hide' ? `${name}’s copy is removed by commonplace.` : `${name} keeps a read-only copy as it is now.`, confirm: 'End access' })) return
  if (await act(() => cp.endGuest(g.mirrorId))) toast(name ? `${name}’s access ended` : 'Link cancelled')
}

// When a member's access ends, and what happens to their copy then.
async function accessDialog (docId, m) {
  const ends = el('select', { name: 'ends' }, el('option', { value: 'never', selected: !m.until || null }, 'Never (until I remove them)'), el('option', { value: 'at', selected: Boolean(m.until) || null }, 'At a date and time'))
  const at = el('input', { type: 'datetime-local', name: 'at', value: localInput(m.until || Date.now() + 7 * 864e5) })
  const after = el('select', { name: 'after' }, ...AFTER.map(([value, label]) => el('option', { value, selected: value === (m.after || 'keep') || null }, label)))
  const show = () => { at.hidden = after.hidden = ends.value !== 'at' }
  ends.addEventListener('change', show)
  show()
  const res = await dialog({
    title: `${m.name}’s access`,
    fields: [
      el('label', { class: 'field' }, 'Ends', ends), at, el('label', { class: 'field' }, 'Then', after),
      el('p', { class: 'fineprint-plain' }, 'Every computer stops syncing with them at that moment, and the next time you’re online everyone else moves to a new key.')
    ],
    confirm: 'Save',
    validate: (d) => (d.ends === 'at' && !(new Date(d.at).getTime() > Date.now()) ? 'Choose a time later than now, or remove them instead.' : null)
  })
  if (res?.action !== 'confirm') return
  const d = res.data
  if (await act(() => cp.setMemberAccess(docId, m.userId, d.ends === 'at' ? { until: new Date(d.at).getTime(), after: d.after } : { until: null }))) toast('Saved')
}

function requestList (docId, requests, kind) {
  return el('ul', { class: 'people', 'aria-label': 'People asking to join' }, ...requests.map((r) => {
    const role = el('select', { class: 'tool-select', 'aria-label': `Role for ${r.name}` }, ...roleOptions(kind, r.role))
    return el('li', { class: 'person' },
      el('span', { class: 'presence-dot on', 'aria-hidden': 'true' }),
      el('span', { class: 'person-name' }, r.name, el('span', { class: 'person-note' }, 'Asking to join')),
      el('div', { class: 'person-controls' }, role,
        el('button', { type: 'button', class: 'btn btn-primary', onclick: () => act(async () => { await cp.approveRequest(docId, r.userId, role.value); toast(`${r.name} can now open the file`) }) }, 'Let in'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => act(() => cp.declineRequest(docId, r.userId)) }, 'Decline')))
  }))
}

async function act (fn) {
  try { await fn(); return true } catch (err) { toast(cleanError(err)); return false }
}

async function removePerson (docId, m) {
  const after = el('select', { name: 'after' }, ...AFTER.map(([value, label]) => el('option', { value, selected: value === 'keep' || null }, label.replace(/^Then t/, 'T'))))
  const res = await dialog({
    title: `Remove ${m.name}?`,
    body: `${m.name} stops receiving changes and can no longer edit. Everyone else moves to a new key automatically, and existing invite links stop working.`,
    fields: [el('label', { class: 'field' }, 'Their copy', after)],
    confirm: 'Remove',
    danger: true
  })
  if (res?.action === 'confirm' && await act(() => cp.removeMember(docId, m.userId, { after: res.data.after }))) toast(`${m.name} was removed`)
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
  toast(mode === 'open' ? 'This file now syncs only while it’s open' : 'This file now syncs whenever commonplace is running')
}

// ---- moving the Drive -----------------------------------------------------

// keep: link another computer (both keep the Drive and stay in sync).
// Otherwise move to it: this computer signs out once it has everything.
export async function moveOutDialog ({ keep = false } = {}) {
  const status = el('p', { class: 'move-status', role: 'status' }, 'Getting a code…')
  const codeBox = el('code', { class: 'move-code' }, '…')
  const copy = el('button', { type: 'button', class: 'btn', disabled: true }, 'Copy code')
  const d = el('dialog', { class: 'dialog dialog-wide' }, el('form', { method: 'dialog' },
    el('h2', {}, keep ? 'Link another computer' : 'Move your Drive to another computer'),
    el('p', {}, keep
      ? 'The other computer gets your identity, folders and every file, and from then on both stay in sync, including files you add or remove. Both computers need to be online now.'
      : 'Your identity, folders and every file move to the other computer. When it confirms it has everything, this computer signs out and deletes its copies. Both computers need to be online.'),
    el('ol', { class: 'move-steps' },
      el('li', {}, 'On the other computer, install commonplace and open it.'),
      el('li', {}, 'Choose “Bring my Drive here” and paste this code.')),
    el('div', { class: 'move-code-row' }, codeBox, copy),
    el('p', { class: 'fineprint-plain' }, 'Anyone with this code can take your Drive while this window is open. Only paste it on your own computer. It expires in 15 minutes.'),
    status,
    el('div', { class: 'dialog-actions' }, el('button', { type: 'button', class: 'btn btn-quiet', 'data-role': 'close', onclick: () => d.close() }, 'Cancel'))))
  document.body.append(d)
  let finished = false
  const done = (text) => { finished = true; status.textContent = text; const b = d.querySelector('[data-role="close"]'); b.textContent = 'Done'; b.className = 'btn btn-primary' }
  const off = cp.onMoveStatus((s) => {
    if (s.phase === 'connected') status.textContent = 'Connected to the other computer.'
    else if (s.phase === 'sending') status.textContent = 'Sending your Drive…'
    else if (s.phase === 'confirmed') status.textContent = keep ? 'The other computer has everything.' : 'The other computer has everything. Signing out here…'
    else if (s.phase === 'linked') done('Done. Both computers now share your Drive.')
    else if (s.phase === 'signed-out') done('Done. This computer is signed out.')
    else if (s.phase === 'error') status.textContent = s.message
  })
  d.addEventListener('close', () => { off(); if (!finished) cp.cancelMove(); d.remove() })
  d.showModal()
  const code = await cp.startMove({ keep })
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
    body: 'On your other computer, open your name at the bottom left, choose “Link another computer” or “Move to another computer”, and paste the code it shows here. This computer must not have any files of its own yet.',
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
