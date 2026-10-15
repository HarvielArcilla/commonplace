// commonSlides window: the slide strip, the slide being edited, speaker
// notes, presenting and printing. Slides are 960 x 540 units, drawn scaled
// to fit; boxes move and resize by dragging, and their text is edited in
// place. Everything edits the file's Y.Doc through @commonplace/slides/model.

import * as Y from 'yjs'
import {
  slideIds, readSlide, addSlide, addText, addShape, addImage, updateElement, deleteElement, restack,
  deleteSlide, moveSlide, duplicateSlide, theme, slideMap, LAYOUTS, WIDTH, HEIGHT, SLIDES, SLIDE_DATA, DECK
} from '@commonplace/slides/model'
import { createTextEditor } from '@commonplace/slides/editor'
import { $, el, toast, openMenu, cleanError } from './ui.js'
import { icons } from './icons.js'
import { state, cp } from './state.js'
import { toolButton, toolbarGroups, setToolbar, press, swatchMenu, showValue, TEXT_COLORS, FILL_COLORS } from './toolbar.js'

const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 36, 44, 54, 66, 80]
const BACKGROUNDS = [['White', '#ffffff'], ['Paper', '#fbfbf9'], ['Mist', '#eef1f6'], ['Sand', '#f3e6cf'], ['Sage', '#e3ece4'], ['Ink', '#1f2430'], ['Navy', '#1d2c4d'], ['Forest', '#1f3a2e']]
const FONTS = [['Arial', 'Arial, Helvetica, sans-serif'], ['Georgia', 'Georgia, serif'], ['Verdana', 'Verdana, sans-serif'], ['Times New Roman', '"Times New Roman", Times, serif'], ['Trebuchet MS', '"Trebuchet MS", sans-serif'], ['Courier New', '"Courier New", monospace']]
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

// ---- the view -------------------------------------------------------------------

export function mountSlides (o) {
  const v = {
    o,
    ydoc: o.ydoc,
    writable: true,
    slideId: slideIds(o.ydoc)[0],
    selected: null, // element id
    editing: null, // element id whose text is being edited
    boxes: new Map(), // element id -> { node, editor }
    thumbs: new Map(), // slide id -> { node, sig }
    undo: new Y.UndoManager([o.ydoc.getArray(SLIDES), o.ydoc.getMap(SLIDE_DATA), o.ydoc.getMap(DECK)], { trackedOrigins: new Set([null]) })
  }
  v.strip = el('div', { class: 'slide-strip', role: 'listbox', 'aria-label': 'Slides' })
  v.canvas = el('div', { class: 'slide-canvas' })
  v.stage = el('div', { class: 'slide-stage' }, v.canvas)
  v.notes = el('textarea', { class: 'slide-notes', placeholder: 'Speaker notes', 'aria-label': 'Speaker notes', spellcheck: 'true' })
  v.root = el('div', { class: 'slides-app' }, v.strip, el('div', { class: 'slide-main' }, v.stage, v.notes))
  $('#desk').replaceChildren(v.root)

  let frame = 0
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; render(v); o.refreshMargin() }) }
  const roots = [o.ydoc.getArray(SLIDES), o.ydoc.getMap(SLIDE_DATA), o.ydoc.getMap(DECK)]
  roots.forEach((r) => r.observeDeep(schedule))
  const fit = new ResizeObserver(() => fitStage(v))
  fit.observe(v.stage)
  const onAwareness = () => drawPeers(v)
  o.awareness.on('change', onAwareness)
  const onKey = (e) => keydown(v, e)
  document.addEventListener('keydown', onKey)
  wireNotes(v)
  wireStage(v)
  v.destroy = () => {
    cancelAnimationFrame(frame)
    roots.forEach((r) => r.unobserveDeep(schedule))
    fit.disconnect()
    o.awareness.off('change', onAwareness)
    document.removeEventListener('keydown', onKey)
    for (const b of v.boxes.values()) b.editor?.destroy()
    v.boxes.clear()
    v.undo.destroy()
  }
  renderToolbar(v)
  render(v)

  return {
    focus: () => {},
    setEditable (writable) {
      if (writable === v.writable) return
      v.writable = writable
      v.notes.readOnly = !writable
      for (const b of v.boxes.values()) b.editor?.setEditable(writable)
      render(v)
    },
    notes: () => [{ text: `${slideIds(v.ydoc).length} slide${slideIds(v.ydoc).length === 1 ? '' : 's'}` }],
    preview (update) {
      const ydoc = new Y.Doc()
      Y.applyUpdate(ydoc, update)
      v.root.hidden = true
      const list = el('div', { class: 'slides-preview' }, ...slideIds(ydoc).map((id) => scaled(renderSlide(ydoc, id), 0.5)))
      $('#desk').append(list)
      return { title: ydoc.getMap('meta').get('title') || '', close () { list.remove(); ydoc.destroy(); v.root.hidden = false } }
    },
    async exportPayload (format) {
      if (format !== 'pdf') return { payload: {} }
      // PDF: one page per slide, drawn the same way as when presenting.
      const pages = el('div', { class: 'slides-print' }, ...slideIds(v.ydoc).map((id) => el('div', { class: 'print-slide' }, scaled(renderSlide(v.ydoc, id), 1280 / WIDTH))))
      return {
        payload: {},
        print: () => { document.body.append(pages); document.body.classList.add('printing-slides'); return () => { pages.remove(); document.body.classList.remove('printing-slides') } }
      }
    },
    exportFormats: { pptx: 'PowerPoint (.pptx)', pdf: 'PDF' },
    exportHints: { pptx: 'Opens in PowerPoint, Keynote and Google Slides', pdf: 'One page per slide' },
    destroy: () => v.destroy()
  }
}

// ---- drawing ---------------------------------------------------------------------

function render (v) {
  const ids = slideIds(v.ydoc)
  if (!ids.includes(v.slideId)) { v.slideId = ids[0]; v.selected = null; v.editing = null }
  drawStrip(v, ids)
  drawStage(v)
  if (document.activeElement !== v.notes) v.notes.value = slideMap(v.ydoc, v.slideId)?.get('notes')?.toString() || ''
  syncToolbar(v)
  drawPeers(v)
}

// A slide drawn at `k` times its size.
function scaled (node, k) {
  node.style.transform = `scale(${k})`
  node.style.transformOrigin = '0 0'
  return el('div', { class: 'slide-scaled', style: `width:${WIDTH * k}px;height:${HEIGHT * k}px` }, node)
}

function drawStrip (v, ids) {
  const keep = new Set(ids)
  for (const [id, t] of v.thumbs) if (!keep.has(id)) { t.node.remove(); v.thumbs.delete(id) }
  ids.forEach((id, i) => {
    const s = readSlide(v.ydoc, id)
    const sig = JSON.stringify([s.bg, theme(v.ydoc), s.elements.map((e) => [e.id, e.x, e.y, e.w, e.h, e.z, e.fill, e.color, e.size, e.align, e.valign, e.bold, e.shape, e.src?.length, e.text ? e.text.toString() : ''])])
    let t = v.thumbs.get(id)
    if (!t) {
      const node = el('div', {
        class: 'slide-thumb',
        role: 'option',
        tabindex: '0',
        draggable: 'true',
        onclick: () => goTo(v, id),
        onkeydown: (e) => { if (e.key === 'Enter') goTo(v, id) },
        oncontextmenu: (e) => { e.preventDefault(); if (v.writable) slideMenu(v, e.currentTarget, id) },
        ondragstart: (e) => { e.dataTransfer.setData('application/x-commonplace-slide', id); e.dataTransfer.effectAllowed = 'move' },
        ondragover: (e) => { if (e.dataTransfer.types.includes('application/x-commonplace-slide')) { e.preventDefault(); node.classList.add('drop-over') } },
        ondragleave: () => node.classList.remove('drop-over'),
        ondrop: (e) => {
          node.classList.remove('drop-over')
          const from = e.dataTransfer.getData('application/x-commonplace-slide')
          if (from && from !== id && v.writable) moveSlide(v.ydoc, from, slideIds(v.ydoc).indexOf(id))
        }
      })
      t = { node, sig: null }
      v.thumbs.set(id, t)
    }
    if (t.sig !== sig) {
      t.sig = sig
      t.node.replaceChildren(el('span', { class: 'thumb-number' }, String(i + 1)), scaled(renderSlide(v.ydoc, id), 150 / WIDTH), el('span', { class: 'thumb-peers' }))
    } else {
      t.node.firstChild.textContent = String(i + 1)
    }
    t.node.setAttribute('aria-selected', String(id === v.slideId))
    t.node.setAttribute('aria-label', `Slide ${i + 1}`)
    if (v.strip.children[i] !== t.node) v.strip.insertBefore(t.node, v.strip.children[i] || null)
  })
  const add = v.strip.querySelector('.strip-add') || el('button', { type: 'button', class: 'btn btn-quiet strip-add', onclick: (e) => layoutMenu(v, e.currentTarget) }, '+ New slide')
  add.hidden = !v.writable
  v.strip.append(add)
}

// The slide being edited: one box per element, each kept across redraws so
// text editors (and the cursor in them) survive other people's changes.
function drawStage (v) {
  const s = readSlide(v.ydoc, v.slideId)
  if (!s) return
  const t = theme(v.ydoc)
  Object.assign(v.canvas.style, { background: s.bg, fontFamily: t.font, color: t.fg })
  v.canvas.dataset.slide = s.id
  const seen = new Set()
  for (const e of s.elements) {
    seen.add(e.id)
    let box = v.boxes.get(e.id)
    if (box && box.slide !== s.id) { box.editor?.destroy(); box.node.remove(); v.boxes.delete(e.id); box = null }
    if (!box) {
      box = { slide: s.id, node: el('div', { class: `slide-el slide-${e.type}`, 'data-id': e.id }), editor: null }
      if (e.type === 'image') box.node.append(el('img', { alt: e.alt || '', draggable: 'false' }))
      if (e.text) {
        const host = el('div', { class: 'slide-el-text' })
        box.node.append(host)
        box.editor = createTextEditor({
          element: host,
          fragment: e.text,
          editable: v.writable,
          placeholder: e.role === 'title' ? 'Click to add a title' : e.role === 'body' ? 'Click to add text' : e.type === 'shape' ? '' : 'Text',
          onUpdate: () => syncToolbar(v),
          onFocus: () => { v.editing = e.id; select(v, e.id, { keepEditing: true }) },
          onBlur: () => { if (v.editing === e.id) v.editing = null; syncToolbar(v) }
        })
      }
      v.canvas.append(box.node)
      v.boxes.set(e.id, box)
    }
    const n = box.node
    Object.assign(n.style, {
      left: `${e.x}px`,
      top: `${e.y}px`,
      width: `${e.w}px`,
      height: `${e.h}px`,
      zIndex: String(e.z || 0),
      fontSize: `${e.size || 20}px`,
      textAlign: e.align || 'left',
      fontWeight: e.bold ? '700' : '',
      color: e.color || '',
      background: e.type === 'shape' ? (e.fill || 'transparent') : '',
      borderColor: e.stroke || ''
    })
    n.dataset.valign = e.valign || 'top'
    n.dataset.shape = e.shape || ''
    n.classList.toggle('selected', v.selected === e.id)
    if (e.type === 'image') { const img = n.querySelector('img'); if (img.getAttribute('src') !== e.src) img.src = e.src }
    n.querySelectorAll('.handle').forEach((h) => h.remove())
    if (v.selected === e.id && v.writable) for (const h of HANDLES) n.append(el('span', { class: `handle handle-${h}`, 'data-handle': h }))
  }
  for (const [id, box] of v.boxes) if (!seen.has(id)) { box.editor?.destroy(); box.node.remove(); v.boxes.delete(id) }
  if (v.selected && !seen.has(v.selected)) v.selected = null
  fitStage(v)
}

function fitStage (v) {
  const room = v.stage.getBoundingClientRect()
  const k = Math.max(0.2, Math.min((room.width - 48) / WIDTH, (room.height - 32) / HEIGHT))
  v.scale = k
  v.canvas.style.transform = `scale(${k})`
  v.canvas.style.left = `${Math.max(24, (room.width - WIDTH * k) / 2)}px`
  v.canvas.style.top = `${Math.max(16, (room.height - HEIGHT * k) / 2)}px`
}

// A read-only slide (thumbnails, presenting, printing, history).
export function renderSlide (ydoc, slideId) {
  const s = readSlide(ydoc, slideId)
  const t = theme(ydoc)
  const node = el('div', { class: 'slide-static', style: `background:${s?.bg || '#fff'};font-family:${t.font};color:${t.fg}` })
  for (const e of s?.elements || []) {
    const box = el('div', {
      class: `slide-el slide-${e.type}`,
      'data-valign': e.valign || 'top',
      'data-shape': e.shape || '',
      style: `left:${e.x}px;top:${e.y}px;width:${e.w}px;height:${e.h}px;z-index:${e.z || 0};font-size:${e.size || 20}px;text-align:${e.align || 'left'};${e.bold ? 'font-weight:700;' : ''}${e.color ? `color:${e.color};` : ''}${e.type === 'shape' ? `background:${e.fill || 'transparent'};${e.stroke ? `border-color:${e.stroke};` : ''}` : ''}`
    })
    if (e.type === 'image') box.append(el('img', { src: e.src, alt: e.alt || '', draggable: 'false' }))
    if (e.text) box.append(el('div', { class: 'slide-el-text' }, el('div', { class: 'slide-text' }, ...fragmentToDom(e.text))))
    node.append(box)
  }
  return node
}

// Rich text from a fragment as DOM nodes (text is set as text, never HTML).
function fragmentToDom (frag) {
  const tags = { paragraph: 'p', bulletList: 'ul', orderedList: 'ol', listItem: 'li', hardBreak: 'br' }
  const walk = (node) => {
    if (node instanceof Y.XmlText) {
      return node.toDelta().map((d) => {
        if (typeof d.insert !== 'string') return null
        let out = document.createTextNode(d.insert)
        const a = d.attributes || {}
        const wrap = (tag, style) => { const w = document.createElement(tag); if (style) w.style.cssText = style; w.append(out); out = w }
        if (a.bold) wrap('strong')
        if (a.italic) wrap('em')
        if (a.underline) wrap('u')
        if (a.strike) wrap('s')
        if (a.textStyle) wrap('span', `${a.textStyle.color ? `color:${a.textStyle.color};` : ''}${a.textStyle.fontSize ? `font-size:${a.textStyle.fontSize};` : ''}`)
        return out
      }).filter(Boolean)
    }
    const tag = tags[node.nodeName]
    if (!tag) return node.toArray().flatMap(walk)
    const n = document.createElement(tag)
    for (const c of node.toArray().flatMap(walk)) n.append(c)
    if (tag === 'p' && !n.childNodes.length) n.append(document.createElement('br'))
    return [n]
  }
  return frag.toArray().flatMap(walk)
}

// Who is on which slide, and which box they've selected.
function drawPeers (v) {
  for (const t of v.thumbs.values()) t.node.querySelector('.thumb-peers')?.replaceChildren()
  for (const b of v.boxes.values()) { b.node.classList.remove('peer'); b.node.style.removeProperty('--peer'); b.node.removeAttribute('data-peer') }
  for (const [clientId, s] of v.o.awareness.getStates()) {
    if (clientId === v.ydoc.clientID || !s.slides || !s.user || s.user.userId === state.me?.userId) continue
    v.thumbs.get(s.slides.slide)?.node.querySelector('.thumb-peers')?.append(el('span', { class: 'thumb-peer', style: `--c:${s.user.color}`, title: s.user.name }))
    const box = s.slides.slide === v.slideId && s.slides.el && v.boxes.get(s.slides.el)
    if (box) { box.node.classList.add('peer'); box.node.style.setProperty('--peer', s.user.color); box.node.setAttribute('data-peer', s.user.name) }
  }
}

function announce (v) {
  v.o.awareness.setLocalStateField('slides', { slide: v.slideId, el: v.selected })
}

// ---- selecting, moving, resizing ----------------------------------------------------------

function goTo (v, id) {
  if (v.slideId === id) return
  v.slideId = id
  v.selected = null
  v.editing = null
  announce(v)
  render(v)
}

function select (v, id, { keepEditing = false } = {}) {
  if (!keepEditing && v.editing && v.editing !== id) { v.boxes.get(v.editing)?.editor?.commands.blur(); v.editing = null }
  if (v.selected === id) { syncToolbar(v); return }
  v.selected = id
  announce(v)
  drawStage(v)
  syncToolbar(v)
}

// Slide coordinates of a pointer event.
const toSlide = (v, e) => {
  const r = v.canvas.getBoundingClientRect()
  return { x: (e.clientX - r.left) / v.scale, y: (e.clientY - r.top) / v.scale }
}

function wireStage (v) {
  v.stage.addEventListener('pointerdown', (e) => {
    const node = e.target.closest('.slide-el')
    if (!node) { select(v, null); return }
    const id = node.dataset.id
    const handle = e.target.dataset.handle
    const editingThis = v.editing === id && e.target.closest('.slide-text')
    if (editingThis) return // placing the cursor in the text
    if (!v.writable) return
    // A box that's already selected: a click in its text starts editing.
    if (v.selected === id && !handle && e.target.closest('.slide-text') && e.detail < 2) {
      v.boxes.get(id)?.editor?.commands.focus()
      return
    }
    e.preventDefault()
    select(v, id)
    drag(v, e, id, handle || null)
  })
  v.stage.addEventListener('dblclick', (e) => {
    const node = e.target.closest('.slide-el')
    if (node && v.writable) v.boxes.get(node.dataset.id)?.editor?.commands.focus('end')
  })
}

// Moves (no handle) or resizes a box; the result is saved once, on release.
function drag (v, e, id, handle) {
  const s = readSlide(v.ydoc, v.slideId)
  const el0 = s.elements.find((x) => x.id === id)
  if (!el0) return
  const start = toSlide(v, e)
  const node = v.boxes.get(id).node
  const keepRatio = el0.type === 'image'
  let next = { x: el0.x, y: el0.y, w: el0.w, h: el0.h }
  const move = (ev) => {
    const p = toSlide(v, ev)
    const dx = p.x - start.x
    const dy = p.y - start.y
    if (!handle) {
      next = { ...next, x: Math.round(el0.x + dx), y: Math.round(el0.y + dy) }
    } else {
      let { x, y, w, h } = el0
      if (handle.includes('e')) w = el0.w + dx
      if (handle.includes('s')) h = el0.h + dy
      if (handle.includes('w')) { w = el0.w - dx; x = el0.x + dx }
      if (handle.includes('n')) { h = el0.h - dy; y = el0.y + dy }
      if (keepRatio && handle.length === 2) { const k = el0.h / el0.w; h = w * k; if (handle.includes('n')) y = el0.y + el0.h - h }
      next = { x: Math.round(x), y: Math.round(y), w: Math.round(Math.max(20, w)), h: Math.round(Math.max(20, h)) }
    }
    Object.assign(node.style, { left: `${next.x}px`, top: `${next.y}px`, width: `${next.w}px`, height: `${next.h}px` })
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (next.x !== el0.x || next.y !== el0.y || next.w !== el0.w || next.h !== el0.h) updateElement(v.ydoc, v.slideId, id, next)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

function keydown (v, e) {
  if (state.open?.view == null || $('#doc-view').hidden || document.querySelector('dialog[open]') || v.presenting) return
  const inText = e.target.closest?.('.slide-text, textarea, input, select')
  const mod = e.metaKey || e.ctrlKey
  if (inText) {
    if (e.key === 'Escape' && v.editing) { v.boxes.get(v.editing)?.editor?.commands.blur(); v.editing = null; e.preventDefault() }
    return
  }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? v.undo.redo() : v.undo.undo(); return }
  if (!v.selected) {
    const ids = slideIds(v.ydoc)
    const i = ids.indexOf(v.slideId)
    if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); goTo(v, ids[Math.min(ids.length - 1, i + 1)]) }
    if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); goTo(v, ids[Math.max(0, i - 1)]) }
    return
  }
  if (!v.writable) return
  const s = readSlide(v.ydoc, v.slideId).elements.find((x) => x.id === v.selected)
  if (!s) return
  const nudge = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key]
  if (nudge) {
    e.preventDefault()
    const step = e.shiftKey ? 10 : 1
    updateElement(v.ydoc, v.slideId, s.id, { x: s.x + nudge[0] * step, y: s.y + nudge[1] * step })
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault()
    deleteElement(v.ydoc, v.slideId, s.id)
  } else if (e.key === 'Escape') {
    select(v, null)
  } else if (e.key === 'Enter' && s.text) {
    e.preventDefault()
    v.boxes.get(s.id)?.editor?.commands.focus('end')
  }
}

// ---- notes ------------------------------------------------------------------------------

// Speaker notes are plain text: keep the Y.Text in step with the textarea by
// replacing only the part that changed.
function wireNotes (v) {
  v.notes.addEventListener('input', () => {
    const text = slideMap(v.ydoc, v.slideId)?.get('notes')
    if (!text) return
    const before = text.toString()
    const after = v.notes.value
    let start = 0
    while (start < before.length && start < after.length && before[start] === after[start]) start++
    let end = 0
    while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++
    v.ydoc.transact(() => {
      if (before.length - start - end > 0) text.delete(start, before.length - start - end)
      if (after.length - start - end > 0) text.insert(start, after.slice(start, after.length - end))
    })
  })
}

// ---- commands ---------------------------------------------------------------------------

function newSlide (v, layout) {
  const id = addSlide(v.ydoc, { layout, after: v.slideId, bg: readSlide(v.ydoc, v.slideId)?.bg })
  goTo(v, id)
}

function layoutMenu (v, anchor) {
  openMenu(anchor, Object.entries(LAYOUTS).map(([key, l]) => ({ label: l.name, onSelect: () => newSlide(v, key) })), { label: 'New slide' })
}

function slideMenu (v, anchor, id) {
  const ids = slideIds(v.ydoc)
  const i = ids.indexOf(id)
  openMenu(anchor, [
    { label: 'Duplicate slide', onSelect: () => goTo(v, duplicateSlide(v.ydoc, id)) },
    { label: 'Move up', disabled: i === 0, onSelect: () => moveSlide(v.ydoc, id, i - 1) },
    { label: 'Move down', disabled: i === ids.length - 1, onSelect: () => moveSlide(v.ydoc, id, i + 1) },
    { sep: true },
    { label: 'Delete slide', danger: true, disabled: ids.length <= 1, onSelect: () => deleteSlide(v.ydoc, id) }
  ], { label: `Slide ${i + 1}` })
}

function addAndSelect (v, id) {
  v.selected = id
  announce(v)
  render(v)
}

async function insertImage (v) {
  try {
    const img = await cp.pickImage()
    if (!img) return
    const size = await new Promise((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
      probe.onerror = () => resolve({ w: 400, h: 300 })
      probe.src = img.src
    })
    addAndSelect(v, addImage(v.ydoc, v.slideId, { src: img.src, alt: img.alt, ...size }))
  } catch (err) { toast(cleanError(err)) }
}

// Text formatting goes to the box being edited, or to the whole selected
// box (its base size, color and alignment) when none is.
const editorOf = (v) => (v.editing ? v.boxes.get(v.editing)?.editor : null)
const selectedEl = (v) => (v.selected ? readSlide(v.ydoc, v.slideId)?.elements.find((x) => x.id === v.selected) : null)

function textCommand (v, run, boxPatch) {
  const editor = editorOf(v)
  if (editor && run) { run(editor.chain().focus()).run(); return }
  const sel = selectedEl(v)
  if (sel && boxPatch) updateElement(v.ydoc, v.slideId, sel.id, boxPatch(sel))
}

function renderToolbar (v) {
  const tool = toolButton
  const size = el('select', {
    class: 'tool-select tool-size',
    'data-cmd': 'size',
    'aria-label': 'Text size',
    onchange: (e) => textCommand(v, (c) => c.setFontSize(`${e.target.value}px`), () => ({ size: Number(e.target.value) }))
  }, ...SIZES.map((n) => el('option', { value: String(n) }, String(n))))
  const font = el('select', {
    class: 'tool-select tool-font',
    'data-cmd': 'font',
    'aria-label': 'Font for the whole presentation',
    title: 'Font for the whole presentation',
    onchange: (e) => v.ydoc.getMap(DECK).set('font', e.target.value)
  }, ...FONTS.map(([label, value]) => el('option', { value }, label)))
  setToolbar([...toolbarGroups([
    [
      tool('newSlide', 'New slide', icons.plus, (b) => layoutMenu(v, b)),
      tool('text', 'Text box', el('span', { class: 'tool-text' }, 'T'), () => addAndSelect(v, addText(v.ydoc, v.slideId, {}))),
      tool('shape', 'Shape', icons.shape, (b) => openMenu(b, [
        { label: 'Rectangle', onSelect: () => addAndSelect(v, addShape(v.ydoc, v.slideId, { shape: 'rect' })) },
        { label: 'Rounded rectangle', onSelect: () => addAndSelect(v, addShape(v.ydoc, v.slideId, { shape: 'round' })) },
        { label: 'Ellipse', onSelect: () => addAndSelect(v, addShape(v.ydoc, v.slideId, { shape: 'ellipse' })) }
      ], { label: 'Shape' })),
      tool('image', 'Image', icons.image, () => insertImage(v))
    ],
    [
      font,
      size,
      tool('bold', 'Bold', el('b', {}, 'B'), () => textCommand(v, (c) => c.toggleBold(), (s) => ({ bold: !s.bold })), { key: 'Mod-B' }),
      tool('italic', 'Italic', el('i', {}, 'I'), () => textCommand(v, (c) => c.toggleItalic())),
      tool('underline', 'Underline', el('u', {}, 'U'), () => textCommand(v, (c) => c.toggleUnderline())),
      tool('color', 'Text color', icons.color, (b) => swatchMenu(b, 'Text color', TEXT_COLORS.concat([['White', '#ffffff']]), (c) => textCommand(v, (x) => x.setColor(c), () => ({ color: c })), () => textCommand(v, (x) => x.unsetColor(), () => ({ color: null })), 'Theme color'))
    ],
    [
      tool('alignLeft', 'Align left', icons.alignLeft, () => textCommand(v, null, () => ({ align: 'left' }))),
      tool('alignCenter', 'Center', icons.alignCenter, () => textCommand(v, null, () => ({ align: 'center' }))),
      tool('alignRight', 'Align right', icons.alignRight, () => textCommand(v, null, () => ({ align: 'right' }))),
      tool('bullets', 'Bulleted list', icons.bullets, () => textCommand(v, (c) => c.toggleBulletList()))
    ],
    [
      tool('fill', 'Shape color', icons.highlight, (b) => { const s = selectedEl(v); if (s?.type === 'shape') swatchMenu(b, 'Shape color', FILL_COLORS.concat([['Ink', '#1f2430'], ['Accent', '#284b8c']]), (c) => updateElement(v.ydoc, v.slideId, s.id, { fill: c }), () => updateElement(v.ydoc, v.slideId, s.id, { fill: null }), 'No fill'); else toast('Select a shape first.') }),
      tool('background', 'Slide background', icons.pageSetup, (b) => swatchMenu(b, 'Slide background', BACKGROUNDS, (c) => slideMap(v.ydoc, v.slideId)?.set('bg', c))),
      tool('front', 'Bring to front', icons.front, () => { const s = selectedEl(v); if (s) restack(v.ydoc, v.slideId, s.id, true) }),
      tool('back', 'Send to back', icons.back, () => { const s = selectedEl(v); if (s) restack(v.ydoc, v.slideId, s.id, false) })
    ],
    [
      tool('undo', 'Undo', icons.undo, () => { const e = editorOf(v); if (e) e.commands.undo?.(); else v.undo.undo() }, { key: 'Mod-Z' }),
      tool('redo', 'Redo', icons.redo, () => { const e = editorOf(v); if (e) e.commands.redo?.(); else v.undo.redo() }, { key: 'Mod-Shift-Z' })
    ]
  ]), el('span', { class: 'tool-spacer' }), el('button', { type: 'button', class: 'btn btn-primary tool-present', onclick: () => present(v) }, 'Present')])
  syncToolbar(v)
}

function syncToolbar (v) {
  const editor = editorOf(v)
  const s = selectedEl(v)
  press('bold', editor ? editor.isActive('bold') : s?.bold)
  press('italic', editor?.isActive('italic'))
  press('underline', editor?.isActive('underline'))
  press('bullets', editor?.isActive('bulletList'))
  for (const a of ['left', 'center', 'right']) press(`align${a[0].toUpperCase()}${a.slice(1)}`, s && (s.align || 'left') === a)
  const size = document.querySelector('[data-cmd="size"]')
  if (size && document.activeElement !== size) {
    const fromText = editor?.getAttributes('textStyle').fontSize
    const value = fromText ? String(parseFloat(fromText)) : String(s?.size || 20)
    showValue(size, value, value)
  }
  const font = document.querySelector('[data-cmd="font"]')
  if (font && document.activeElement !== font) showValue(font, theme(v.ydoc).font, FONTS.find(([, f]) => f === theme(v.ydoc).font)?.[0] || 'Font')
}

// ---- presenting -------------------------------------------------------------------------

function present (v) {
  const ids = slideIds(v.ydoc)
  let i = Math.max(0, ids.indexOf(v.slideId))
  const frame = el('div', { class: 'present-frame' })
  const counter = el('div', { class: 'present-counter', 'aria-live': 'polite' })
  const overlay = el('div', { class: 'present', role: 'dialog', 'aria-label': 'Presenting', tabindex: '0' }, frame, counter)
  const show = () => {
    const k = Math.min(window.innerWidth / WIDTH, window.innerHeight / HEIGHT)
    frame.replaceChildren(scaled(renderSlide(v.ydoc, ids[i]), k))
    counter.textContent = `${i + 1} / ${ids.length}`
  }
  const next = (d) => { i = Math.max(0, Math.min(ids.length - 1, i + d)); show() }
  const onKey = (e) => {
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) { e.preventDefault(); next(1) } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) { e.preventDefault(); next(-1) } else if (e.key === 'Home') { i = 0; show() } else if (e.key === 'End') { i = ids.length - 1; show() } else if (e.key === 'Escape') stop()
  }
  const stop = () => {
    v.presenting = false
    document.removeEventListener('keydown', onKey, true)
    window.removeEventListener('resize', show)
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    overlay.remove()
    goTo(v, ids[i])
  }
  overlay.addEventListener('click', (e) => next(e.clientX < window.innerWidth / 3 ? -1 : 1))
  document.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', show)
  document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && v.presenting) stop() }, { once: true })
  v.presenting = true
  document.body.append(overlay)
  overlay.requestFullscreen?.().catch(() => {})
  overlay.focus()
  show()
}
