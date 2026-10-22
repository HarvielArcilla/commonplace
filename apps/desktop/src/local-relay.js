// This computer as an always-on relay (Settings → Always-on relay). The
// relay is the same program as `npm run relay`, run inside commonplace, in
// its own folder (so its address survives signing out) and under its own
// quota. This computer's Drive talks to it in memory; everyone else reaches
// it over the network. A relay helps only while it runs, so while it's on,
// closing the window leaves commonplace running in the tray.

import path from 'node:path'
import { RelayServer } from '@commonplace/relay'

const GB = 1024 ** 3
export const QUOTA_GB = { default: 4, min: 1, max: 2000 }
export const cleanQuota = (n) => Math.min(QUOTA_GB.max, Math.max(QUOTA_GB.min, Math.round(Number(n) || QUOTA_GB.default)))

export class LocalRelay {
  // swarm(): options for its network connection (the same bootstrap as the
  // rest of the app). onChange(): it started, stopped or filled up.
  constructor ({ dataDir, swarm, onChange = () => {} }) {
    this.dir = path.join(dataDir, 'relay')
    this.swarm = swarm
    this.onChange = onChange
    this.server = null
  }

  get on () { return Boolean(this.server) }

  async start ({ quotaGB = QUOTA_GB.default } = {}) {
    if (this.server) { this.server.quotaBytes = cleanQuota(quotaGB) * GB; return this.server }
    const server = new RelayServer({ dir: this.dir, quotaBytes: cleanQuota(quotaGB) * GB, swarm: this.swarm() })
    await server.start()
    server.on('connection', () => this.onChange())
    this.server = server
    this.onChange()
    return server
  }

  async stop () {
    const server = this.server
    this.server = null
    await server?.stop()
    this.onChange()
  }

  status () {
    if (!this.server) return { on: false }
    return { on: true, address: this.server.address, ...this.server.stats() }
  }
}
