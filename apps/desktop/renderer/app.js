// Window entry point: wires commonDrive and commonDocs to the background process.
// Bundled by build.mjs into renderer/dist/app.js.

import { $, el, toast, confirmAction, cleanError } from './ui.js'
import { state, cp } from './state.js'
import { initDrive, renderDrive, goTo } from './drive-view.js'
import { renderServers } from './teams-view.js'
import { initDocView, openDocument, renderDocMargin, closeDocument } from './doc-view.js'
import { renderStorage, renderLimits, renderNetwork, renderLocalRelay } from './settings-view.js'
import { moveOutDialog, moveInDialog, relayStatus } from './share.js'
import { renderRecovery, restoreDialog } from './recovery-view.js'
import { openActivity, showActivityCount } from './activity-view.js'
import { showThread } from './comments-view.js'
import { showShortcuts } from './shortcuts.js'
import { renderComputers, watchRemoval } from './computers-view.js'
import { setTheme } from './theme.js'

const COLORS = ['#b4532a', '#2f6f5e', '#4a5aa8', '#8a4f8c', '#a2741b', '#2d6f8f', '#9b3d4f', '#55703a']

document.body.classList.toggle('mac', cp.platform === 'darwin')

// ---- the margin ------------------------------------------------------------------
// Its rule starts below each view's toolbars, and it can fold to a narrow
// rail (one choice for every view, remembered).

const FOLD_KEY = 'commonplace.marginFolded'
function setFolded (folded, save = true) {
  document.body.classList.toggle('margin-folded', folded)
  for (const b of document.querySelectorAll('[data-action="fold"]')) {
    b.textContent = folded ? '›' : '‹'
    b.title = folded ? 'Show notes' : 'Hide notes'
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-expanded', String(!folded))
  }
  if (save) try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0') } catch {}
}
try { setFolded(localStorage.getItem(FOLD_KEY) === '1', false) } catch { setFolded(false, false) }
document.querySelectorAll('[data-action="fold"]').forEach((b) => b.addEventListener('click', () => setFolded(!document.body.classList.contains('margin-folded'))))

const placeRule = (view) => {
  const bar = view.querySelector('.bar')
  const tools = view.querySelector('.toolbar')
  view.style.setProperty('--rule-top', `${bar.offsetHeight + (tools?.offsetParent ? tools.offsetHeight : 0)}px`)
}
for (const view of document.querySelectorAll('.view')) {
  const watch = new ResizeObserver(() => placeRule(view))
  view.querySelectorAll('.bar, .toolbar').forEach((n) => watch.observe(n))
}

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
// A file chip, or anything else that links to a file in the Drive.
window.addEventListener('commonplace:open', (e) => { if (e.detail?.docId) open(e.detail.docId) })

// From the activity list or a notification: the file, and the thread in it.
async function openThread (docId, threadId) {
  const file = state.files.find((f) => f.docId === docId)
  if (!file) return
  if (file.kind === 'folder') { showDrive(); return }
  if (state.open?.docId !== docId) await open(docId)
  if (threadId && state.open?.docId === docId) showThread(threadId)
}
$('[data-action="activity"]').addEventListener('click', () => openActivity({ openThread }))
cp.onActivityOpen((docId, threadId) => openThread(docId, threadId))
cp.listActivity().then((items) => showActivityCount(items.filter((i) => !i.read).length)).catch(() => {})
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

const PAGE_KEY = 'commonplace.settingsPage'

// Settings: one page at a time, chosen on the left. The first time, only
// the name and color, to get started.
function openProfileDialog (page = null) {
  const d = $('#profile-dialog')
  const firstRun = !state.me.hasChosenName
  $('#profile-name').value = firstRun ? '' : state.me.name
  const colors = $('#profile-colors')
  colors.querySelectorAll('label').forEach((l) => l.remove())
  for (const c of COLORS) {
    colors.append(el('label', { title: c },
      el('input', { type: 'radio', name: 'color', value: c, checked: c === state.me.color, 'aria-label': `Color ${c}` }),
      el('span', { class: 'swatch', style: `--swatch:${c}` })))
  }
  // (Your ID is for checking who's who, not for a first look.)
  $('#profile-id').textContent = firstRun ? '' : `Your ID: ${state.me.userId}`
  d.classList.toggle('first-run', firstRun)
  $('#settings-nav').hidden = firstRun
  $('#profile-heading').textContent = firstRun ? 'What should collaborators call you?' : 'Name and color'
  $('#first-run-restore').hidden = !firstRun
  $('#profile-save').textContent = firstRun ? 'Start' : 'Done'
  let saved = null
  try { saved = localStorage.getItem(PAGE_KEY) } catch {}
  showSettingsPage(firstRun ? 'profile' : page || saved || 'profile')
  cp.getSettings().then((x) => {
    $('#setting-spellcheck').checked = x.spellcheck
    for (const r of document.querySelectorAll('#setting-theme input')) r.checked = r.value === x.theme
    setTheme(x.theme)
  }).catch(() => {})
  if (!firstRun) { renderComputers(); renderMyRelays(); renderRecovery(); renderStorage(); renderLimits(); renderNetwork(); renderLocalRelay() }
  if (!d.open) d.showModal()
}

function showSettingsPage (key) {
  const pages = [...document.querySelectorAll('#profile-dialog .settings-page')]
  if (!pages.some((p) => p.dataset.page === key)) key = 'profile'
  for (const p of pages) p.hidden = p.dataset.page !== key
  for (const b of document.querySelectorAll('#settings-nav button:not([data-anchor])')) b.setAttribute('aria-current', String(b.dataset.page === key))
  $('#profile-dialog .settings-body').scrollTop = 0
  try { localStorage.setItem(PAGE_KEY, key) } catch {}
}

// Anything can open a settings page: dispatch 'commonplace:settings' { page }.
window.addEventListener('commonplace:settings', (e) => openProfileDialog(e.detail?.page || null))

const PAGE_RENDER = { computers: renderComputers, recovery: renderRecovery, relays: () => { renderMyRelays(); renderLocalRelay() }, servers: renderServers, network: renderNetwork, storage: renderStorage, limits: renderLimits }
$('#open-shortcuts').addEventListener('click', () => showShortcuts())
$('#settings-nav').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-page]')
  if (!b) return
  showSettingsPage(b.dataset.page)
  PAGE_RENDER[b.dataset.page]?.() // each page shows what's true now
  if (b.dataset.anchor) document.getElementById(`limits-${b.dataset.anchor}`)?.scrollIntoView({ block: 'start' })
})

window.addEventListener('commonplace:relays', () => renderMyRelays())
// From anywhere: open a settings page, or a folder (a team drive) in the Drive.
window.addEventListener('commonplace:settings', (e) => { openProfileDialog(e.detail?.page); PAGE_RENDER[e.detail?.page]?.() })
window.addEventListener('commonplace:goto', async (e) => {
  if ($('#profile-dialog').open) $('#profile-dialog').close()
  state.folders = await cp.listFolders()
  if (state.open) await closeDocument()
  showDrive()
  goTo(e.detail?.folderId || null)
})

async function renderMyRelays () {
  const relays = await cp.myRelays()
  $('#profile-relay-list').hidden = !relays.length
  $('#profile-relay-list').replaceChildren(...relays.map((h) => el('li', { class: 'person' },
    el('span', { class: `presence-dot${h.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'person-name' }, el('code', { class: 'relay-key', title: h.address }, `${h.address.slice(0, 18)}…`), el('span', { class: 'person-note' }, relayStatus(h))),
    el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: async () => { await cp.removeMyRelay(h.key); renderMyRelays() } }, 'Remove'))))
}

$('#profile-relay-add').addEventListener('click', async () => {
  try {
    await cp.addMyRelay($('#profile-relay-input').value, { everywhere: $('#profile-relay-all').checked })
    $('#profile-relay-input').value = ''
    toast('Relay added')
    renderMyRelays()
  } catch (err) { toast(cleanError(err)) }
})

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
// These take effect as soon as they change.
$('#setting-spellcheck').addEventListener('change', (e) => cp.setSettings({ spellcheck: e.target.checked }))
$('#setting-theme').addEventListener('change', (e) => { setTheme(e.target.value); cp.setSettings({ theme: e.target.value }) })
$('#profile-dialog').addEventListener('cancel', (e) => { if (!state.me?.hasChosenName) e.preventDefault() })
$('[data-action="profile"]').addEventListener('click', () => openProfileDialog())
$('#move-out').addEventListener('click', () => {
  $('#profile-dialog').close()
  moveOutDialog({ keep: false })
})
$('#link-out').addEventListener('click', () => {
  $('#profile-dialog').close()
  moveOutDialog({ keep: true })
})
// On first run, the name can wait for someone bringing their Drive here.
const backToNameIfNeeded = () => { if (!state.me?.hasChosenName && !$('#profile-dialog').open) openProfileDialog() }
$('#restore-first').addEventListener('click', () => {
  $('#profile-dialog').close()
  restoreDialog().finally(backToNameIfNeeded)
})
$('#move-first').addEventListener('click', () => {
  $('#profile-dialog').close()
  moveInDialog().finally(backToNameIfNeeded)
})
cp.onBackup(() => { if ($('#profile-dialog').open && !$('#profile-recovery').hidden) renderRecovery() })
cp.onNotice((text) => toast(text))

// ---- updates -------------------------------------------------------------------

let toldAboutUpdate = false
function showUpdate (u) {
  const note = $('#update-note')
  if (u?.problem && !u.available) {
    note.replaceChildren(el('span', {}, u.problem), el('button', { type: 'button', class: 'btn', onclick: () => cp.openUpdatePage() }, 'See the release'))
    note.hidden = false
    return
  }
  if (!u?.available) { note.hidden = true; return }
  const what = u.channel === 'main' && u.behind ? `${u.behind} change${u.behind === 1 ? '' : 's'}` : u.changes[0] || 'A new version'
  const installer = Boolean(u.asset)
  note.title = u.changes.length ? `What's new:\n${u.changes.join('\n')}` : ''
  note.replaceChildren(
    el('span', {}, u.installing ? (installer ? 'Downloading the new version…' : 'Updating commonplace…') : u.downloaded ? 'The new version is downloaded and checked. Its installer is open.' : `A new version of commonplace is available (${what}).${u.verified ? ' Signed by the project.' : ''}`),
    u.problem ? el('span', { class: 'update-problem' }, u.problem) : null,
    u.installing || u.downloaded ? null : u.canInstall
      ? el('button', { type: 'button', class: 'btn btn-primary', onclick: () => confirmUpdate(installer) }, installer ? 'Download and install' : 'Update and restart')
      : el('button', { type: 'button', class: 'btn', onclick: () => cp.openUpdatePage() }, 'See what’s new'))
  note.hidden = false
  if (!toldAboutUpdate && !u.installing) { toldAboutUpdate = true; toast('A new version of commonplace is available.') }
}
async function confirmUpdate (installer) {
  const ok = await confirmAction(installer
    ? { title: 'Download and install?', body: 'commonplace downloads the new installer, checks it against the project’s signature, and opens it. Quit commonplace when the installer asks.', confirm: 'Download and install', danger: false }
    : { title: 'Update and restart?', body: 'commonplace closes, downloads the new version, and opens again in a minute or two. Your files stay where they are.', confirm: 'Update and restart', danger: false })
  if (ok) cp.installUpdate()
}
cp.onUpdates(showUpdate)
cp.updateState().then(showUpdate)
cp.getPolicy().then((p) => { state.trashDays = p.values.trashDays }).catch(() => {})
cp.getSettings().then((x) => setTheme(x.theme)).catch(() => {})
watchRemoval()

// ---- boot ----------------------------------------------------------------------

cp.onDriveChanged((files, me, folders, unread) => {
  state.files = files
  state.me = me
  if (folders) state.folders = folders
  if (unread != null) showActivityCount(unread)
  if ($('#profile-dialog').open && !$('#profile-computers').hidden) { renderComputers(); renderMyRelays() }
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
