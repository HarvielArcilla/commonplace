// Tells people when a newer version of commonplace is out, and installs it.
//
// Releases are signed (release-sign.js): with the project's release key
// built in, a release is offered and installed only if its release.json is
// signed by that key, and every file is checked against the SHA-256 the
// signature covers before it's used.
//
//   - Installers (.dmg, .exe, .AppImage): the new installer is downloaded,
//     checked, and opened for you.
//   - Installed from source: the checkout moves to the commit the signed
//     release names (git merge --ff-only of exactly that commit), rather
//     than to whatever is on main. "Follow main" in Settings switches to
//     every new commit, unsigned, for people testing the newest work.
//
// The only things sent are ordinary requests to GitHub for the project's
// releases and commits. Nothing about you or your files goes with them.
// Turn it off in Settings, or set COMMONPLACE_NO_UPDATE_CHECK=1.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { verifyManifest } from './release-sign.js'
import { RELEASE_PUBLIC_KEYS } from './release-key.js'

const REPO = 'HarvielArcilla/commonplace'
const EVERY_MS = 6 * 3600e3

// The installer for this computer, by the names the release workflow gives them.
export function installerName (platform = process.platform, arch = process.arch) {
  if (platform === 'darwin') return `commonplace-mac-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`
  if (platform === 'win32') return 'commonplace-windows-setup.exe'
  if (platform === 'linux') return 'commonplace-linux-x86_64.AppImage'
  return null
}

export class Updates {
  // root: the folder of the git checkout (or of the app, when packaged).
  // enabled(): whether checking is on; followMain(): source installs track
  // every commit on main instead of signed releases. Both are settings.
  // keys: release public keys (hex); downloadDir: where installers go.
  constructor ({ root, version, packaged, logDir, onChange, enabled = () => true, followMain = () => false, keys = RELEASE_PUBLIC_KEYS, downloadDir = null, openFile = null }) {
    this.enabled = enabled
    this.followMain = followMain
    this.keys = keys
    this.root = root
    this.version = version
    this.packaged = packaged
    this.logDir = logDir
    this.onChange = onChange
    this.downloadDir = downloadDir || path.join(os.tmpdir(), 'commonplace-updates')
    this.openFile = openFile
    this.state = { available: false, behind: 0, changes: [], canInstall: false, installing: false, verified: false, problem: null, url: `https://github.com/${REPO}` }
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
    if (!this.enabled()) return
    try {
      const head = gitHead(this.root)
      if (head && (this.followMain() || !this.keys.length)) this.state = await this.checkMain(head)
      else this.state = await this.checkRelease(head)
    } catch {
      return // offline, or GitHub is busy: try again later
    }
    this.onChange(this.state)
  }

  // Installed from source, following main: how many commits behind is it?
  async checkMain ({ sha, branch }) {
    const cmp = await github(`compare/${sha}...${encodeURIComponent(branch)}`)
    // compare/A...B: "ahead" means B has commits A doesn't.
    const behind = cmp.status === 'ahead' || cmp.status === 'diverged' ? cmp.ahead_by || 0 : 0
    const changes = (cmp.commits || []).slice(-5).reverse().map((c) => String(c.commit?.message || '').split('\n')[0]).filter(Boolean)
    const canInstall = cmp.status === 'ahead' && behind > 0 && await this._clean()
    return { available: behind > 0, behind, changes, canInstall, installing: false, verified: false, problem: null, channel: 'main', url: `https://github.com/${REPO}/commits/${branch}` }
  }

  // The newest signed release. head: the checkout, for source installs.
  async checkRelease (head = null) {
    const rel = await github('releases/latest')
    const latest = String(rel.tag_name || '').replace(/^v/, '')
    const url = rel.html_url || `https://github.com/${REPO}/releases`
    const none = { available: false, behind: 0, changes: [], canInstall: false, installing: false, verified: false, problem: null, url }
    const manifest = await this._manifest(rel)
    if (this.keys.length && !manifest) {
      // Something is published that the release key didn't sign: say so, offer nothing.
      return newer(latest, this.version) ? { ...none, problem: `Version ${latest} is on GitHub but isn’t signed with the project’s release key, so commonplace won’t install it.` } : none
    }
    const changes = [rel.name || `Version ${latest}`]
    if (head) {
      const target = manifest?.commit
      if (!target || target === head.sha) return none
      const cmp = await github(`compare/${head.sha}...${target}`)
      if (cmp.status !== 'ahead') return none // already past it, or on another branch
      return { ...none, available: true, behind: cmp.ahead_by || 0, changes, verified: Boolean(manifest), canInstall: Boolean(manifest) && await this._clean(), channel: 'release', target, manifest }
    }
    if (!newer(latest, this.version)) return none
    const name = installerName()
    const asset = (rel.assets || []).find((a) => a.name === name)
    const hash = manifest?.files?.[name]
    return { ...none, available: true, changes, verified: Boolean(manifest), canInstall: Boolean(manifest && asset && hash && this.openFile), channel: 'release', manifest, asset: asset ? { name, url: asset.browser_download_url, size: asset.size, sha256: hash } : null }
  }

  // release.json and its signature, checked; null if missing or not signed by a known key.
  async _manifest (rel) {
    const find = (n) => (rel.assets || []).find((a) => a.name === n)?.browser_download_url
    const jsonUrl = find('release.json')
    const sigUrl = find('release.json.sig')
    if (!jsonUrl || !sigUrl || !this.keys.length) return null
    const [json, sig] = await Promise.all([download(jsonUrl, 1e6), download(sigUrl, 1e4)])
    return verifyManifest(json, sig.toString('utf8'), this.keys)
  }

  _clean () {
    // Updating in place needs git and no changes of your own in the folder.
    return new Promise((resolve) => {
      execFile('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: this.root, windowsHide: true }, (err, out) => resolve(!err && !out.trim()))
    })
  }

  // Installs the update this check found.
  async install (quit) {
    if (!this.state.canInstall || this.state.installing) return
    this.state = { ...this.state, installing: true }
    this.onChange(this.state)
    if (this.state.asset) {
      try {
        const file = await this._downloadInstaller(this.state.asset)
        this.state = { ...this.state, installing: false, downloaded: file }
        this.onChange(this.state)
        await this.openFile(file)
      } catch (err) {
        this.state = { ...this.state, installing: false, problem: `The update didn’t download: ${err.message}` }
        this.onChange(this.state)
      }
      return
    }
    this._runSourceUpdate(quit, this.state.channel === 'release' ? this.state.target : null)
  }

  // Downloads an installer and checks it byte for byte against the signed hash.
  async _downloadInstaller ({ name, url, sha256 }) {
    fs.mkdirSync(this.downloadDir, { recursive: true })
    const target = path.join(this.downloadDir, name)
    const bytes = await download(url, 2 * 1024 ** 3)
    const got = crypto.createHash('sha256').update(bytes).digest('hex')
    if (got !== sha256) throw new Error('it doesn’t match the signed release, so it was thrown away')
    fs.writeFileSync(target, bytes, { mode: 0o755 })
    return target
  }

  // Quits, moves the checkout to the new version (exactly `target`, when
  // following signed releases), installs what it needs and starts again.
  // Runs in a separate process so nothing is in use while it updates; what
  // it did is in update.log, and the app reports a failure next time.
  _runSourceUpdate (quit, target) {
    fs.mkdirSync(this.logDir, { recursive: true })
    const node = process.env.npm_node_execpath || 'node'
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const args = [path.join(this.root, 'scripts', 'update.mjs'), String(process.pid), this.logDir, ...(target ? [target] : [])]
    const child = spawn(node, args, { cwd: this.root, detached: true, stdio: 'ignore', windowsHide: true, env })
    child.unref()
    setTimeout(quit, 300)
  }
}

async function download (url, max) {
  const r = await fetch(url, { headers: { 'User-Agent': 'commonplace' }, redirect: 'follow', signal: AbortSignal.timeout(30 * 60e3) })
  if (!r.ok) throw new Error(`GitHub said ${r.status}`)
  const bytes = Buffer.from(await r.arrayBuffer())
  if (bytes.length > max) throw new Error('it was larger than expected')
  return bytes
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
