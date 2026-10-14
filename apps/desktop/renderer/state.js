// Shared window state and the sync-status vocabulary used everywhere.

import { el, ago, listNames } from './ui.js'

export const cp = window.commonplace

const PREFS_KEY = 'commonplace.drive.prefs'
const DEFAULT_PREFS = { mode: 'list', filter: 'all', type: 'all', sort: 'recent' }

function loadPrefs () {
  try { return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') } } catch { return { ...DEFAULT_PREFS } }
}

export function savePrefs () {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(state.prefs)) } catch {}
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
export function statusNotes (file, { detailed = false } = {}) {
  const notes = []
  const isMe = (p) => p.userId === state.me?.userId
  const here = (file.sync.here || []).filter((p) => !isMe(p))
  const syncing = file.sync.peers.filter((p) => !isMe(p) && !here.some((h) => h.userId === p.userId))
  if (file.access?.removed) {
    notes.push({ text: 'You no longer have access. This copy stays as it was.', cls: 'warn' })
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
  if (!file.supported) {
    notes.push({ text: 'Made with a newer version of Commonplace', cls: 'warn' })
    return notes
  }
  if (here.length) notes.push({ text: `${listNames(here)} ${here.length === 1 ? 'is' : 'are'} here`, cls: 'live', dot: true })
  if (syncing.length) {
    notes.push({ text: `Syncing with ${listNames(syncing)}`, cls: here.length ? '' : 'live' })
  } else if (!here.length) {
    if (file.syncMode === 'open' && !file.sync.active) notes.push({ text: 'Syncs only while open' })
    else if (file.sync.lastSyncedAt) {
      const who = file.sync.lastSyncedWith ? ` with ${file.sync.lastSyncedWith}` : ''
      notes.push({ text: `Synced${who} ${ago(file.sync.lastSyncedAt)}` })
    } else {
      notes.push({ text: file.role === 'owner' ? 'Only on this computer so far' : 'Not synced yet' })
    }
  }
  if (file.role === 'viewer') notes.push({ text: 'You can view this file' })
  if (file.role !== 'owner' && !file.sync.ownerOnline && file.owner?.name) {
    notes.push({ text: `${file.owner.name} (owner) is offline` })
  }
  if (file.sync.pending > 0 && file.sync.lastSyncedAt) {
    notes.push({ text: 'Some of your edits are only on this computer', cls: 'warn' })
  }
  if (detailed && !here.length && !syncing.length && file.role !== 'viewer') {
    notes.push({ text: 'You can keep writing. Edits are saved here and reach the others when anyone with this file is online at the same time as you.' })
    if (file.sync.lastSyncedAt) notes.push({ text: 'Newer edits may exist on a computer that is offline right now.' })
  }
  return notes
}

export function renderNotes (notes) {
  return notes.map((n) => el('span', { class: `note ${n.cls || ''}` }, n.text, n.dot ? el('span', { class: 'dot', 'aria-hidden': 'true' }) : null))
}
