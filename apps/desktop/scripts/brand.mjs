// Gives the Electron binary that runs Commonplace from source (npm start)
// our name and icon, so the Dock, menu bar, Cmd-Tab, taskbar and Task
// Manager say "Commonplace" instead of "Electron". Runs after npm install.
// Installers built with electron-builder are named properly already; this
// only touches node_modules/electron, and never fails the install.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = 'Commonplace'
const here = path.dirname(fileURLToPath(import.meta.url))
const icon = path.join(here, '..', 'build', 'icon.png')
const ico = path.join(here, '..', 'build', 'icon.ico')

try {
  const exe = createRequire(import.meta.url)('electron') // path to the binary
  if (process.platform === 'darwin') brandMac(exe)
  else if (process.platform === 'win32') await brandWindows(exe)
} catch (err) {
  console.log(`[commonplace] Couldn't rename the Electron binary (${err.message}). Commonplace works the same; only its name in the Dock or taskbar may show as Electron.`)
}

function brandMac (exe) {
  const appDir = path.resolve(exe, '..', '..', '..') // .../Electron.app
  const plist = path.join(appDir, 'Contents', 'Info.plist')
  const marker = path.join(appDir, 'Contents', '.commonplace')
  const stamp = String(fs.statSync(icon).size)
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) execFileSync('plutil', ['-replace', key, '-string', NAME, plist])
  // electron.icns from our icon, at every size macOS asks for.
  const set = fs.mkdtempSync(path.join(os.tmpdir(), 'commonplace-icon-')) + '/icon.iconset'
  fs.mkdirSync(set)
  for (const n of [16, 32, 128, 256, 512]) {
    execFileSync('sips', ['-z', String(n), String(n), icon, '--out', path.join(set, `icon_${n}x${n}.png`)], { stdio: 'ignore' })
    execFileSync('sips', ['-z', String(n * 2), String(n * 2), icon, '--out', path.join(set, `icon_${n}x${n}@2x.png`)], { stdio: 'ignore' })
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(appDir, 'Contents', 'Resources', 'electron.icns')])
  // Editing the bundle breaks its signature; sign it again for this computer.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appDir], { stdio: 'ignore' })
  fs.writeFileSync(marker, stamp)
  execFileSync('touch', [appDir]) // so Finder and the Dock notice the change
}

async function brandWindows (exe) {
  const marker = `${exe}.commonplace`
  const stamp = String(fs.statSync(ico).size)
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return
  const { rcedit } = await import('rcedit')
  await rcedit(exe, {
    icon: ico,
    'version-string': { FileDescription: NAME, ProductName: NAME, InternalName: NAME, OriginalFilename: `${NAME}.exe`, CompanyName: NAME }
  })
  fs.writeFileSync(marker, stamp)
}
