// Recovery: making a backup and its recovery key (in your profile), and
// restoring one on a new computer (from an empty Drive).

import { $, el, ago, toast, dialog, cleanError, confirmAction } from './ui.js'
import { cp } from './state.js'

// ---- the Recovery section of the profile -------------------------------------------

export async function renderRecovery () {
  const box = $('#profile-recovery-body')
  const s = await cp.backupStatus()
  if (!s.on) {
    box.replaceChildren(
      el('p', { class: 'fineprint-plain' }, 'If this computer is lost and you have no other, a backup lets a new one become you again: your identity, folders and files. It stays up to date once a day while commonplace runs, and only your recovery key opens it.'),
      el('div', { class: 'computer-actions' }, el('button', { type: 'button', class: 'btn', onclick: makeBackup }, 'Make a backup…')))
    return
  }
  box.replaceChildren(
    el('p', { class: 'backup-where' }, el('span', { class: 'person-note' }, 'Backing up to'), el('code', { class: 'relay-key', title: s.path }, s.path)),
    el('p', { class: s.error ? 'error' : 'fineprint-plain' }, s.error || (s.lastAt ? `Last backed up ${ago(s.lastAt)}.` : 'Backs up within the hour.')),
    el('div', { class: 'computer-actions' },
      el('button', { type: 'button', class: 'btn', onclick: async () => { await cp.refreshBackup(); renderRecovery(); toast('Backed up') } }, 'Back up now'),
      el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: stopBackup }, 'Stop backing up')))
}

async function makeBackup () {
  let made
  try { made = await cp.createBackup() } catch (err) { toast(cleanError(err)); return }
  if (!made) return
  renderRecovery()
  await showRecoveryKey(made.recoveryKey)
}

// Shown once. The key is never stored anywhere, so it can't be shown again.
async function showRecoveryKey (key) {
  const copy = el('button', { type: 'button', class: 'btn', onclick: async () => { await cp.copyText(key); toast('Recovery key copied') } }, 'Copy')
  await dialog({
    title: 'Your recovery key',
    body: 'Write this down, or keep it in a password manager. To restore, you need it and the backup file. This is the only time it’s shown: commonplace doesn’t keep it.',
    fields: [
      el('div', { class: 'move-code-row' }, el('code', { class: 'move-code recovery-key' }, key), copy),
      el('p', { class: 'fineprint-plain' }, 'Anyone with both the file and this key can become you. Keep them in different places.'),
      el('label', { class: 'check' }, el('input', { type: 'checkbox', name: 'saved' }), 'I’ve saved my recovery key')
    ],
    confirm: 'Done',
    cancel: null,
    required: true,
    validate: (d) => (d.saved ? null : 'Save the key first. Without it the backup can’t be opened.')
  })
}

async function stopBackup () {
  const ok = await confirmAction({
    title: 'Stop backing up?',
    body: 'The backup file stays where it is, but it won’t get your newer changes. To back up again later, you make a new backup with a new recovery key.',
    confirm: 'Stop backing up'
  })
  if (!ok) return
  await cp.stopBackup()
  renderRecovery()
}

// ---- restoring on a new computer --------------------------------------------------

export async function restoreDialog () {
  const file = await cp.pickBackup()
  if (!file) return
  let problem = ''
  let typed = ''
  for (;;) {
    const input = el('input', { name: 'key', value: typed, placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX', autocomplete: 'off', spellcheck: 'false', class: 'recovery-input' })
    const res = await dialog({
      title: 'Restore from a backup',
      body: 'This computer becomes you, with your folders and files as they were at the backup. Anything newer arrives from your collaborators and your other computers when they’re online.',
      fields: [
        el('p', { class: 'fineprint-plain' }, file),
        el('label', { class: 'field' }, 'Recovery key', input),
        problem ? el('p', { class: 'error' }, problem) : null
      ],
      confirm: 'Restore',
      validate: (d) => (d.key.replace(/[\s-]/g, '').length === 25 ? null : 'A recovery key is 25 letters and numbers.')
    })
    if (res?.action !== 'confirm') return
    typed = res.data.key
    toast('Restoring…')
    try {
      const r = await cp.restoreBackup(file, res.data.key)
      toast(`Restored ${r.count} file${r.count === 1 ? '' : 's'}`)
      return
    } catch (err) {
      problem = cleanError(err) // ask again, saying what went wrong
    }
  }
}
