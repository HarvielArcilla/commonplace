// Updates a commonplace installed from source, then starts it again. The app
// runs this (detached) and quits, so nothing is in use while files change.
//
//   node scripts/update.mjs <app pid> <log folder>

import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [pid, logDir] = process.argv.slice(2)
const win = process.platform === 'win32'
const log = fs.openSync(path.join(logDir, 'update.log'), 'w')
const say = (line) => fs.writeSync(log, `${new Date().toISOString()} ${line}\n`)

// Wait (up to a minute) for the app to finish quitting.
for (let i = 0; i < 600 && alive(Number(pid)); i++) await new Promise((resolve) => setTimeout(resolve, 100))

let ok = true
for (const [cmd, args] of [['git', ['pull', '--ff-only']], [win ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund']]]) {
  say(`$ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: ['ignore', log, log], shell: win, windowsHide: true })
  if (r.status !== 0) { ok = false; say(`failed (${r.error?.message || `exit ${r.status}`})`); break }
}
fs.writeFileSync(path.join(logDir, 'update-result.json'), JSON.stringify({ ok, at: Date.now(), log: path.join(logDir, 'update.log') }))

// Start commonplace again, the same way the Desktop launcher does.
const start = win
  ? spawn('cmd.exe', ['/c', path.join(root, 'scripts', 'start.cmd')], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true })
  : spawn('bash', [path.join(root, 'scripts', 'start.sh')], { cwd: root, detached: true, stdio: ['ignore', log, log] })
start.unref()

function alive (p) {
  try { process.kill(p, 0); return true } catch { return false }
}
