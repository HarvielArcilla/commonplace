// Servers and team drives (docs/TEAM-DRIVES.md): the drive switcher, the
// line saying where a team drive is hosted, its settings, and Settings →
// Servers. A team drive is a shared folder its server owns, so inside it
// everything else is the ordinary Drive.

import { $, el, ago, toast, openMenu, dialog, promptText, cleanError } from './ui.js'
import { cp, state, formatBytes, ROLE_LABEL } from './state.js'
import { shareDialog } from './share.js'

// Team drives I'm in, by name.
export const teamDrives = () => state.folders.filter((f) => f.teamDrive).sort((a, b) => a.name.localeCompare(b.name))

// The team drive a folder is (or is in), or null for My Drive.
export function driveOfFolder (id) {
  const byId = (x) => state.folders.find((f) => f.id === x)
  let top = null
  for (let f = byId(id); f; f = byId(f.parentId)) top = f
  return top?.teamDrive ? top : null
}

const hostLine = (d) => (d.teamDrive.online ? `Hosted by ${d.teamDrive.hostName}` : `Hosted by ${d.teamDrive.hostName}, offline now`)

const go = (folderId) => window.dispatchEvent(new CustomEvent('commonplace:goto', { detail: { folderId } }))
const openSettings = (page) => window.dispatchEvent(new CustomEvent('commonplace:settings', { detail: { page } }))

// ---- the switcher ---------------------------------------------------------------

// The first crumb: My Drive, or the team drive on screen, with a menu of
// the others. Without any team drives it's just "commonDrive", as before.
export function driveCrumb (current, { last }) {
  const drives = teamDrives()
  if (!drives.length) return null
  const label = current ? current.name : 'My Drive'
  const b = el('button', {
    type: 'button',
    class: `crumb crumb-drive${last ? ' current' : ''}`,
    'aria-haspopup': 'menu',
    'aria-label': `${label}. Switch drive`,
    onclick: (e) => switcherMenu(e.currentTarget, current)
  }, el('span', {}, label), el('span', { class: 'crumb-caret', 'aria-hidden': 'true' }, '▾'))
  return last ? el('h1', { class: 'crumb-drive-wrap' }, b) : b
}

function switcherMenu (anchor, current) {
  openMenu(anchor, [
    { label: 'My Drive', hint: 'Files you own or were shared with you', checked: !current, onSelect: () => go(null) },
    ...teamDrives().map((d) => ({ label: d.name, hint: hostLine(d), checked: current?.id === d.id, onSelect: () => go(d.id) })),
    { sep: true },
    { label: 'Servers and team drives…', onSelect: () => openSettings('servers') }
  ], { label: 'Drives' })
}

// ---- inside a team drive ---------------------------------------------------------

// Above the files: where it's hosted, and (for admins) its settings.
export function driveBar (d) {
  const t = d.teamDrive
  return el('div', { class: 'drive-bar' },
    el('span', { class: `presence-dot${t.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
    el('span', { class: 'drive-bar-text' }, hostLine(d), '. ',
      t.online ? 'Files here stay owned by whoever added them; the server keeps them and lets everyone in the drive in.' : 'You can keep working: changes wait here and reach the drive when the server is back.'),
    el('span', { class: 'spacer' }),
    el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => shareDialog(d.id) }, 'People…'),
    t.admin ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => driveSettings(d) }, 'Drive settings') : null)
}

export function driveEmpty (d) {
  return el('div', { class: 'empty' },
    el('h2', {}, `${d.name} is empty`),
    el('p', {}, `Start something new or upload files while you’re here. They stay yours; ${d.teamDrive.hostName} keeps them and gives everyone in the drive access, even when you’re offline.`))
}

// What moving a file in or out changes, in words, or null if it stays in
// the same drive.
export function moveNote (item, fromDrive, toDrive) {
  if ((fromDrive?.id || null) === (toDrive?.id || null)) return null
  if (!item?.role) return null // one of my own folders: the Drive explains
  if (item.role !== 'owner') return { refuse: `Only ${item?.owner?.name || 'its owner'} can move this to another drive.` }
  if (toDrive) {
    const t = toDrive.teamDrive
    return {
      title: `Move to ${toDrive.name}?`,
      body: [
        `${t.hostName} will keep this and manage who has access, so everyone in the drive gets it even when you’re offline. You stay the owner.`,
        t.policy?.handover ? 'If you ever leave the drive, its admins can keep it: ownership passes to one of them.' : null,
        fromDrive ? `It leaves ${fromDrive.name}.` : null
      ].filter(Boolean).join(' '),
      confirm: 'Move'
    }
  }
  return {
    title: `Take it out of ${fromDrive.name}?`,
    body: `It goes back to My Drive. ${fromDrive.teamDrive.hostName} ${fromDrive.teamDrive.policy?.keepCopies ? 'keeps a read-only copy of it as it is now' : 'deletes its copy'}, and people who had it through the drive lose access.`,
    confirm: 'Move out'
  }
}

export async function driveSettings (d) {
  const t = d.teamDrive
  const box = (name, label, hint, checked) => el('div', { class: 'limit' },
    el('label', { class: 'check' }, el('input', { type: 'checkbox', name, checked: checked || null }), label),
    el('p', { class: 'limit-hint' }, hint))
  const file = state.files.find((f) => f.docId === d.id)
  const people = (file?.members || []).filter((m) => m.userId !== t.host && m.role !== 'owner')
  const peopleList = el('ul', { class: 'people', 'aria-label': 'People in the drive' }, ...people.map((m) => el('li', { class: 'person' },
    el('span', { class: 'person-name' }, m.userId === state.me?.userId ? `${m.name} (you)` : m.name, el('span', { class: 'person-note' }, m.role === 'manager' ? 'Admin' : ROLE_LABEL[m.role] || m.role)),
    m.role !== 'manager' && t.server
      ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: async (e) => { e.currentTarget.disabled = true; try { await cp.makeDriveAdmin(d.id, m.userId); toast(`${m.name} is an admin of ${d.name}`) } catch (err) { toast(cleanError(err)) } } }, 'Make admin')
      : null)))
  const res = await dialog({
    title: `${d.name} settings`,
    wide: true,
    body: el('p', { class: 'fineprint-plain' }, `${hostLine(d)}. Admins add and remove people (Share), and set the rules below.`),
    fields: [
      el('fieldset', { class: 'limits-group' }, el('legend', {}, 'Rules'),
        box('handover', 'Keep files when their owner leaves', 'Files moved in carry their owner’s promise: if they leave the drive, ownership passes to an admin. Applies to files moved in from now on.', t.policy?.handover),
        box('keepCopies', 'Keep a copy of files moved out', 'The server keeps a read-only copy as it was when it left.', t.policy?.keepCopies)),
      el('fieldset', { class: 'limits-group' }, el('legend', {}, 'People'),
        people.length ? peopleList : el('p', { class: 'fineprint-plain' }, 'Nobody else yet.'),
        t.server ? null : el('p', { class: 'fineprint-plain' }, 'Only the server’s admins can make someone an admin of a drive.'))
    ],
    extraActions: [{ label: 'Share…', value: 'share' }],
    confirm: 'Save'
  })
  if (res?.action === 'share') return shareDialog(d.id)
  if (res?.action !== 'confirm') return
  try { await cp.setDrivePolicy(d.id, { handover: res.data.handover, keepCopies: res.data.keepCopies }); toast('Saved') } catch (err) { toast(cleanError(err)) }
}

// ---- Settings → Servers ------------------------------------------------------------

export async function renderServers () {
  const servers = await cp.servers()
  const list = $('#servers-list')
  list.replaceChildren(...servers.map(serverCard))
  $('#servers-empty').hidden = servers.length > 0
}

function serverCard (s) {
  const st = s.status || {}
  const facts = [
    s.online ? 'Online' : st.seenAt ? `Offline, last seen ${ago(st.seenAt)}` : 'Offline',
    st.version ? `version ${st.version}` : null,
    st.usedBytes != null ? `keeping ${formatBytes(st.usedBytes)}` : null,
    st.freeBytes != null ? `${formatBytes(st.freeBytes)} free` : null
  ].filter(Boolean).join(' · ')
  return el('div', { class: 'server-card' },
    el('p', { class: 'server-name' }, el('span', { class: `presence-dot${s.online ? ' on' : ''}`, 'aria-hidden': 'true' }), s.name || 'Server'),
    el('p', { class: 'fineprint-plain' }, facts),
    s.drives.length ? el('ul', { class: 'people', 'aria-label': `Team drives on ${s.name}` }, ...s.drives.map((d) => el('li', { class: 'person' },
      el('span', { class: 'person-name' }, d.name, el('span', { class: 'person-note' }, d.joined ? 'Team drive' : 'Arriving…')),
      d.joined ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => go(d.id) }, 'Open') : null))) : null,
    el('div', { class: 'computer-actions' },
      el('button', { type: 'button', class: 'btn', onclick: () => newTeamDrive(s) }, 'New team drive…'),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => adminLink(s) }, 'Link for another admin…')))
}

async function newTeamDrive (s) {
  const name = await promptText({ title: `New team drive on ${s.name}`, label: 'Name', confirm: 'Create', body: 'Everyone you add gets everything in it. The server keeps its files, so nobody needs to be online at the same time.' })
  if (!name) return
  toast(`Asking ${s.name}…`)
  try {
    const id = await cp.createTeamDrive(s.id, name)
    toast(`Made ${name}`)
    renderServers()
    go(id)
  } catch (err) { toast(cleanError(err)) }
}

async function adminLink (s) {
  toast(`Asking ${s.name}…`)
  try {
    const link = await cp.serverAdminLink(s.id)
    await cp.copyText(link)
    dialog({
      title: 'Link copied',
      body: `Send it to the person who should help run ${s.name}. It works once, for a week, and lets them make team drives and add people to them.`,
      confirm: 'Done',
      cancel: null
    })
  } catch (err) { toast(cleanError(err)) }
}
