// Default transport: pure peer-to-peer over Hyperswarm.
//
// Peers find each other on a distributed hash table made of the users' own
// machines, punch through NATs with UDP hole punching, and talk over
// Noise-encrypted streams. No server of ours is involved. (A first-time node
// needs a few public bootstrap addresses to join the DHT, like any DHT.)
//
// To lean on those as little as possible, it remembers the DHT nodes it has
// seen (nodesFile) and starts from them next time, so once a computer has
// been online it can rejoin even if every bootstrap address is gone.

import fs from 'node:fs'
import Hyperswarm from 'hyperswarm'

const REMEMBER = 100 // nodes kept
const SAVE_MS = 10 * 60e3

export class SwarmTransport {
  // opts.isLonely(topicHex) -> true if that doc currently has no peers.
  // Lonely topics are re-looked-up periodically: two peers that join at
  // nearly the same moment can miss each other's announcements otherwise.
  // route(socket, remoteKeyHex): return true to take a connection for
  // something other than the sync engine (an always-on relay).
  // nodesFile: where the DHT nodes seen are remembered between runs.
  constructor (engine, { isLonely = () => true, refreshMs = 15000, route = () => false, nodesFile = null, ...swarmOpts } = {}) {
    this.engine = engine
    this.nodesFile = nodesFile
    const nodes = loadNodes(nodesFile)
    this.swarm = new Hyperswarm({ ...swarmOpts, ...(nodes.length && !swarmOpts.dht ? { nodes } : {}) })
    this.remembered = nodes.length
    this._saveTimer = nodesFile ? setInterval(() => this.saveNodes(), SAVE_MS) : null
    this._saveTimer?.unref?.()
    this.topics = new Map()
    this.isLonely = isLonely
    this._timer = setInterval(() => this.refreshLonely(), refreshMs)
    this._timer.unref?.()
    this.swarm.on('connection', (socket) => {
      socket.on('error', () => {})
      const remote = socket.remotePublicKey?.toString('hex')
      if (route(socket, remote)) return
      engine.addConnection(socket, { remoteId: remote, localId: socket.publicKey?.toString('hex') })
    })
  }

  // Keeps a direct connection to one peer by its key (a relay).
  joinPeer (key) { this.swarm.joinPeer(key) }
  leavePeer (key) { this.swarm.leavePeer(key) }

  async join (topic) {
    const key = topic.toString('hex')
    if (this.topics.has(key)) return
    const discovery = this.swarm.join(topic, { server: true, client: true })
    this.topics.set(key, discovery)
    await discovery.flushed()
  }

  async leave (topic) {
    const key = topic.toString('hex')
    if (!this.topics.has(key)) return
    this.topics.delete(key)
    await this.swarm.leave(topic)
  }

  refreshLonely () {
    for (const [key, discovery] of this.topics) {
      if (this.isLonely(key)) discovery.refresh({ client: true, server: true }).catch(() => {})
    }
  }

  // Remembers the nodes the DHT knows now (if it knows any).
  saveNodes () {
    if (!this.nodesFile || this._forgot) return
    let nodes = []
    try { nodes = this.swarm.dht.toArray({ limit: REMEMBER }) } catch {}
    nodes = nodes.filter(validNode)
    if (!nodes.length) return
    try {
      fs.writeFileSync(`${this.nodesFile}.tmp`, JSON.stringify({ savedAt: Date.now(), nodes }))
      fs.renameSync(`${this.nodesFile}.tmp`, this.nodesFile)
      this.remembered = nodes.length
    } catch {}
  }

  forgetNodes () {
    try { fs.rmSync(this.nodesFile, { force: true }) } catch {}
    this.remembered = 0
    this._forgot = true // until the next start
  }

  get peerCount () {
    return this.swarm.connections.size
  }

  async destroy () {
    clearInterval(this._timer)
    clearInterval(this._saveTimer)
    this.saveNodes()
    await this.swarm.destroy()
  }
}

const validNode = (n) => n && typeof n.host === 'string' && /^[0-9a-zA-Z.:-]{1,253}$/.test(n.host) && Number.isInteger(n.port) && n.port > 0 && n.port < 65536

function loadNodes (file) {
  if (!file) return []
  try { return (JSON.parse(fs.readFileSync(file, 'utf8')).nodes || []).filter(validNode).slice(0, REMEMBER) } catch { return [] }
}

// Hyperswarm's public bootstrap nodes.
export { BOOTSTRAP_NODES as PUBLIC_BOOTSTRAP } from 'hyperdht/lib/constants.js'
