// An uploaded file: what it is, whether it's on this computer, and what you
// can do with it. Big files and kinds that can run programs wait for you to
// say yes; the latter are only ever saved, never opened from here.

import { $, el, toast, cleanError, ago, confirmAction } from './ui.js'
import { state, cp, formatBytes } from './state.js'
import { setToolbar } from './toolbar.js'

export function mountFile (o) {
  const v = { o, writable: true, shownFor: null }
  v.root = el('div', { class: 'file-app' })
  $('#desk').replaceChildren(v.root)
  setToolbar([])
  const draw = () => render(v)
  v.timer = setInterval(draw, 1000) // progress, while downloading
  draw()
  return {
    focus: () => v.root.querySelector('button')?.focus({ preventScroll: true }),
    setEditable (writable) { v.writable = writable; draw() },
    notes () {
      const st = file(v)?.upload
      return st && st.size != null ? [{ text: `${formatBytes(st.size)}${st.versions > 1 ? ` · ${st.versions} versions` : ''}` }] : []
    },
    preview () { return { title: '', close () {} } },
    async exportPayload () { return { payload: {} } },
    exportFormats: {},
    noToolbar: true,
    noHistory: true, // a new version replaces the file; there's no edit history
    destroy: () => clearInterval(v.timer)
  }
}

const file = (v) => state.files.find((f) => f.docId === v.o.docId)

const KIND_LABEL = { image: 'Image', video: 'Video', audio: 'Audio', pdf: 'PDF', text: 'Text', archive: 'Archive', document: 'Document', spreadsheet: 'Spreadsheet', presentation: 'Presentation', program: 'Can run code', other: 'File' }

function render (v) {
  const f = file(v)
  const st = f?.upload
  if (!st || st.waiting) {
    v.root.replaceChildren(el('div', { class: 'file-card' }, el('p', { class: 'file-wait' }, 'Waiting for the file’s details from someone who has it.')))
    return
  }
  const sig = JSON.stringify([st.ready, st.hold, Math.round(st.progress * 100), st.downloading, st.name, st.size, st.versions, v.writable])
  if (sig === v.sig) return
  v.sig = sig
  const pct = Math.round(st.progress * 100)
  const actions = []
  if (st.ready) {
    if (st.risky) actions.push(el('button', { type: 'button', class: 'btn btn-primary', onclick: () => run(() => cp.saveFileCopy(v.o.docId), (name) => name && toast(`Saved ${name}`)) }, 'Save a copy…'))
    else {
      actions.push(el('button', { type: 'button', class: 'btn btn-primary', onclick: () => run(() => cp.openFile(v.o.docId)) }, 'Open'))
      actions.push(el('button', { type: 'button', class: 'btn', onclick: () => run(() => cp.saveFileCopy(v.o.docId), (name) => name && toast(`Saved ${name}`)) }, 'Save a copy…'))
    }
    if (st.by !== state.me.userId) actions.push(el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => removeCopy(v, st) }, 'Remove from this computer'))
  } else if (st.hold) {
    actions.push(el('button', { type: 'button', class: 'btn btn-primary', disabled: st.hold === 'space' || null, onclick: () => run(() => cp.approveDownload(v.o.docId)) }, `Download (${formatBytes(st.size)})`))
  }
  if (v.writable) actions.push(el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => run(() => cp.uploadVersion(v.o.docId), (ok) => ok && toast('New version uploaded')) }, 'Upload a new version…'))

  const note = st.ready ? null : holdNote(st, pct)
  v.root.replaceChildren(el('div', { class: 'file-card' },
    el('div', { class: 'file-preview' }, previewNode(v, st, f)),
    el('div', { class: 'file-info' },
      el('h2', { class: 'file-name' }, st.name),
      el('p', { class: 'file-meta' }, `${KIND_LABEL[st.kind] || 'File'} · ${formatBytes(st.size)} · uploaded by ${st.by === state.me.userId ? 'you' : st.byName || 'someone'} ${ago(st.at)}`),
      st.risky ? el('p', { class: 'file-warn' }, 'Programs, scripts, web pages and files with macros can run code on your computer. Download one only if you trust the person who shared it; commonplace saves it but never opens it.') : null,
      note && st.hold !== 'risky' ? el('p', { class: st.hold === 'space' ? 'file-warn' : 'file-note' }, note) : null,
      !st.ready && st.downloading ? el('div', { class: 'file-progress', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('span', { style: `width:${pct}%` })) : null,
      el('div', { class: 'file-actions' }, ...actions))))
}

const HOLD_NOTES = {
  large: (st) => `This file is ${formatBytes(st.size)}, so it waits for you to say yes before it takes space on this computer.`,
  risky: () => 'This kind of file can run programs. Download it only if you trust the person who shared it. It will be saved, never opened from here.',
  space: () => 'There isn’t enough free space on this computer. commonplace keeps some free for everything else.',
  removed: () => 'You removed this computer’s copy.'
}

function holdNote (st, pct) {
  if (HOLD_NOTES[st.hold]) return HOLD_NOTES[st.hold](st)
  return st.downloading ? `Downloading… ${pct}%` : 'Waiting for someone who has it to be online.'
}

const PREVIEWS = {
  image: (p, st) => el('img', { src: p.src, alt: st.name }),
  video: (p) => el('video', { src: p.src, controls: true }),
  audio: (p) => el('audio', { src: p.src, controls: true }),
  text: (p) => el('pre', { class: 'file-text' }, p.text)
}

function previewNode (v, st, f) {
  const holder = el('div', { class: 'file-icon' }, el('span', {}, (st.ext || 'file').toUpperCase().slice(0, 5)))
  if (f.thumb?.image) holder.replaceChildren(el('img', { src: f.thumb.image, alt: '' }))
  if (st.ready && PREVIEWS[st.kind] && v.shownFor !== st.name + st.size) {
    v.shownFor = st.name + st.size
    cp.previewFile(v.o.docId).then((p) => {
      if (!p || !PREVIEWS[p.kind]) return
      v.previewEl = PREVIEWS[p.kind](p, st)
      v.root.querySelector('.file-preview')?.replaceChildren(v.previewEl)
    }).catch(() => {})
  }
  return v.previewEl && st.ready ? v.previewEl : holder
}

async function run (fn, after = () => {}) {
  try { after(await fn()) } catch (err) { toast(cleanError(err)) }
}

async function removeCopy (v, st) {
  const ok = await confirmAction({ title: 'Remove this computer’s copy?', body: `It frees ${formatBytes(st.size)}. The file stays in your Drive and you can download it again from anyone who has it.`, confirm: 'Remove copy', danger: false })
  if (ok) run(() => cp.removeDownloadedCopy(v.o.docId))
}
