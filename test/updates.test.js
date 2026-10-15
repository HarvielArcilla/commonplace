// Update check: the installed commit, and what GitHub says about it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Updates, gitHead } from '../apps/desktop/src/updates.js'

test('reads the checked-out commit and reports how far behind GitHub it is', async (t) => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-update-'))
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'first')
  const sha = git('rev-parse', 'HEAD')
  assert.deepEqual(gitHead(repo), { sha, branch: 'main' })
  git('pack-refs', '--all')
  assert.deepEqual(gitHead(repo), { sha, branch: 'main' }, 'packed refs too')

  const real = globalThis.fetch
  t.after(() => { globalThis.fetch = real })
  let asked = null
  globalThis.fetch = async (url) => {
    asked = url
    return { ok: true, json: async () => ({ status: 'behind', behind_by: 2, commits: [{ commit: { message: 'Sheets\n\nlong' } }, { commit: { message: 'Slides' } }] }) }
  }
  let seen = null
  const u = new Updates({ root: repo, version: '0.1.0', packaged: false, logDir: repo, onChange: (s) => { seen = s } })
  await u.check()
  assert.match(asked, new RegExp(`compare/${sha}\\.\\.\\.main$`))
  assert.equal(seen.available, true)
  assert.equal(seen.behind, 2)
  assert.deepEqual(seen.changes, ['Slides', 'Sheets'])
  assert.equal(seen.canInstall, true, 'a clean checkout can update itself')

  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'x')
  git('add', 'tracked.txt')
  await u.check()
  assert.equal(seen.canInstall, false, 'not with changes of your own')
})
