// Window entry point: wires CommonDrive and CommonDocs to the background process.
// Bundled by build.mjs into renderer/dist/app.js.

import { $, el, ago, toast, confirmAction, cleanError } from './ui.js'
import { state, cp } from './state.js'
import { initDrive, renderDrive } from './drive-view.js'
import { initDocView, openDocument, renderDocMargin } from './doc-view.js'
import { moveOutDialog, helperStatus } from './share.js'

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']

document.body.classList.toggle('mac', cp.platform === 'darwin')

function showDrive () {
  $('#doc-view').hidden = true
  $('#drive-view').hidden = false
  renderDrive()
}

async function open (docId, opts) {
  try {
    await openDocument(docId, opts)
  } catch (err) {
    toast(cleanError(err))
    showDrive()
  }
}

initDrive({ openDocument: open, openJoinDialog })
initDocView({ onBack: showDrive })

// ---- join with invite ------------------------------------------------------

function openJoinDialog (prefill = '') {
  const d = $('#join-dialog')
  $('#join-input').value = typeof prefill === 'string' ? prefill : ''
  $('#join-error').textContent = ''
  d.showModal()
  $('#join-input').focus()
}

$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    await cp.joinWithInvite($('#join-input').value, state.folderId)
    $('#join-dialog').close()
    toast('Added to your Drive. It fills in when someone who has it is online.')
  } catch (err) {
    $('#join-error').textContent = cleanError(err)
  }
})
$('#join-input').addEventListener('input', () => { $('#join-error').textContent = '' })
document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()))

// ---- profile -----------------------------------------------------------------

function openProfileDialog () {
  const d = $('#profile-dialog')
  $('#profile-name').value = state.me.hasChosenName ? state.me.name : ''
  const colors = $('#profile-colors')
  colors.querySelectorAll('label').forEach((l) => l.remove())
  for (const c of COLORS) {
    colors.append(el('label', { title: c },
      el('input', { type: 'radio', name: 'color', value: c, checked: c === state.me.color, 'aria-label': `Color ${c}` }),
      el('span', { class: 'swatch', style: `--swatch:${c}` })))
  }
  $('#profile-id').textContent = `Your ID: ${state.me.userId}`
  $('#profile-computers').hidden = !state.me.hasChosenName // not during first-run setup
  $('#profile-helpers').hidden = !state.me.hasChosenName
  if (state.me.hasChosenName) { renderComputers(); renderMyHelpers() }
  d.showModal()
}

async function renderComputers () {
  const devices = await cp.listDevices()
  $('#profile-devices').replaceChildren(...devices.map((dv) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${dv.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, dv.name,
      el('span', { class: 'person-note' }, dv.thisComputer ? 'This computer' : dv.online ? 'Online now' : `Last seen ${ago(dv.lastSeenAt)}`)),
    dv.thisComputer ? null : el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => unlink(dv) }, 'Unlink'))))
}

async function renderMyHelpers () {
  const helpers = await cp.myHelpers()
  $('#profile-helper-list').hidden = !helpers.length
  $('#profile-helper-list').replaceChildren(...helpers.map((h) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${h.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, el('code', { class: 'helper-key', title: h.address }, `${h.address.slice(0, 18)}…`), el('span', { class: 'person-note' }, helperStatus(h))),
    el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: async () => { await cp.removeMyHelper(h.key); renderMyHelpers() } }, 'Remove'))))
}

$('#profile-helper-add').addEventListener('click', async () => {
  try {
    await cp.addMyHelper($('#profile-helper-input').value, { everywhere: $('#profile-helper-all').checked })
    $('#profile-helper-input').value = ''
    toast('Helper added')
    renderMyHelpers()
  } catch (err) { toast(cleanError(err)) }
})

async function unlink (dv) {
  const ok = await confirmAction({
    title: `Unlink ${dv.name}?`,
    body: `${dv.name} will sign out and delete its copy of your Drive the next time it connects. Your files stay on this computer and with your collaborators. If that computer was lost or stolen, also remove yourself from files that matter, since it has your identity until it connects.`,
    confirm: 'Unlink'
  })
  if (!ok) return
  try { await cp.unlinkDevice(dv.id); toast(`${dv.name} will sign out when it next connects`); renderComputers() } catch (err) { toast(cleanError(err)) }
}

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const name = $('#profile-name').value.trim()
  if (!name) { $('#profile-error').textContent = 'Enter a name first.'; return }
  const color = $('#profile-form').querySelector('input[name=color]:checked')?.value
  state.me = await cp.setProfile({ name, color })
  $('#profile-dialog').close()
  renderDrive()
})
$('#profile-name').addEventListener('input', () => { $('#profile-error').textContent = '' })
$('#profile-dialog').addEventListener('cancel', (e) => { if (!state.me?.hasChosenName) e.preventDefault() })
$('[data-action="profile"]').addEventListener('click', openProfileDialog)
$('#move-out').addEventListener('click', () => {
  $('#profile-dialog').close()
  moveOutDialog({ keep: false })
})
$('#link-out').addEventListener('click', () => {
  $('#profile-dialog').close()
  moveOutDialog({ keep: true })
})
cp.onNotice((text) => toast(text))

// ---- boot ----------------------------------------------------------------------

cp.onDriveChanged((files, me, folders) => {
  state.files = files
  state.me = me
  if (folders) state.folders = folders
  if ($('#profile-dialog').open && !$('#profile-computers').hidden) { renderComputers(); renderMyHelpers() }
  if (state.open) renderDocMargin()
  else renderDrive()
})

cp.onInvite((url) => {
  if (state.open) toast('Got an invite. Go back to Drive to join it.')
  openJoinDialog(url)
})

// Keep "5 min ago" labels honest without a reload.
setInterval(() => { if (state.open) renderDocMargin(); else renderDrive() }, 30000)

;(async () => {
  ;[state.me, state.files, state.folders, state.apps] = await Promise.all([cp.me(), cp.listFiles(), cp.listFolders(), cp.listApps()])
  renderDrive()
  if (!state.me.hasChosenName) openProfileDialog()
})()
