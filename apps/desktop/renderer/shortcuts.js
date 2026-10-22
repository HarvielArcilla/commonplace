// The keyboard shortcuts help (Ctrl+/ or ⌘/ anywhere). The list is written
// out here rather than gathered from the toolbars, so it can say which app
// each one is for; keep it in step when adding a shortcut.

import { el, dialog } from './ui.js'

const SECTIONS = [
  ['Everywhere', [
    ['Mod /', 'Show these shortcuts'],
    ['Mod Z', 'Undo your last change'],
    ['Mod Shift Z', 'Redo'],
    ['Mod Alt M', 'Comment on what’s selected']
  ]],
  ['commonDocs', [
    ['Mod B', 'Bold'],
    ['Mod I', 'Italic'],
    ['Mod U', 'Underline'],
    ['Mod E', 'Inline code (notes)'],
    ['Mod K', 'Link'],
    ['Mod F', 'Find and replace'],
    ['Mod Alt F', 'Footnote'],
    ['Mod Enter', 'Page break (paged documents)'],
    ['@', 'Insert a person, file or date']
  ]],
  ['commonSheets', [
    ['Enter or F2', 'Edit the cell'],
    ['Tab', 'Next cell (Shift Tab: previous)'],
    ['Delete', 'Clear the selected cells'],
    ['Space', 'Tick or untick a checkbox cell'],
    ['Mod A', 'Select the whole sheet'],
    ['Mod B / I / U', 'Bold, italic, underline']
  ]],
  ['commonSlides', [
    ['↑ ↓', 'Previous or next slide'],
    ['Arrows', 'Nudge what’s selected (Shift: further)'],
    ['Enter', 'Edit the selected text box'],
    ['Delete', 'Delete what’s selected'],
    ['→ or Space', 'While presenting: next (← back, Esc to stop)']
  ]],
  ['commonBoard', [
    ['V H S R O T A L P', 'Select, move around, sticky note, rectangle, ellipse, text, arrow, line, draw'],
    ['Space', 'Hold and drag to move around'],
    ['Mod D', 'Duplicate'],
    ['Mod C, Mod V', 'Copy and paste shapes'],
    ['Mod A', 'Select everything'],
    ['Delete', 'Delete what’s selected']
  ]],
  ['Comments', [
    ['Mod Enter', 'Post a comment'],
    ['@', 'Mention someone with access']
  ]]
]

const mac = () => document.body.classList.contains('mac')
const keys = (combo) => combo.split(' ').map((k) => (k === 'Mod' ? (mac() ? '⌘' : 'Ctrl') : k === 'Alt' && mac() ? '⌥' : k === 'Shift' && mac() ? '⇧' : k))

export function showShortcuts () {
  if (document.querySelector('dialog[open] .shortcuts')) return
  const body = el('div', { class: 'shortcuts' }, ...SECTIONS.map(([title, rows]) => el('section', {},
    el('h3', {}, title),
    el('dl', {}, ...rows.flatMap(([combo, what]) => [el('dt', {}, ...keys(combo).map((k) => el('kbd', {}, k))), el('dd', {}, what)])))))
  dialog({ title: 'Keyboard shortcuts', body, confirm: 'Done', cancel: null, wide: true })
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === '/' || e.key === '?')) { e.preventDefault(); showShortcuts() }
})
