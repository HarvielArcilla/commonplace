// Small UI toolkit shared by the Drive and document views: element builder,
// popover menus, dialogs and toasts. No framework; everything is plain DOM.

export const $ = (sel, root = document) => root.querySelector(sel)

export function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'style') node.style.cssText = v
    else if (k === 'html') node.innerHTML = v
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c)
  return node
}

export function svg (markup) {
  const span = document.createElement('span')
  span.className = 'icon'
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = markup
  return span
}

export function ago (ts) {
  if (!ts) return ''
  const s = Math.round((Date.now() - ts) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  if (d < 7) return `${d} day${d === 1 ? '' : 's'} ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: d > 300 ? 'numeric' : undefined })
}

export function listNames (people) {
  const names = people.map((p) => p.name)
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

export function plural (n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export function cleanError (err) {
  return String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

let toastTimer
// action: { label, run } for a button in the toast (Undo, say). The toast
// is a popover, so it shows above any open dialog too.
export function toast (msg, action = null) {
  const t = $('#toast')
  const hide = () => { try { t.hidePopover() } catch {} }
  t.replaceChildren(msg)
  if (action) t.append(el('button', { type: 'button', class: 'toast-action', onclick: () => { hide(); action.run() } }, action.label))
  hide() // and show again, on top of whatever opened since
  try { t.showPopover() } catch {}
  clearTimeout(toastTimer)
  toastTimer = setTimeout(hide, action ? 6000 : 2800)
}

// ---- popover menus --------------------------------------------------------
// items: [{ label, hint, icon, onSelect, danger, disabled, checked } | { sep: true } | { heading }]

let openMenuState = null

export function closeMenu () {
  if (!openMenuState) return
  const { menu, anchor, cleanup } = openMenuState
  openMenuState = null
  cleanup()
  menu.remove()
  anchor?.setAttribute('aria-expanded', 'false')
}

export function openMenu (anchor, items, { align = 'start', label } = {}) {
  if (openMenuState?.anchor === anchor) { closeMenu(); return }
  closeMenu()
  const menu = el('div', { class: 'menu', role: 'menu', 'aria-label': label || anchor.getAttribute('aria-label') || anchor.textContent })
  const buttons = []
  for (const item of items) {
    if (!item) continue
    if (item.sep) { menu.append(el('div', { class: 'menu-sep', role: 'separator' })); continue }
    if (item.heading) { menu.append(el('div', { class: 'menu-heading' }, item.heading)); continue }
    if (item.custom) { menu.append(item.custom); continue }
    const b = el('button', {
      type: 'button',
      class: `menu-item${item.danger ? ' danger' : ''}`,
      role: item.checked != null ? 'menuitemradio' : 'menuitem',
      'aria-checked': item.checked != null ? String(Boolean(item.checked)) : null,
      disabled: item.disabled || null,
      onclick: () => { closeMenu(); item.onSelect?.() }
    },
    item.icon ? svg(item.icon) : null,
    el('span', { class: 'menu-text' }, el('span', { class: 'menu-label' }, item.label), item.hint ? el('span', { class: 'menu-hint' }, item.hint) : null))
    buttons.push(b)
    menu.append(b)
  }
  // Inside an open dialog the rest of the page is inert, so the menu goes in
  // the dialog.
  ;(anchor.closest('dialog[open]') || document.body).append(menu)
  const r = anchor.getBoundingClientRect()
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let left = align === 'end' ? r.right - mw : r.left
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8))
  let top = r.bottom + 6
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 6)
  menu.style.left = `${left}px`
  menu.style.top = `${top}px`
  anchor.setAttribute('aria-expanded', 'true')

  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) closeMenu() }
  const onKey = (e) => {
    const i = buttons.indexOf(document.activeElement)
    if (e.key === 'Escape') { e.preventDefault(); closeMenu(); anchor.focus() } else if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length]?.focus() } else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length]?.focus() }
  }
  setTimeout(() => document.addEventListener('mousedown', onDown), 0)
  document.addEventListener('keydown', onKey)
  window.addEventListener('blur', closeMenu)
  openMenuState = {
    menu,
    anchor,
    cleanup: () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('blur', closeMenu)
    }
  }
  buttons.find((b) => !b.disabled)?.focus({ preventScroll: true })
  return menu
}

// ---- dialogs ----------------------------------------------------------------
// Each returns a promise that resolves when the dialog closes.

// required: Escape doesn't close it (for something that must be read).
export function dialog ({ title, body, fields = [], confirm = 'Save', cancel = 'Cancel', danger = false, extraActions = [], validate, wide = false, required = false }) {
  return new Promise((resolve) => {
    const error = el('p', { class: 'error', role: 'alert' })
    const form = el('form', { method: 'dialog', novalidate: true },
      el('h2', {}, title),
      body ? (typeof body === 'string' ? el('p', {}, body) : body) : null,
      ...fields,
      error,
      el('div', { class: 'dialog-actions' },
        ...extraActions.map((a) => el('button', { type: 'button', class: `btn btn-quiet${a.danger ? ' btn-danger' : ''}`, onclick: () => { result = { action: a.value }; d.close() } }, a.label)),
        el('span', { class: 'spacer' }),
        cancel ? el('button', { type: 'button', class: 'btn btn-quiet', onclick: () => d.close() }, cancel) : null,
        el('button', { type: 'submit', class: `btn ${danger ? 'btn-danger-solid' : 'btn-primary'}` }, confirm)))
    const d = el('dialog', { class: `dialog${wide ? ' dialog-wide' : ''}` }, form)
    let result = null
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const data = Object.fromEntries(new FormData(form))
      for (const box of form.querySelectorAll('input[type=checkbox][name]')) data[box.name] = box.checked
      const problem = validate?.(data)
      if (problem) { error.textContent = problem; return }
      result = { action: 'confirm', data }
      d.close()
    })
    form.addEventListener('input', () => { error.textContent = '' })
    if (required) d.addEventListener('cancel', (e) => e.preventDefault())
    d.addEventListener('close', () => {
      if (required && !result) { d.showModal(); return } // the browser may let Escape through anyway
      d.remove()
      resolve(result)
    })
    document.body.append(d)
    d.showModal()
    form.querySelector('input:not([type=hidden]):not([type=radio]), textarea, select')?.focus()
  })
}

export async function promptText ({ title, label, value = '', confirm = 'Save', body, placeholder }) {
  const input = el('input', { name: 'value', value, placeholder, maxlength: '200', autocomplete: 'off', spellcheck: 'false' })
  const res = await dialog({
    title,
    body,
    confirm,
    fields: [el('label', { class: 'field' }, label, input)],
    validate: (d) => (d.value.trim() ? null : `Enter a ${label.toLowerCase()} first.`)
  })
  if (res?.action !== 'confirm') return null
  return res.data.value.trim()
}

export async function confirmAction ({ title, body, confirm, danger = true }) {
  const res = await dialog({ title, body, confirm, danger })
  return res?.action === 'confirm'
}

export function selectField ({ label, name, options, value }) {
  return el('label', { class: 'field' }, label,
    el('select', { name }, ...options.map((o) => el('option', { value: o.value, selected: o.value === value || null }, o.label))))
}
