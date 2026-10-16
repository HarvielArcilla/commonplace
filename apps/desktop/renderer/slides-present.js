// Presenting a deck: full screen on this computer, or presenter view, where
// the audience sees the slides in their own window (full screen on a second
// display when there is one) while this window shows the current and next
// slides, the speaker notes and a timer. Slides arrive with the transition
// each one asks for.

import { slideIds, readSlide, WIDTH, HEIGHT } from '@commonplace/slides/model'
import { el, toast } from './ui.js'
import { scaled, renderSlide } from './slide-render.js'

const NEXT_KEYS = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']
const BACK_KEYS = ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']

// v: the slides view. onEnd(slideId): where presenting stopped.
export function present (v, { presenter = false, onEnd }) {
  const ids = slideIds(v.ydoc)
  if (!ids.length) return
  let i = Math.max(0, ids.indexOf(v.slideId))
  let last = i
  const audience = presenter ? openAudience() : null
  if (presenter && !audience) toast('Couldn’t open a window for the audience, so presenting here.')
  const doc = audience?.document || document
  const frame = el('div', { class: 'present-frame' })
  const counter = el('div', { class: 'present-counter', 'aria-live': 'polite' })
  const stage = el('div', { class: 'present', role: 'dialog', 'aria-label': 'Presenting', tabindex: '0' }, frame, counter)
  const view = audience ? presenterView(v, ids, () => i, (d) => go(i + d), () => stop()) : null

  // The slide fills the audience's screen, arriving with its transition.
  const show = () => {
    const win = doc.defaultView
    const k = Math.min(win.innerWidth / WIDTH, win.innerHeight / HEIGHT)
    const slide = scaled(renderSlide(v.ydoc, ids[i]), k)
    const kind = readSlide(v.ydoc, ids[i])?.transition
    if (kind && kind !== 'none' && i !== last) {
      slide.classList.add(`enter-${kind}`)
      slide.style.setProperty('--dir', i > last ? '1' : '-1')
    }
    frame.replaceChildren(slide)
    counter.textContent = `${i + 1} / ${ids.length}`
    last = i
    view?.draw()
  }
  const go = (n) => { i = Math.max(0, Math.min(ids.length - 1, n)); show() }
  const onKey = (e) => {
    if (NEXT_KEYS.includes(e.key)) { e.preventDefault(); go(i + 1) } else if (BACK_KEYS.includes(e.key)) { e.preventDefault(); go(i - 1) } else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(ids.length - 1)
    else if (e.key === 'Escape') stop()
    else if (audience && e.key.toLowerCase() === 'f') { if (doc.fullscreenElement) doc.exitFullscreen().catch(() => {}); else stage.requestFullscreen?.().catch(() => {}) }
  }

  let stopped = false
  const watch = audience ? setInterval(() => { if (audience.closed) stop() }, 500) : 0
  const stop = () => {
    if (stopped) return
    stopped = true
    v.presenting = false
    clearInterval(watch)
    document.removeEventListener('keydown', onKey, true)
    doc.defaultView.removeEventListener('resize', show)
    if (audience) { audience.removeEventListener('keydown', onKey, true); if (!audience.closed) audience.close() }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    stage.remove()
    view?.remove()
    onEnd(ids[i])
  }
  stage.addEventListener('click', (e) => go(i + (e.clientX < doc.defaultView.innerWidth / 3 ? -1 : 1)))
  document.addEventListener('keydown', onKey, true)
  audience?.addEventListener('keydown', onKey, true)
  doc.defaultView.addEventListener('resize', show)
  if (!audience) document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && v.presenting) stop() }, { once: true })
  v.presenting = true
  doc.body.append(stage)
  if (view) document.body.append(view.node)
  if (!audience) stage.requestFullscreen?.().catch(() => {})
  stage.focus()
  show()
}

// A window for the audience. It shares this window's styles; the app puts it
// full screen on a second display when there is one.
function openAudience () {
  const win = window.open('', 'commonplace-audience')
  if (!win) return null
  const d = win.document
  d.title = 'commonplace: presenting'
  for (const n of document.querySelectorAll('link[rel="stylesheet"], style')) {
    const copy = n.cloneNode(true)
    if (copy.href) copy.href = n.href // resolved against this window
    d.head.append(copy)
  }
  d.body.classList.add('audience')
  return win
}

// This window while presenting to another: now, next, notes and a clock.
function presenterView (v, ids, current, step, end) {
  let restart = Date.now()
  let paused = 0
  let pausedAt = 0
  const now = el('div', { class: 'presenter-now' })
  const next = el('div', { class: 'presenter-next' })
  const notes = el('div', { class: 'presenter-notes', 'aria-live': 'polite' })
  const timer = el('span', { class: 'presenter-timer', role: 'timer' })
  const clock = el('span', { class: 'presenter-clock' })
  const count = el('span', { class: 'presenter-count' })
  const pause = el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { if (pausedAt) { paused += Date.now() - pausedAt; pausedAt = 0 } else pausedAt = Date.now(); tick() } }, 'Pause')
  const node = el('div', { class: 'presenter', role: 'dialog', 'aria-label': 'Presenter view' },
    el('header', { class: 'presenter-bar' },
      timer, pause,
      el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => { paused = 0; pausedAt = 0; restart = Date.now(); tick() } }, 'Restart'),
      clock,
      el('span', { class: 'spacer' }),
      count,
      el('button', { type: 'button', class: 'btn', onclick: () => step(-1), 'aria-label': 'Previous slide' }, '‹ Back'),
      el('button', { type: 'button', class: 'btn btn-primary', onclick: () => step(1), 'aria-label': 'Next slide' }, 'Next ›'),
      el('button', { type: 'button', class: 'btn', onclick: end }, 'End')),
    now,
    el('aside', { class: 'presenter-side' }, el('h2', {}, 'Next'), next, el('h2', {}, 'Notes'), notes))
  const two = (n) => String(n).padStart(2, '0')
  const tick = () => {
    const ms = (pausedAt || Date.now()) - restart - paused
    const s = Math.max(0, Math.floor(ms / 1000))
    timer.textContent = `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`
    pause.textContent = pausedAt ? 'Resume' : 'Pause'
    clock.textContent = new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  }
  const timerId = setInterval(tick, 1000)
  const fit = (host, id) => {
    if (!id) { host.replaceChildren(el('p', { class: 'presenter-end' }, 'End of the presentation')); return }
    const box = host.getBoundingClientRect()
    const k = Math.max(0.1, Math.min(box.width / WIDTH, box.height / HEIGHT))
    host.replaceChildren(scaled(renderSlide(v.ydoc, id), k))
  }
  const draw = () => {
    const i = current()
    fit(now, ids[i])
    fit(next, ids[i + 1])
    notes.textContent = readSlide(v.ydoc, ids[i])?.notes || 'No notes for this slide.'
    notes.classList.toggle('empty', !readSlide(v.ydoc, ids[i])?.notes)
    count.textContent = `Slide ${i + 1} of ${ids.length}`
    tick()
  }
  const onResize = () => draw()
  window.addEventListener('resize', onResize)
  return {
    node,
    draw: () => requestAnimationFrame(draw),
    remove () { clearInterval(timerId); window.removeEventListener('resize', onResize); node.remove() }
  }
}
