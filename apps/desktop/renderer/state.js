// Shared window state and the sync-status vocabulary used everywhere.

import { el, ago, listNames } from './ui.js'

export const cp = window.commonplace

// Opens a file in the Drive from anywhere (a chip, a task on a calendar).
export const openFile = (docId) => window.dispatchEvent(new CustomEvent('commonplace:open', { detail: { docId } }))

const PREFS_KEY = 'commonplace.drive.prefs'
const DEFAULT_PREFS = { mode: 'list', filter: 'all', type: 'all', sort: 'recent' }

function loadPrefs () {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { ...DEFAULT_PREFS } }
}

export function savePrefs () {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)) } catch {}
}

// ---- roles ------------------------------------------------------------------
// What someone may do with a file. Every view asks here, so a new role, or a
// new reason a file is read-only (access ended, a newer format...), is
// decided in one place. (The background process enforces the same rules for
// itself; see core/gate.js.)

export const ROLE_LABEL = { owner: 'Owner', manager: 'Can edit and share', editor: 'Can edit', commenter: 'Can comment', viewer: 'Can view', respondent: 'Can answer' }
const ROLE_VERB = { owner: 'edit', manager: 'edit and share', editor: 'edit', commenter: 'comment on', viewer: 'view', respondent: 'answer' }
export const roleVerb = (role) => ROLE_VERB[role] || 'view'
export const editorRole = (role) => role === 'owner' || role === 'manager' || role === 'editor'
// May invite and remove people (the owner, or someone who can share).
export const manages = (file) => file?.role === 'owner' || Boolean(file?.access?.manage)

// can(file, 'edit' | 'comment'): whether I can do that to this file now.
export function can (file, what) {
  if (!file || file.access?.removed || file.ended || file.guest?.away || file.newerFormat) return false
  if (what === 'edit') return editorRole(file.role)
  if (what === 'comment') return editorRole(file.role) || file.role === 'commenter'
  return false
}

export const state = {
  me: null,
  files: [],
  folders: [],
  apps: [],
  folderId: null,
  query: '',
  prefs: loadPrefs(),
  open: null
}

// Status notes shown in the margin, for the list and for an open document.
// "Here" means someone has the file open; "syncing" means our computers are
// exchanging changes in the background.
export const formatBytes = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${Math.round(n / 1024)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB` : `${(n / 1024 ** 3).toFixed(1)} GB`)

// A moment in words: "today at 5:00 PM", "Oct 20 at 9:30 AM".
export function when (ms) {
  const d = new Date(ms)
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return `today at ${time}`
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })} at ${time}`
}

// Why a file stopped syncing to protect this computer (see Drive._guard).
const HELD = {
  size: (h) => `Paused at ${formatBytes(h.bytes)} so it doesn’t fill this computer.`,
  own: (h) => `Paused: others’ edits made it ${formatBytes(h.bytes)}, past your limit for your own files.`,
  total: () => 'Paused: files others made already take all the space you allow them.',
  space: () => 'Paused: this disk is down to the free space you keep.',
  many: () => 'Paused: a shared folder brought more files today than you allow.',
  blocked: () => 'Paused: it’s from someone you’ve blocked.'
}

export function statusNotes (file, { detailed = false } = {}) {
  const notes = []
  const isMe = (p) => p.userId === state.me?.userId
  const here = (file.sync.here || []).filter((p) => !isMe(p))
  const syncing = file.sync.peers.filter((p) => !isMe(p) && !here.some((h) => h.userId === p.userId))
  if (file.ended) {
    notes.push({ text: file.ended.after === 'hide' ? 'Your access ended, and its owner asked for your copy to be removed.' : `Your access ended ${ago(file.ended.at)}. This is a read-only copy as it was then.`, cls: 'warn' })
    return notes
  }
  if (file.guest) {
    const owner = file.owner?.name || 'the owner'
    notes.push(file.guest.away
      ? { text: `You can open this only while ${owner} is online, and they’re away${file.guest.after === 'hide' ? ', so it’s empty for now' : '. This copy is read-only until they’re back'}.`, cls: 'warn' }
      : { text: `A guest: you can open this while ${owner} is online.` })
  }
  if (file.accessUntil && !file.ended) notes.push({ text: `Your access ends ${when(file.accessUntil)}.` })
  if (file.access?.removed) {
    notes.push({ text: 'You no longer have access. This copy stays as it was.', cls: 'warn' })
    return notes
  }
  if (file.requests?.length) {
    notes.push({ text: `${listNames(file.requests)} ${file.requests.length === 1 ? 'is' : 'are'} asking to join`, cls: 'warn', request: true })
  }
  if (file.access?.inviteProblem) {
    const why = { expired: 'This invite link expired before you were let in.', used: 'Someone else already used this one-person link.', revoked: 'The owner stopped this invite link.' }[file.access.inviteProblem] || 'This invite link doesn\u2019t work.'
    notes.push({ text: `${why} Ask ${file.owner?.name || 'the owner'} for a new one.`, cls: 'warn' })
    return notes
  }
  if (file.access?.waitingForApproval) {
    notes.push({ text: `Asked ${file.owner?.name || 'the owner'} to let you in. They need to be online to say yes.`, cls: 'warn' })
    return notes
  }
  if (file.waitingForPeer) {
    notes.push({ text: 'Waiting for someone who has this file to come online', cls: 'warn' })
    return notes
  }
  if (file.access?.waitingForKey) {
    notes.push({ text: `Waiting for ${file.owner?.name || 'the owner'} to let you in`, cls: 'warn' })
    return notes
  }
  if (file.held) {
    const why = HELD[file.held.reason] || HELD.size
    notes.push({ text: why(file.held), cls: 'warn', action: file.held.reason === 'blocked' ? null : { label: 'Keep syncing', run: () => cp.keepSyncing(file.docId) } })
    if (file.held.reason === 'many' && file.held.folderId) notes.push({ text: 'Everything this folder brought today', action: { label: 'Sync all', run: () => cp.keepSyncingFolder(file.held.folderId) } })
    return notes
  }
  const up = file.upload
  if (up && !up.waiting && !up.ready) {
    if (up.hold === 'large') notes.push({ text: `Large file (${formatBytes(up.size)}). Not downloaded yet.`, cls: 'warn', action: { label: 'Download', run: () => cp.approveDownload(file.docId) } })
    else if (up.hold === 'risky') notes.push({ text: 'Can run programs. Download only if you trust who shared it.', cls: 'warn' })
    else if (up.hold === 'space') notes.push({ text: 'Not enough free space to download', cls: 'warn' })
    else if (up.hold === 'limit') notes.push({ text: `Over your largest-file limit (${formatBytes(up.size)}).`, cls: 'warn', action: { label: 'Download anyway', run: () => cp.approveDownload(file.docId) } })
    else if (up.hold === 'budget') notes.push({ text: 'Waiting: today’s download limit for this person is used up.', cls: 'warn', action: { label: 'Download', run: () => cp.approveDownload(file.docId) } })
    else if (up.hold === 'blocked') notes.push({ text: 'From someone you’ve blocked', cls: 'warn' })
    else if (up.hold === 'removed') notes.push({ text: 'Not on this computer', action: { label: 'Download', run: () => cp.approveDownload(file.docId) } })
    else if (up.downloading) notes.push({ text: `Downloading ${Math.round(up.progress * 100)}%`, cls: 'live' })
  }
  if (!file.supported) {
    notes.push({ text: 'Made with a newer version of commonplace. Update to open it.', cls: 'warn', action: { label: 'Check for updates', run: () => cp.openUpdatePage() } })
    return notes
  }
  if (file.newerFormat) notes.push({ text: 'Changed by a newer version of commonplace, so it’s read-only here. Update to edit it.', cls: 'warn', action: { label: 'Check for updates', run: () => cp.openUpdatePage() } })
  for (const p of file.sync?.outdated || []) {
    notes.push({ text: p.side === 'older' ? `${p.name} has an older version of commonplace${p.app ? ` (${p.app})` : ''}. You’ll sync once they update.` : `${p.name} has a newer version of commonplace${p.app ? ` (${p.app})` : ''}. Update to sync with them.`, cls: 'warn' })
  }
  const conflicts = file.conflicts?.length || 0
  if (conflicts) {
    const what = conflicts === 1 ? '1 conflict' : `${conflicts} conflicts`
    notes.push(file.role === 'owner'
      ? { text: `${what} from edits made while apart. Your decision is needed.`, cls: 'warn', conflict: true }
      : { text: `${what} from edits made while apart, waiting for ${file.owner?.name || 'the owner'} to decide`, cls: 'warn', conflict: true })
  }
  const review = [
    file.review?.comments ? `${file.review.comments} open comment${file.review.comments === 1 ? '' : 's'}` : null,
    file.review?.suggestions ? `${file.review.suggestions} suggestion${file.review.suggestions === 1 ? '' : 's'}` : null
  ].filter(Boolean)
  if (review.length && !detailed) notes.push({ text: review.join(', ') })
  if (here.length) notes.push({ text: `${listNames(here)} ${here.length === 1 ? 'is' : 'are'} here`, cls: 'live', dot: true })
  const devices = file.sync.devices || []
  if (syncing.length) {
    notes.push({ text: `Syncing with ${listNames(syncing)}`, cls: here.length ? '' : 'live' })
  } else if (devices.length && !here.length) {
    notes.push({ text: `Syncing with your computer ${devices.map((d) => `“${d.name}”`).join(' and ')}`, cls: 'live' })
  } else if (!here.length && (file.sync.relays || []).some((h) => h.online)) {
    notes.push({ text: 'Syncing through an always-on relay', cls: 'live' })
  } else if (!here.length) {
    if (file.syncMode === 'open' && !file.sync.active) notes.push({ text: 'Syncs only while open' })
    else if (file.sync.lastSyncedAt) {
      const who = file.sync.lastSyncedWith ? ` with ${file.sync.lastSyncedWith}` : file.sync.lastSyncedDevice ? ` with your computer “${file.sync.lastSyncedDevice}”` : ''
      notes.push({ text: `Synced${who} ${ago(file.sync.lastSyncedAt)}` })
    } else {
      notes.push({ text: file.role === 'owner' ? 'Only on this computer so far' : 'Not synced yet' })
    }
  }
  if (file.role === 'viewer') notes.push({ text: 'You can view this file' })
  if (file.role === 'commenter') notes.push({ text: 'You can view and comment on this file' })
  if (file.role === 'respondent') notes.push({ text: 'You can answer this form' })
  // In a team drive its server, not the owner, is the one that matters.
  if (file.drive?.in) {
    if (!file.drive.online) notes.push({ text: `${file.drive.hostName} is offline. Edits reach the drive when it’s back`, cls: detailed ? 'warn' : '' })
  } else if (file.role !== 'owner' && !file.sync.ownerOnline && file.owner?.name) {
    notes.push({ text: `${file.owner.name} (owner) is offline` })
  }
  if (file.sync.pending > 0 && file.sync.lastSyncedAt) {
    notes.push({ text: 'Some of your edits are only on this computer', cls: 'warn' })
  }
  if (detailed && file.kind !== 'file' && !here.length && !syncing.length && editorRole(file.role)) {
    const reach = file.drive?.in
      ? `through ${file.drive.hostName} when it’s online`
      : (file.sync.relays || []).length ? 'through the relay, even when nobody else is online' : 'when anyone with this file is online at the same time as you'
    notes.push({ text: `You can keep writing. Edits are saved here and reach the others ${reach}.` })
    if (file.sync.lastSyncedAt) notes.push({ text: 'Newer edits may exist on a computer that is offline right now.' })
  }
  return notes
}

// A note can carry one action ({ label, run }), shown as a link after it.
export function renderNotes (notes) {
  return notes.map((n) => el('span', { class: `note ${n.cls || ''}` }, n.text, n.dot ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null,
    n.action ? el('button', { type: 'button', class: 'link-button note-action', onclick: (e) => { e.stopPropagation(); n.action.run() } }, n.action.label) : null))
}

// What a folded margin shows instead of its notes: one dot for the note
// that matters most, with all of them in its tooltip. `urgent` marks it
// even without a warning note (conflicts or requests waiting).
export function marginMark (notes, { urgent = false } = {}) {
  const kind = urgent || notes.some((n) => n.cls === 'warn') ? 'warn' : notes.some((n) => n.cls === 'live') ? 'live' : ''
  const summary = notes.map((n) => n.text).join('\n')
  return el('span', { class: `margin-mark ${kind}`, title: summary, role: 'img', 'aria-label': summary })
}
