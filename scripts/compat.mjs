// Checks that this checkout syncs with earlier releases: each one is checked
// out next to this one and run in its own process, and the two make, share
// and edit files both ways.
//
//   node scripts/compat.mjs [tag ...]     (default: the two newest release tags)

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import createTestnet from 'hyperdht/testnet.js'

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: here, encoding: 'utf8' }).trim()
const head = git('rev-parse', 'HEAD')
const tags = process.argv.slice(2).length
  ? process.argv.slice(2)
  : git('tag', '--sort=-v:refname').split('\n').filter((t) => /^v\d/.test(t) && git('rev-list', '-n', '1', t) !== head).slice(0, 2)
if (!tags.length) { console.log('No earlier release to compare with.'); process.exit(0) }

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until (fn, what, ms = 60000) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (await fn()) return; await sleep(250) }
  throw new Error(`timed out waiting for ${what}`)
}

function peer (root, name, bootstrap) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cp-compat-${name}-`))
  const child = spawn(process.execPath, [path.join(here, 'test/compat/peer.mjs'), root, dir, bootstrap], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  let ready
  const started = new Promise((resolve) => { ready = resolve })
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const msg = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      if (msg.ready) ready()
      else waiting.get(msg.id)?.(msg)
    }
  })
  let n = 0
  const call = (cmd, args = {}) => new Promise((resolve, reject) => {
    const id = ++n
    waiting.set(id, (msg) => (msg.error ? reject(new Error(`${name}: ${msg.error}`)) : resolve(msg)))
    child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
  })
  return { name, started, call, kill: () => child.kill() }
}

// One file made on `a`, shared with `b`; both edit it; both see both edits.
async function roundTrip (a, b) {
  const { docId, invite } = await a.call('create', { title: `${a.name} to ${b.name}` })
  await a.call('append', { docId, text: `From ${a.name}.` })
  await b.call('join', { invite })
  await until(async () => (await b.call('read', { docId })).text === `From ${a.name}.`, `${b.name} to get ${a.name}’s file`)
  await until(async () => (await b.call('read', { docId })).role === 'editor', `${b.name} to be an editor`)
  await b.call('append', { docId, text: ` From ${b.name}.` })
  await until(async () => (await a.call('read', { docId })).text === `From ${a.name}. From ${b.name}.`, `${a.name} to get ${b.name}’s edit`)
}

const testnet = await createTestnet(3)
const bootstrap = `${testnet.bootstrap[0].host}:${testnet.bootstrap[0].port}`
let failed = false
for (const tag of tags) {
  const old = fs.mkdtempSync(path.join(os.tmpdir(), `cp-${tag}-`))
  git('worktree', 'add', '--detach', old, tag)
  try {
    console.log(`Installing ${tag}…`)
    execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: old, stdio: 'ignore' })
    const now = peer(here, 'this-build', bootstrap)
    const then = peer(old, tag, bootstrap)
    try {
      await Promise.all([now.started, then.started])
      await roundTrip(now, then)
      await roundTrip(then, now)
      console.log(`✓ syncs both ways with ${tag}`)
    } finally {
      await Promise.allSettled([now.call('stop'), then.call('stop')])
      now.kill()
      then.kill()
    }
  } catch (err) {
    failed = true
    console.error(`✗ ${tag}: ${err.message}`)
  } finally {
    git('worktree', 'remove', '--force', old)
  }
}
await testnet.destroy()
process.exit(failed ? 1 : 0)
