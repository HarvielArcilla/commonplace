// Updates: the installed commit, signed releases, and what's offered.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Updates, gitHead, installerName } from '../apps/desktop/src/updates.js'
import { newReleaseKey, signManifest, verifyManifest, sha256 } from '../apps/desktop/src/release-sign.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-update-'))

function repo () {
  const dir = tmp()
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
  return { dir, git, sha: git('rev-parse', 'HEAD') }
}

// A stand-in for GitHub: routes by URL ending; files by download URL.
function fakeGitHub (t, routes) {
  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  const asked = []
  globalThis.fetch = async (url) => {
    asked.push(url)
    for (const [suffix, body] of Object.entries(routes)) {
      if (!url.endsWith(suffix)) continue
      const bytes = Buffer.isBuffer(body) ? body : null
      return { ok: true, json: async () => body, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length) }
    }
    return { ok: false, status: 404 }
  }
  return asked
}

test('signatures: only the release key’s, over exactly these bytes', () => {
  const key = newReleaseKey()
  const other = newReleaseKey()
  const { json, sig } = signManifest({ version: '0.3.0', commit: 'a'.repeat(40), files: { 'x.dmg': 'f'.repeat(64) } }, key.privateKey)
  assert.equal(verifyManifest(json, sig, [key.publicKey]).version, '0.3.0')
  assert.equal(verifyManifest(json, sig, [other.publicKey, key.publicKey]).version, '0.3.0', 'any listed key')
  assert.equal(verifyManifest(json, sig, [other.publicKey]), null)
  assert.equal(verifyManifest(json, sig, []), null)
  const tampered = Buffer.from(json.toString().replace('0.3.0', '0.3.1'))
  assert.equal(verifyManifest(tampered, sig, [key.publicKey]), null)
  assert.equal(verifyManifest(json, 'not a signature', [key.publicKey]), null)
  assert.equal(installerName('darwin', 'arm64'), 'commonplace-mac-arm64.dmg')
  assert.equal(installerName('win32', 'x64'), 'commonplace-windows-setup.exe')
})

test('reads the checked-out commit; following main counts the commits GitHub has that it doesn’t', async (t) => {
  const { dir, git, sha } = repo()
  assert.deepEqual(gitHead(dir), { sha, branch: 'main' })
  git('pack-refs', '--all')
  assert.deepEqual(gitHead(dir), { sha, branch: 'main' }, 'packed refs too')

  const asked = fakeGitHub(t, { [`compare/${sha}...main`]: { status: 'ahead', ahead_by: 2, behind_by: 0, commits: [{ commit: { message: 'Sheets\n\nlong' } }, { commit: { message: 'Slides' } }] } })
  let seen = null
  const u = new Updates({ root: dir, version: '0.1.0', packaged: false, logDir: dir, onChange: (s) => { seen = s }, followMain: () => true, keys: [] })
  await u.check()
  assert.match(asked[0], new RegExp(`compare/${sha}\\.\\.\\.main$`))
  assert.equal(seen.available, true)
  assert.equal(seen.behind, 2)
  assert.equal(seen.verified, false)
  assert.deepEqual(seen.changes, ['Slides', 'Sheets'])
  assert.equal(seen.canInstall, true, 'a clean checkout can update itself')
  fs.writeFileSync(path.join(dir, 'tracked.txt'), 'x')
  git('add', 'tracked.txt')
  await u.check()
  assert.equal(seen.canInstall, false, 'not with changes of your own')
})

test('installed from source with a release key: moves only to the commit a signed release names', async (t) => {
  const { dir, sha } = repo()
  const key = newReleaseKey()
  const target = 'b'.repeat(40)
  const { json, sig } = signManifest({ version: '0.3.0', commit: target, files: {} }, key.privateKey)
  fakeGitHub(t, {
    'releases/latest': { tag_name: 'v0.3.0', name: 'commonplace v0.3.0', html_url: 'https://x/rel', assets: [{ name: 'release.json', browser_download_url: 'https://dl/release.json' }, { name: 'release.json.sig', browser_download_url: 'https://dl/release.json.sig' }] },
    'dl/release.json': json,
    'dl/release.json.sig': Buffer.from(sig),
    [`compare/${sha}...${target}`]: { status: 'ahead', ahead_by: 7 }
  })
  let seen = null
  const u = new Updates({ root: dir, version: '0.2.0', packaged: false, logDir: dir, onChange: (s) => { seen = s }, keys: [key.publicKey] })
  await u.check()
  assert.equal(seen.available, true)
  assert.equal(seen.verified, true)
  assert.equal(seen.target, target)
  assert.equal(seen.canInstall, true)

  // Signed by some other key: nothing is offered, and it says why.
  const u2 = new Updates({ root: dir, version: '0.2.0', packaged: false, logDir: dir, onChange: (s) => { seen = s }, keys: [newReleaseKey().publicKey] })
  await u2.check()
  assert.equal(seen.available, false)
  assert.match(seen.problem, /isn’t signed/)
})

test('an installer build downloads the new installer and checks it against the signed hash', async (t) => {
  const key = newReleaseKey()
  const name = installerName()
  const good = crypto.randomBytes(5000)
  const { json, sig } = signManifest({ version: '0.3.0', commit: null, files: { [name]: sha256(good) } }, key.privateKey)
  const routes = {
    'releases/latest': { tag_name: 'v0.3.0', html_url: 'https://x/rel', assets: [{ name: 'release.json', browser_download_url: 'https://dl/release.json' }, { name: 'release.json.sig', browser_download_url: 'https://dl/release.json.sig' }, { name, browser_download_url: `https://dl/${name}`, size: good.length }] },
    'dl/release.json': json,
    'dl/release.json.sig': Buffer.from(sig),
    [`dl/${name}`]: good
  }
  fakeGitHub(t, routes)
  const opened = []
  let seen = null
  const appDir = tmp() // not a git checkout
  const u = new Updates({ root: appDir, version: '0.2.0', packaged: true, logDir: appDir, onChange: (s) => { seen = s }, keys: [key.publicKey], downloadDir: tmp(), openFile: async (f) => opened.push(f) })
  await u.check()
  assert.equal(seen.available, true)
  assert.equal(seen.canInstall, true)
  await u.install(() => {})
  assert.equal(opened.length, 1)
  assert.deepEqual(fs.readFileSync(opened[0]), good)

  // The same release with a swapped installer: thrown away, never opened.
  routes[`dl/${name}`] = crypto.randomBytes(5000)
  await u.check()
  await u.install(() => {})
  assert.equal(opened.length, 1)
  assert.match(seen.problem, /doesn’t match/)

  // Not newer than what's installed: nothing to offer.
  const same = new Updates({ root: appDir, version: '0.3.0', packaged: true, logDir: appDir, onChange: (s) => { seen = s }, keys: [key.publicKey], openFile: async () => {} })
  await same.check()
  assert.equal(seen.available, false)
})

// ---- different versions of the app working together ------------------------------

test('protocol versions: computers talk only when each meets the other’s minimum', async () => {
  const { compatible, PROTOCOL_VERSION, MIN_PROTOCOL_VERSION } = await import('@commonplace/core')
  assert.equal(compatible({ v: PROTOCOL_VERSION, min: MIN_PROTOCOL_VERSION }), null)
  assert.equal(compatible({ v: 2 }), null, 'apps from before versions were exchanged')
  assert.equal(compatible({ v: 1 }), 'older')
  assert.equal(compatible({ v: PROTOCOL_VERSION + 5, min: PROTOCOL_VERSION + 1 }), 'newer')
  assert.equal(compatible({ v: PROTOCOL_VERSION + 5, min: PROTOCOL_VERSION }), null, 'a newer app that still speaks ours')
})

test('a membership entry from a newer app is skipped, unless it limits access', async () => {
  const { Membership, loadOrCreateIdentity } = await import('@commonplace/core')
  const owner = loadOrCreateIdentity(tmp())
  const sam = loadOrCreateIdentity(tmp())
  const m = Membership.create(owner, 'doc9')
  m.admit(owner, { userId: sam.userId, role: 'editor', enc: sam.encPublic })
  m.append(owner, { type: 'badge', userId: sam.userId, colour: 'gold' }) // something a later app might add
  const copy = new Membership('doc9', m.entries)
  assert.equal(copy.entries.length, 3, 'the log still replays')
  assert.equal(copy.member(sam.userId).role, 'editor')
  assert.equal(copy.needsNewer, false)
  // A role a newer app knows and this one doesn't: view-only here, and the
  // log (with everything after it) still replays.
  const ana = loadOrCreateIdentity(tmp())
  m.append(owner, { type: 'add', userId: ana.userId, role: 'reviewer', enc: ana.encPublic })
  assert.equal(new Membership('doc9', m.entries).member(ana.userId).role, 'viewer')
  assert.throws(() => m.admit(owner, { userId: ana.userId, role: 'reviewer', enc: ana.encPublic }), /Unknown role/)
  m.append(owner, { type: 'quarantine', userId: sam.userId, critical: true })
  const strict = new Membership('doc9', m.entries)
  assert.equal(strict.needsNewer, true, 'a critical one stops this app syncing the file')
})

test('opening an older file runs its app’s migrations once; a newer file opens read-only', async (t) => {
  const { Drive } = await import('@commonplace/drive')
  const { docsApp } = await import('@commonplace/docs')
  const ran = []
  const v2 = { ...docsApp, schemaVersion: 2, migrations: { 2: (ydoc) => { ran.push(2); ydoc.getMap('extra').set('added', true) } } }
  const dir = tmp()
  const old = new Drive({ dataDir: dir, apps: [docsApp], transport: false, lan: false })
  await old.start()
  const docId = await old.create('docs', 'Notes')
  assert.equal(old.describe(docId).newerFormat, false)
  await old.stop()

  const now = new Drive({ dataDir: dir, apps: [v2], transport: false, lan: false })
  t.after(() => now.stop())
  await now.start()
  now.setOpen(docId, true)
  assert.deepEqual(ran, [2])
  assert.equal(now.getDoc(docId).ydoc.getMap('extra').get('added'), true)
  assert.equal(now.getDoc(docId).meta.get('schemaVersion'), 2)
  now.setOpen(docId, false)
  now.setOpen(docId, true)
  assert.deepEqual(ran, [2], 'only once')
  await now.stop()

  // Back on the older app: the file is newer than it, so read-only.
  const back = new Drive({ dataDir: dir, apps: [docsApp], transport: false, lan: false })
  await back.start()
  assert.equal(back.describe(docId).supported, true)
  assert.equal(back.describe(docId).newerFormat, true)
  await back.stop()
})
