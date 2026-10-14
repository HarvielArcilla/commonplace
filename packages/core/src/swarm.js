// Default transport: pure peer-to-peer over Hyperswarm.
//
// Peers find each other on a distributed hash table made of the users' own
// machines, punch through NATs with UDP hole punching, and talk over
// Noise-encrypted streams. No server of ours is involved. (A first-time node
// needs a few public bootstrap addresses to join the DHT, like any DHT.)

import Hyperswarm from 'hyperswarm'

export class SwarmTransport {
  // opts.isLonely(topicHex) -> true if that doc currently has no peers.
  // Lonely topics are re-looked-up periodically: two peers that join at
  // nearly the same moment can miss each other's announcements otherwise.
  constructor (engine, { isLonely = () => true, refreshMs = 15000, ...swarmOpts } = {}) {
    this.engine = engine
    this.swarm = new Hyperswarm(swarmOpts)
    this.topics = new Map()
    this.isLonely = isLonely
    this._timer = setInterval(() => this.refreshLonely(), refreshMs)
    this._timer.unref?.()
    this.swarm.on('connection', (socket) => {
      socket.on('error', () => {})
      engine.addConnection(socket, { remoteId: socket.remotePublicKey?.toString('hex'), localId: socket.publicKey?.toString('hex') })
    })
  }

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

  get peerCount () {
    return this.swarm.connections.size
  }

  async destroy () {
    clearInterval(this._timer)
    await this.swarm.destroy()
  }
}
