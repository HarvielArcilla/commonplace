// Storage, the people whose files take space here, blocking, and this
// computer's limits (Settings → Limits and safety). The limits screen is
// drawn from the policy's own list of fields, so a new limit added in
// drive/policy.js shows up here by itself.

import { $, el, toast, confirmAction, cleanError } from './ui.js'
import { cp, state, formatBytes } from './state.js'

const MB = 1024 * 1024
const GB = 1024 * MB

// ---- storage -------------------------------------------------------------------

export async function renderStorage () {
  const u = await cp.storageUsage()
  $('#storage-summary').textContent = `commonplace uses ${formatBytes(u.docs + u.uploads)} here (${formatBytes(u.uploads)} of it uploaded files). ${u.free != null ? `${formatBytes(u.free)} free on this disk.` : ''}`
  const top = u.files.filter((f) => f.bytes > 0).slice(0, 6)
  $('#storage-list').replaceChildren(...top.map((f) => el('li', { class: 'person' },
    el('span', { class: 'person-name' }, f.title || 'Untitled', el('span', { class: 'person-note' }, `${formatBytes(f.bytes)}${f.held ? ' · paused' : ''}`)),
    storageAction(f))))

  const people = u.people.filter((p) => !u.blocked.some((b) => b.userId === p.userId)).slice(0, 5)
  $('#storage-people-title').hidden = !people.length
  $('#storage-people').replaceChildren(...people.map((p) => el('li', { class: 'person' },
    el('span', { class: 'person-name' }, p.name, el('span', { class: 'person-note' }, `${formatBytes(p.bytes)} in ${p.files} file${p.files === 1 ? '' : 's'}`)),
    el('button', { type: 'button', class: 'btn btn-quiet btn-danger', onclick: () => block(p) }, 'Block'))))

  $('#storage-blocked-title').hidden = $('#storage-blocked-note').hidden = !u.blocked.length
  $('#storage-blocked').replaceChildren(...u.blocked.map((b) => el('li', { class: 'person' },
    el('span', { class: 'person-name' }, b.name, el('span', { class: 'person-note' }, `Blocked ${new Date(b.at).toLocaleDateString()}`)),
    el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => { await cp.unblockPerson(b.userId); toast(`Unblocked ${b.name}`); renderStorage() } }, 'Unblock'))))
}

function storageAction (f) {
  if (f.held && f.heldReason !== 'blocked') return el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => { try { await cp.keepSyncing(f.docId) } catch (err) { toast(cleanError(err)) } renderStorage() } }, 'Keep syncing')
  if (!f.contentBytes || f.mine) return null
  return el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => { await cp.removeDownloadedCopy(f.docId); toast(`Freed ${formatBytes(f.contentBytes)}`); renderStorage() } }, 'Remove copy')
}

async function block (p) {
  const ok = await confirmAction({
    title: `Block ${p.name}?`,
    body: 'Their files pause on this computer, their uploads never download, and it stops exchanging anything with them. Files they edit that others own keep their changes, because those arrive through everyone else. You can unblock them here later.',
    confirm: 'Block'
  })
  if (!ok) return
  try { await cp.blockPerson(p.userId, p.name); toast(`Blocked ${p.name}`) } catch (err) { toast(cleanError(err)) }
  renderStorage()
}

// ---- this computer as a relay ------------------------------------------------------

export async function renderLocalRelay (r = null) {
  r = r || await cp.getLocalRelay()
  $('#local-relay-on').checked = r.on
  const info = $('#local-relay-info')
  info.hidden = !r.on
  if (!r.on) return
  const quota = el('input', { type: 'number', class: 'limit-number', min: String(r.limits.min), max: String(r.limits.max), step: '1', value: String(r.quotaGB), 'aria-label': 'Most it keeps, in GB' })
  quota.addEventListener('change', async () => { await cp.setLocalRelay({ quotaGB: Number(quota.value) }); toast('Saved') })
  info.replaceChildren(
    el('p', { class: 'local-relay-address' }, el('code', { class: 'relay-key', title: r.address }, `${r.address.slice(0, 24)}…`),
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: async () => { await cp.copyText(r.address); toast('Address copied. Anyone you share files with can add it.') } }, 'Copy address')),
    el('p', { class: 'fineprint-plain' }, `Keeping ${formatBytes(r.usedBytes)} for ${r.boxes} file${r.boxes === 1 ? '' : 's'}, with ${r.connections} computer${r.connections === 1 ? '' : 's'} connected.`),
    el('label', { class: 'limit-label' }, 'Keep at most', el('span', { class: 'limit-amount' }, quota, ' GB')))
}

$('#local-relay-on').addEventListener('change', async (e) => {
  const on = e.target.checked
  e.target.disabled = true
  try {
    const r = await cp.setLocalRelay({ on, useForMine: on })
    toast(on ? 'This computer is now a relay. Your new files use it.' : 'This computer stopped being a relay.')
    renderLocalRelay(r)
    window.dispatchEvent(new Event('commonplace:relays'))
  } catch (err) { toast(cleanError(err)); e.target.checked = !on }
  e.target.disabled = false
})

cp.onLocalRelay((r) => { if (!$('#profile-relays').hidden) renderLocalRelay(r) })

// ---- network -----------------------------------------------------------------------

export async function renderNetwork () {
  const n = await cp.getNetwork()
  $('#network-summary').textContent = [
    `Connected to ${n.connections} computer${n.connections === 1 ? '' : 's'} right now.`,
    n.remembered ? `Remembers ${n.remembered} computer${n.remembered === 1 ? '' : 's'} on the network to start from next time.` : null,
    n.overridden ? 'This copy was started with its own bootstrap list (COMMONPLACE_BOOTSTRAP), which overrides these settings.' : null
  ].filter(Boolean).join(' ')
  $('#network-bootstrap').value = n.bootstrap.join('\n')
  $('#network-public').checked = n.publicBootstrap
}

$('#network-save').addEventListener('click', async () => {
  try {
    await cp.setNetwork({ bootstrap: $('#network-bootstrap').value, publicBootstrap: $('#network-public').checked })
    toast('Saved. It applies the next time commonplace starts.')
  } catch (err) { toast(cleanError(err)) }
  renderNetwork()
})

$('#network-forget').addEventListener('click', async () => {
  await cp.forgetNetworkNodes()
  toast('Forgotten')
  renderNetwork()
})

// ---- limits ------------------------------------------------------------------------

export async function renderLimits () {
  const p = await cp.getPolicy()
  state.trashDays = p.values.trashDays
  const form = $('#limits-form')
  const groups = Object.entries(p.groups).map(([group, title]) => {
    const fields = Object.entries(p.fields).filter(([, f]) => f.group === group)
    return el('fieldset', { class: 'limits-group', id: `limits-${group}` },
      el('legend', {}, title),
      ...fields.map(([key, f]) => fieldRow(key, f, p.values[key], p.defaults[key])))
  })
  form.replaceChildren(...groups)
}

function fieldRow (key, f, value, fallback) {
  const save = async (v) => {
    try {
      const next = await cp.setPolicy({ [key]: v })
      toast(next.values[key] !== v ? `Kept within ${describe(f, f.min)} to ${describe(f, f.max)}` : 'Saved')
      renderLimits()
    } catch (err) { toast(cleanError(err)) }
  }
  const hint = [f.hint, value !== fallback ? `Default: ${describe(f, fallback)}.` : null].filter(Boolean).join(' ')
  if (f.kind === 'bool') {
    return el('div', { class: 'limit' },
      el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: value || null, onchange: (e) => save(e.target.checked) }), f.label),
      hint ? el('p', { class: 'limit-hint' }, hint) : null)
  }
  if (f.kind === 'count') {
    return el('div', { class: 'limit' },
      el('label', { class: 'limit-label' }, f.label,
        el('input', { type: 'number', class: 'limit-number', min: String(f.min), max: String(f.max), step: '1', value: String(value), onchange: (e) => save(Number(e.target.value)) })),
      hint ? el('p', { class: 'limit-hint' }, hint) : null)
  }
  // Bytes: a number and a unit.
  const unit = value >= GB && value % GB === 0 ? GB : MB
  const number = el('input', { type: 'number', class: 'limit-number', min: '0', step: 'any', value: String(+(value / unit).toFixed(2)), 'aria-label': `${f.label} (amount)` })
  const units = el('select', { class: 'limit-unit', 'aria-label': `${f.label} (unit)` },
    el('option', { value: String(MB), selected: unit === MB || null }, 'MB'),
    el('option', { value: String(GB), selected: unit === GB || null }, 'GB'))
  const commit = () => save(Math.round(Number(number.value) * Number(units.value)))
  number.addEventListener('change', commit)
  units.addEventListener('change', commit)
  return el('div', { class: 'limit' },
    el('label', { class: 'limit-label' }, f.label, el('span', { class: 'limit-amount' }, number, units)),
    hint ? el('p', { class: 'limit-hint' }, hint) : null)
}

const describe = (f, v) => (f.kind === 'bool' ? (v ? 'on' : 'off') : f.kind === 'count' ? String(v) : formatBytes(v))

$('#limits-reset').addEventListener('click', async () => {
  if (!await confirmAction({ title: 'Restore the default limits?', body: 'Your blocked people stay blocked.', confirm: 'Restore', danger: false })) return
  await cp.resetPolicy()
  toast('Restored the defaults')
  renderLimits()
})
