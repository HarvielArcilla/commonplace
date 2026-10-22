// Your computers (Settings → Your computers) and protection: removing a lost
// computer for real once your recovery key protects your account, and what
// a computer shows if another one of yours removed it.

import { $, el, ago, toast, dialog, confirmAction, cleanError } from './ui.js'
import { cp } from './state.js'

const STATUS = {
  unconfirmed: 'Joins your protected list when it next opens commonplace',
  removed: 'Removed'
}

export async function renderComputers () {
  const [devices, p] = await Promise.all([cp.listDevices(), cp.protection()])
  $('#profile-devices').replaceChildren(...devices.map((dv) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${dv.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, dv.name,
      el('span', { class: 'person-note' }, [dv.thisComputer ? 'This computer' : dv.online ? 'Online now' : `Last seen ${ago(dv.lastSeenAt)}`, STATUS[dv.status]].filter(Boolean).join(' · '))),
    dv.thisComputer ? null : el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => removeComputer(dv, p.on) }, p.on ? 'Remove' : 'Unlink'))))
  $('#protection').replaceChildren(...protectionNote(p))
}

function protectionNote (p) {
  if (p.removedHere) {
    return [el('div', { class: 'protection protection-removed' },
      el('p', {}, el('strong', {}, 'Another of your computers removed this one.'), ' It no longer syncs as you.'),
      el('div', { class: 'computer-actions' },
        el('button', { type: 'button', class: 'btn', onclick: recoverDialog }, 'That wasn’t me: use my recovery key'),
        el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: signOut }, 'Sign out here')))]
  }
  if (p.on) {
    return [el('div', { class: 'protection protection-on' },
      el('p', {}, el('strong', {}, 'Protected by your recovery key.'), ' Removing a lost computer cuts it off for real: it can’t act as you any more, and your files move to new keys it never gets. What it already had stays on it.'))]
  }
  return [el('div', { class: 'protection' },
    el('p', {}, el('strong', {}, 'Removing a computer only asks it to sign out.'), ' Every computer of yours holds your account key, so a stolen one could still act as you. Your recovery key can fix that: it locks the account key away, and each computer gets a key of its own.'),
    el('div', { class: 'computer-actions' },
      p.backup
        ? el('button', { type: 'button', class: 'btn', onclick: turnOnDialog }, 'Protect with my recovery key…')
        : el('button', { type: 'button', class: 'btn', onclick: () => window.dispatchEvent(new CustomEvent('commonplace:settings', { detail: { page: 'recovery' } })) }, 'Make a backup and recovery key first')))]
}

async function removeComputer (dv, protectedOn) {
  const ok = await confirmAction(protectedOn
    ? { title: `Remove ${dv.name}?`, body: `${dv.name} can’t act as you any more: nobody accepts what it signs, and your encryption key, your Drive and the files you manage move to new keys it won’t get. Files other people own move as soon as their computers hear of it. What it already had stays on it.`, confirm: 'Remove' }
    : { title: `Unlink ${dv.name}?`, body: `${dv.name} will sign out and delete its copy of your Drive the next time it connects. If it was lost or stolen, protect your account with your recovery key first, so removing it really cuts it off.`, confirm: 'Unlink' })
  if (!ok) return
  try {
    await cp.unlinkDevice(dv.id)
    toast(protectedOn ? `${dv.name} was removed` : `${dv.name} will sign out when it next connects`)
    renderComputers()
  } catch (err) { toast(cleanError(err)) }
}

async function askKey ({ title, body, confirm, run }) {
  let problem = ''
  let typed = ''
  for (;;) {
    const input = el('input', { name: 'key', value: typed, placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', autocomplete: 'off', spellcheck: 'false', class: 'recovery-input' })
    const res = await dialog({
      title,
      body,
      fields: [el('label', { class: 'field' }, 'Recovery key', input), problem ? el('p', { class: 'error' }, problem) : null],
      confirm,
      validate: (d) => (d.key.replace(/[\s-]/g, '').length === 25 ? null : 'A recovery key is 25 letters and numbers.')
    })
    if (res?.action !== 'confirm') return false
    typed = res.data.key
    try { await run(res.data.key); return true } catch (err) { problem = cleanError(err) }
  }
}

async function turnOnDialog () {
  const done = await askKey({
    title: 'Protect your account',
    body: 'Type the recovery key of your backup. It locks your account key away (only the recovery key opens it again), and every computer of yours gets a key of its own. Everyone you share with needs this version of commonplace to keep syncing with you.',
    confirm: 'Protect',
    run: (key) => cp.turnOnProtection(key)
  })
  if (done) { toast('Your account is protected'); renderComputers() }
}

async function recoverDialog () {
  const done = await askKey({
    title: 'Take your account back',
    body: 'With your recovery key, this computer starts a new list of your computers on its own. Every other computer, including the one that removed this one, is out until you link it again from here.',
    confirm: 'Take it back',
    run: (key) => cp.recoverAccount(key)
  })
  if (done) { toast('This computer is yours again. Link your other computers from here.'); renderComputers() }
}

async function signOut () {
  const ok = await confirmAction({ title: 'Sign out here?', body: 'This computer deletes its copy of your Drive. Your files stay with your other computers and your collaborators.', confirm: 'Sign out' })
  if (ok) await cp.signOut()
}

// Shown once when it happens, wherever you are.
export function watchRemoval () {
  const show = async () => {
    const ok = await confirmAction({
      title: 'This computer was removed from your account',
      body: 'Another of your computers removed this one, so it no longer syncs as you. If that was you, sign out here. If it wasn’t, your recovery key takes your account back.',
      confirm: 'See what to do',
      danger: false
    })
    if (ok) window.dispatchEvent(new CustomEvent('commonplace:settings', { detail: { page: 'computers' } }))
  }
  cp.onRemoved(show)
  cp.protection().then((p) => { if (p.removedHere) show() }).catch(() => {})
}
