// This computer's network settings (Settings → Network), kept in
// network.json. They apply the next time commonplace starts.
//
//   bootstrap        extra DHT bootstrap nodes ('host:port'), such as one a
//                    group runs for itself
//   publicBootstrap  also use Hyperswarm's public bootstrap nodes
//
// commonplace also remembers the DHT nodes it has seen (dht-nodes.json, see
// core/swarm.js), so the bootstrap nodes are only needed the first time.

import fs from 'node:fs'
import path from 'node:path'
import { PUBLIC_BOOTSTRAP } from '@commonplace/core'

const MAX_NODES = 20
const NODE = /^(?:[0-9.]{7,15}@)?[0-9a-zA-Z.-]{1,253}:\d{1,5}$/

// 'host:port' lines -> { nodes, bad }
export function parseNodes (text) {
  const nodes = []
  const bad = []
  for (const raw of String(text || '').split(/[\s,]+/)) {
    const s = raw.trim()
    if (!s) continue
    const port = Number(s.split(':').pop())
    if (NODE.test(s) && port > 0 && port < 65536) { if (!nodes.includes(s)) nodes.push(s) } else bad.push(s)
  }
  return { nodes: nodes.slice(0, MAX_NODES), bad }
}

export class NetworkSettings {
  constructor (dataDir) {
    this.file = path.join(dataDir, 'network.json')
    this.nodesFile = path.join(dataDir, 'dht-nodes.json')
    this.values = { bootstrap: [], publicBootstrap: true }
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.values.bootstrap = parseNodes((saved.bootstrap || []).join('\n')).nodes
      this.values.publicBootstrap = saved.publicBootstrap !== false || !this.values.bootstrap.length
    } catch {}
  }

  get () { return { ...this.values, bootstrap: [...this.values.bootstrap] } }

  set ({ bootstrap, publicBootstrap } = {}) {
    const next = { ...this.values }
    if (bootstrap !== undefined) {
      const { nodes, bad } = parseNodes(Array.isArray(bootstrap) ? bootstrap.join('\n') : bootstrap)
      if (bad.length) throw new Error(`Not a bootstrap address: ${bad[0]} (use host:port)`)
      next.bootstrap = nodes
    }
    if (publicBootstrap !== undefined) next.publicBootstrap = Boolean(publicBootstrap)
    // Without the public nodes there must be some other way in.
    if (!next.publicBootstrap && !next.bootstrap.length) throw new Error('Add a bootstrap address before turning off the public ones.')
    this.values = next
    fs.writeFileSync(this.file, JSON.stringify(this.values, null, 2))
    return this.get()
  }

  // Options for the swarm transport.
  swarmOptions () {
    const { bootstrap, publicBootstrap } = this.values
    const opts = { nodesFile: this.nodesFile }
    if (bootstrap.length) opts.bootstrap = [...bootstrap, ...(publicBootstrap ? PUBLIC_BOOTSTRAP : [])]
    return opts
  }
}
