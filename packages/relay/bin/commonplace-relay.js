#!/usr/bin/env node
// Runs an always-on relay. Leave it running on any computer that stays on
// (an old laptop, a Raspberry Pi, a free cloud VM), then paste its address
// into commonplace under Share > Always-on relay.
//
//   commonplace-relay [--dir <folder>] [--quota <GB>]

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import DHT from 'hyperdht'
import { RelayServer } from '../src/server.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: commonplace-relay [--dir <folder>] [--quota <GB>]')
  process.exit(0)
}
// Relays used to be called helpers: an existing ~/.commonplace-helper keeps being used.
const oldDir = path.join(os.homedir(), '.commonplace-helper')
const dir = path.resolve(opt('dir', process.env.COMMONPLACE_RELAY_DIR || process.env.COMMONPLACE_HELPER_DIR || (fs.existsSync(oldDir) ? oldDir : path.join(os.homedir(), '.commonplace-relay'))))
const quotaBytes = Number(opt('quota', 4)) * 1024 ** 3
// Same settings as the app for a private network (testing, or a group
// running its own bootstrap node).
const list = (process.env.COMMONPLACE_BOOTSTRAP || '').split(',').map((s) => s.trim()).filter(Boolean)
const bootstrap = list.map((hp) => { const [host, port] = hp.split(':'); return { host, port: Number(port) } })
const swarm = !list.length ? {} : process.env.COMMONPLACE_DHT_HOST ? { dht: new DHT({ bootstrap, host: process.env.COMMONPLACE_DHT_HOST }) } : { bootstrap }

const relay = new RelayServer({ dir, quotaBytes, swarm })
const address = await relay.start()
console.log('commonplace relay is running.')
console.log('')
console.log(`  Address: ${address}`)
console.log('')
console.log('Paste the address into commonplace (Share > Always-on relay, or your profile).')
console.log(`Storing encrypted copies in ${dir} (up to ${opt('quota', 4)} GB). It can't read them.`)
const stop = async () => { await relay.stop(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
