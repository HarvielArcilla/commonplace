// Light, dark, or the system's theme. The window marks <html> with the one in
// use (data-theme="light" | "dark") and the styles key their dark colors to
// it, so the setting works the same on every platform. Code that draws its
// own colors (charts) asks isDark() and listens for 'commonplace:theme'.

const system = window.matchMedia('(prefers-color-scheme: dark)')
let chosen = 'system'

export const isDark = () => document.documentElement.dataset.theme === 'dark'

export function setTheme (theme) {
  chosen = ['light', 'dark'].includes(theme) ? theme : 'system'
  apply()
}

function apply () {
  const theme = chosen === 'system' ? (system.matches ? 'dark' : 'light') : chosen
  if (document.documentElement.dataset.theme === theme) return
  document.documentElement.dataset.theme = theme
  window.dispatchEvent(new Event('commonplace:theme'))
}

system.addEventListener('change', apply)
apply()
