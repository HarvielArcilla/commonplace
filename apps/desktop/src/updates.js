// Tells people when a newer version of commonplace is on GitHub, and, for
// copies installed from source (the install scripts), updates them.
//
// The only thing sent is an ordinary request to GitHub's public API for the
// project's commits. Nothing about you or your files goes with it. Set
// COMMONPLACE_NO_UPDATE_CHECK=1 to turn it off.

import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'

const REPO = 'HarvielArcilla/commonplace'
const EVERY_MS = 6 * 3600e3

export class Updates {
  // root: the folder of the git checkout (or of the app, when packaged).
  constructor ({ root, version, packaged, logDir, onChange }) {
    this.root = root
    this.version = version
    this.packaged = packaged
    this.logDir = logDir
    this.onChange = onChange
    this.state = { available: false, behind: 0, changes: [], canInstall: false, installing: false, url: `https://github.com/${REPO}` }
    this.lastResult = readResult(logDir)
  }

  start () {
    if (process.env.COMMONPLACE_NO_UPDATE_CHECK === '1') return
    setTimeout(() => this.check(), 8000).unref?.()
    setInterval(() => this.check(), EVERY_MS).unref?.()
  }

  // What the last automatic update reported, once (it ran after we quit).
  takeLastResult () {
    const r = this.lastResult
    this.lastResult = null
    return r
  }

  async check () {
    try {
      const head = gitHead(this.root)
      this.state = head ? await this.checkSource(head) : await this.checkRelease()
    } catch {
      return // offline, or GitHub is busy: try again later
    }
    this.onChange(this.state)
  }

  // Installed from source: how many commits is this checkout behind?
  async checkSource ({ sha, branch }) {
    const cmp = await github(`compare/${sha}...${encodeURIComponent(branch)}`)
    const behind = cmp.status === 'behind' ? cmp.behind_by : 0
    const changes = (cmp.commits || []).slice(-5).reverse().map((c) => String(c.commit?.message || '').split('\n')[0]).filter(Boolean)
    // Updating in place needs git and no changes of your own in the folder.
    const clean = behind > 0 && await new Promise((resolve) => {
      execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: this.root, windowsHide: true }, (err, out) => resolve(!err && !out.trim()))
    })
    return { available: behind > 0, behind, changes, canInstall: clean, installing: false, url: `https://github.com/${REPO}/commits/${branch}` }
  }

  // An installer build: is there a newer release?
  async checkRelease () {
    const rel = await github('releases/latest')
    const latest = String(rel.tag_name || '').replace(/^v/, '')
    const available = Boolean(latest) && newer(latest, this.version)
    return { available, behind: 0, changes: available ? [rel.name || `Version ${latest}`] : [], canInstall: false, installing: false, url: rel.html_url || `https://github.com/${REPO}/releases` }
  }

  // Quits, pulls the new version, installs what it needs and starts again.
  // Runs in a separate process so nothing is in use while it updates; what
  // it did is in update.log, and the app reports a failure next time.
  install (quit) {
    if (!this.state.canInstall || this.state.installing) return
    this.state = { ...this.state, installing: true }
    this.onChange(this.state)
    fs.mkdirSync(this.logDir, { recursive: true })
    const node = process.env.npm_node_execpath || 'node'
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(node, [path.join(this.root, 'scripts', 'update.mjs'), String(process.pid), this.logDir], {
      cwd: this.root,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env
    })
    child.unref()
    setTimeout(quit, 300)
  }
}

function github (endpoint) {
  return fetch(`https://api.github.com/repos/${REPO}/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'commonplace' },
    signal: AbortSignal.timeout(10000)
  }).then((r) => {
    if (!r.ok) throw new Error(`GitHub said ${r.status}`)
    return r.json()
  })
}

// The checked-out commit, read straight from .git (no git needed).
export function gitHead (root) {
  const dir = path.join(root, '.git')
  let head
  try { head = fs.readFileSync(path.join(dir, 'HEAD'), 'utf8').trim() } catch { return null }
  const ref = /^ref: (refs\/heads\/(.+))$/.exec(head)
  if (!ref) return /^[0-9a-f]{40}$/.test(head) ? { sha: head, branch: 'main' } : null
  try { return { sha: fs.readFileSync(path.join(dir, ref[1]), 'utf8').trim(), branch: ref[2] } } catch {}
  try {
    const line = fs.readFileSync(path.join(dir, 'packed-refs'), 'utf8').split('\n').find((l) => l.endsWith(` ${ref[1]}`))
    return line ? { sha: line.split(' ')[0], branch: ref[2] } : null
  } catch { return null }
}

function newer (a, b) {
  const pa = a.split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0)
  return false
}

function readResult (logDir) {
  const file = path.join(logDir, 'update-result.json')
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8'))
    fs.rmSync(file, { force: true })
    return r
  } catch { return null }
}
