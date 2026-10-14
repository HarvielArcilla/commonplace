// Window entry point: wires CommonDrive and CommonDocs to the background process.
// Bundled by build.mjs into renderer/dist/app.js.

import { $, el, toast, cleanError } from './ui.js'
import { state, cp } from './state.js'
import { initDrive, renderDrive } from './drive-view.js'
import { initDocView, openDocument, renderDocMargin } from './doc-view.js'

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
  d.showModal()
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

// ---- boot ----------------------------------------------------------------------

cp.onDriveChanged((files, me, folders) => {
  state.files = files
  state.me = me
  if (folders) state.folders = folders
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
