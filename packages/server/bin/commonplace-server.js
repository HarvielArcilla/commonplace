#!/usr/bin/env node
// Runs a commonplace server: leave it on a computer that stays on, and it
// hosts team drives for your group (docs/TEAM-DRIVES.md).
//
//   commonplace-server [--dir <folder>] [--name <name>] [--admin-link]
//
// The first time, it prints a link: open it in commonplace to become the
// server's first admin. --admin-link prints a new one.

import os from 'node:os'
import path from 'node:path'
import DHT from 'hyperdht'
import { TeamServer } from '../src/server.js'

const args = process.argv.slice(2)
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback }
if (args.includes('--help') || args.includes('-h')) {
  console.log('Usage: commonplace-server [--dir <folder>] [--name <name>] [--admin-link]')
  process.exit(0)
}
const dir = path.resolve(opt('dir', process.env.COMMONPLACE_SERVER_DIR || path.join(os.homedir(), '.commonplace-server')))
const name = opt('name', process.env.COMMONPLACE_SERVER_NAME || `${os.hostname()} server`)
// Same settings as the app for a private network.
const list = (process.env.COMMONPLACE_BOOTSTRAP || '').split(',').map((s) => s.trim()).filter(Boolean)
const bootstrap = list.map((hp) => { const [host, port] = hp.split(':'); return { host, port: Number(port) } })
const swarm = !list.length ? {} : process.env.COMMONPLACE_DHT_HOST ? { dht: new DHT({ bootstrap, host: process.env.COMMONPLACE_DHT_HOST }) } : { bootstrap }

const server = new TeamServer({ dir, name, swarm, log: (line) => console.log(`[${new Date().toISOString()}] ${line}`) })
const { adminLink } = await server.start()
console.log(`commonplace server "${name}" is running.`)
console.log(`Keeping its drives in ${dir}.`)
const link = adminLink || (args.includes('--admin-link') ? server.adminLink() : null)
if (link) {
  console.log('')
  console.log('Open this link in commonplace to become an admin of this server (it works once, for a week):')
  console.log('')
  console.log(`  ${link}`)
}
console.log('')
console.log(`Admins: ${server.admins().map((m) => m.name || m.userId.slice(0, 8)).join(', ') || 'none yet'}. Team drives: ${server.teamDrives().length}.`)
const stop = async () => { await server.stop(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
