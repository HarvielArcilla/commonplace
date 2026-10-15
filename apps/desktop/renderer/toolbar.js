// Toolbar pieces shared by every kind of file: buttons, separators, color
// swatch menus and selects that can show a value outside their list.

import { el, svg, openMenu, closeMenu } from './ui.js'
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
