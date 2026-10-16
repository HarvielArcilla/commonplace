// Toolbar pieces shared by every kind of file: buttons, separators, color
// swatch menus and selects that can show a value outside their list.

import { $, el, svg, openMenu, closeMenu } from './ui.js'
import { cp } from './state.js'

// A toolbar button. `key` is shown in the tooltip, written like 'Mod-Shift-Z'.
export function toolButton (id, label, icon, onClick, { key } = {}) {
  const mac = cp.platform === 'darwin'
  const shortcut = key ? ` (${key.replace('Mod', mac ? '⌘' : 'Ctrl').replace('Alt', mac ? '⌥' : 'Alt').replace('Shift', mac ? '⇧' : 'Shift').replace(/-/g, mac ? '' : '+')})` : ''
  return el('button', {
    type: 'button',
    class: 'tool',
    'data-cmd': id,
    title: label + shortcut,
    'aria-label': label,
    'aria-pressed': 'false',
    onmousedown: (e) => e.preventDefault(), // keep the selection where it is
    onclick: (e) => onClick(e.currentTarget)
  }, typeof icon === 'string' && icon.startsWith('<svg') ? svg(icon) : icon)
}

export const sep = () => el('span', { class: 'tool-sep', role: 'separator' })

// A toolbar button with a word next to its icon, for the main action.
export function labeledButton (id, label, icon, onClick) {
  return el('button', { type: 'button', class: 'tool tool-labeled', 'data-cmd': id, onmousedown: (e) => e.preventDefault(), onclick: (e) => onClick(e.currentTarget) }, svg(icon), el('span', {}, label))
}

// Lays out groups of controls with separators between them.
export function toolbarGroups (groups) {
  const out = []
  groups.filter((g) => g.length).forEach((g, i) => { if (i) out.push(sep()); out.push(...g) })
  return out
}

export const press = (id, on) => {
  const b = document.querySelector(`.tool[data-cmd="${id}"]`)
  if (b) b.setAttribute('aria-pressed', String(Boolean(on)))
}

export const TEXT_COLORS = [
  ['Ink', '#1f2430'], ['Slate', '#5c6270'], ['Blue', '#284b8c'], ['Green', '#2f6b4f'],
  ['Red', '#9b2c2c'], ['Rust', '#b4532a'], ['Ochre', '#a2741b'], ['Plum', '#6b3f8c']
]
export const FILL_COLORS = [
  ['Yellow', '#fff3a3'], ['Green', '#d4efd9'], ['Blue', '#d6e4fb'], ['Pink', '#f8d7e3'], ['Gray', '#e6e7ea'],
  ['Sand', '#f3e6cf'], ['Sky', '#cfe8f3'], ['Lilac', '#e6dcf3']
]

export function swatchMenu (anchor, label, colors, apply, clear, clearLabel) {
  const grid = el('div', { class: 'swatch-grid', role: 'group', 'aria-label': label },
    ...colors.map(([name, hex]) => el('button', { type: 'button', class: 'swatch-btn', title: name, 'aria-label': name, style: `--swatch:${hex}`, onclick: () => { closeMenu(); apply(hex) } })))
  openMenu(anchor, [{ custom: grid }, ...(clear ? [{ sep: true }, { label: clearLabel, onSelect: clear }] : [])], { label })
}

// Selects a value, adding a temporary option for values outside the list
// (a size like 15.5 pasted from elsewhere, a font from an imported file).
export function showValue (select, value, label) {
  select.querySelectorAll('option[data-extra]').forEach((x) => x.remove())
  if (![...select.options].some((x) => x.value === value)) {
    select.append(el('option', { value, 'data-extra': 'true', disabled: value === 'mixed' || null }, label))
  }
  select.value = value
}

// ---- one row, whatever the window width -------------------------------------
//
// The toolbar never wraps. When it doesn't fit, its last groups (the parts
// between separators) move into a "More" panel below a ⋯ button. They're
// the same controls, moved, so they keep working and stay in sync. Anything
// after a .tool-spacer (zoom, mode, Present) stays on the row as long as
// possible.

let items = []
let more = null
let panel = null
let observer = null

export function setToolbar (children) {
  const bar = $('#toolbar')
  items = children.filter(Boolean)
  if (!observer) {
    let frame = 0
    observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => fitToolbar()) })
    observer.observe(bar)
  }
  fitToolbar()
}

export function fitToolbar () {
  const bar = $('#toolbar')
  closeMore()
  panel?.replaceChildren()
  bar.replaceChildren(...items)
  if (bar.hidden || !items.length || !overflowing(bar)) return

  const spacer = items.findIndex((n) => n.classList?.contains('tool-spacer'))
  const main = spacer < 0 ? items : items.slice(0, spacer)
  const pinned = spacer < 0 ? [] : items.slice(spacer + 1)
  // Groups start at a separator (the separator leaves with its group).
  const groups = []
  for (const n of main) {
    if (!groups.length || n.classList?.contains('tool-sep')) groups.push([])
    groups[groups.length - 1].push(n)
  }
  more = more || el('button', { type: 'button', class: 'tool tool-more', title: 'More tools', 'aria-label': 'More tools', 'aria-expanded': 'false', onmousedown: (e) => e.preventDefault(), onclick: () => toggleMore() }, '\u22ef')
  bar.insertBefore(more, spacer < 0 ? null : items[spacer])

  const moved = []
  while (groups.length > 1 && overflowing(bar)) {
    const g = groups.pop()
    g.forEach((n) => n.remove())
    moved.unshift(g.filter((n) => !n.classList?.contains('tool-sep')))
  }
  for (let i = pinned.length - 1; i >= 0 && overflowing(bar); i--) {
    pinned[i].remove()
    moved.push([pinned[i]])
  }
  panel = panel || el('div', { class: 'toolbar-more', role: 'group', 'aria-label': 'More tools', hidden: true })
  if (!panel.isConnected) document.body.append(panel)
  panel.replaceChildren(...moved.map((g) => el('div', { class: 'toolbar-more-group' }, ...g)))
}

const overflowing = (bar) => bar.scrollWidth > bar.clientWidth + 1

function toggleMore () {
  if (!panel || !more) return
  if (!panel.hidden) { closeMore(); return }
  const r = more.getBoundingClientRect()
  panel.hidden = false
  panel.style.top = `${r.bottom + 6}px`
  panel.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - panel.offsetWidth - 8))}px`
  more.setAttribute('aria-expanded', 'true')
  setTimeout(() => document.addEventListener('mousedown', outside), 0)
  document.addEventListener('keydown', escape)
}

function closeMore () {
  if (!panel || panel.hidden) return
  panel.hidden = true
  more?.setAttribute('aria-expanded', 'false')
  document.removeEventListener('mousedown', outside)
  document.removeEventListener('keydown', escape)
}

// Menus opened from a button in the panel (colors, tables...) are outside
// it too, so clicks in them don't close the panel.
const outside = (e) => { if (!panel.contains(e.target) && e.target !== more && !e.target.closest?.('.menu')) closeMore() }
const escape = (e) => { if (e.key === 'Escape') closeMore() }
