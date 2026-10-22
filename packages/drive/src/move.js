// Copying a whole Drive (your identity, folders and every file) from one
// computer to another, directly between the two, while both are online.
// Used both to link another computer (both keep the Drive and stay in sync)
// and to move to one (the old computer signs out afterwards).
//
// The old computer shows a one-time code. The new computer enters it. Both
// derive a meeting place on the peer-to-peer network and an encryption key
// from the code, the old computer sends everything, and the new one confirms
// it has written all of it to disk. Only then, when moving, does the old
// computer sign out and delete its copies.
//
// Anyone who sees the code while it is active could take the Drive, so it is
// shown only on the old computer and expires after 15 minutes.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Hyperswarm from 'hyperswarm'
import * as Y from 'yjs'
import { seal, open, installIdentity, newDeviceKeys, FileStore } from '@commonplace/core'

const PREFIX = 'cpmove1.'
const EXPIRES_MS = 15 * 60 * 1000

export function newMoveCode () {
  return PREFIX + crypto.randomBytes(24).toString('base64url')
}

export function parseMoveCode (text) {
  const m = String(text || '').trim().match(/cpmove1\.([A-Za-z0-9_-]{32})/)
  return m ? Buffer.from(m[1], 'base64url') : null
}

function keysFor (secret) {
  const h = (label) => crypto.createHash('sha256').update(`commonplace/move/v1/${label}`).update(secret).digest()
  return { topic: h('topic'), key: h('key') }
}

// Length-prefixed, sealed JSON messages over one connection.
function channel (socket, key, onMessage) {
  let buf = Buffer.alloc(0)
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0)
      if (len > 256 * 1024 * 1024) { socket.destroy(); return }
      if (buf.length < 4 + len) return
      const plain = open(key, buf.subarray(4, 4 + len))
      buf = buf.subarray(4 + len)
      if (!plain) { socket.destroy(); return }
      onMessage(JSON.parse(plain.toString('utf8')))
    }
  })
  return (msg) => {
    const body = seal(key, Buffer.from(JSON.stringify(msg)))
    const head = Buffer.alloc(4)
    head.writeUInt32BE(body.length)
    socket.write(Buffer.concat([head, body]))
  }
}

// Old computer: waits for the new one, sends the Drive, resolves once the new
// computer confirms it has everything. Does not delete anything itself.
// `leaving`: this is a move, so this computer will sign out afterwards.
export function sendDrive ({ code, drive, swarm = {}, onStatus = () => {}, signal, leaving = false }) {
  const secret = parseMoveCode(code)
  if (!secret) throw new Error('Invalid move code.')
  const { topic, key } = keysFor(secret)
  const net = new Hyperswarm(swarm)
  let done = false
  return new Promise((resolve, reject) => {
    const finish = async (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      await net.destroy().catch(() => {})
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('The move code expired. Start again to get a new one.')), EXPIRES_MS)
    signal?.addEventListener('abort', () => finish(new Error('Move cancelled.')))
    net.on('connection', (socket) => {
      socket.on('error', () => {})
      const send = channel(socket, key, (msg) => {
        if (msg.type === 'ready') {
          if (!msg.empty) { send({ type: 'refused', reason: 'not-empty' }); return }
          onStatus({ phase: 'sending' })
          // With protection on, the new computer gets a place in my list of
          // computers instead of the account key.
          if (drive.identity.isProtected && msg.device) drive.identity.addDevice({ id: msg.device.id, enc: msg.device.enc, name: msg.device.name })
          const payload = drive.exportForMove({ leaving })
          send({ type: 'identity', identity: payload.identity })
          send({ type: 'index', index: payload.index })
          for (const doc of payload.docs) send({ type: 'doc', ...doc })
          send({ type: 'done', count: payload.docs.length })
        } else if (msg.type === 'received') {
          // Moving away: this computer leaves my list (the new one is in it).
          if (leaving && drive.identity.isProtected) drive.leaveList()
          onStatus({ phase: 'confirmed', count: msg.count })
          finish(null, { count: msg.count })
        }
      })
      onStatus({ phase: 'connected' })
    })
    net.join(topic, { server: true, client: false })
  })
}

// New computer: connects with the code, writes the Drive into dataDir, then
// tells the old computer it may sign out. dataDir must not hold a Drive yet.
export function receiveDrive ({ code, dataDir, isEmpty, swarm = {}, onStatus = () => {}, beforeInstall = async () => {}, deviceName = undefined }) {
  const secret = parseMoveCode(code)
  if (!secret) throw new Error('That move code is not valid.')
  const { topic, key } = keysFor(secret)
  const net = new Hyperswarm(swarm)
  const staging = path.join(dataDir, `.incoming-${Date.now()}`)
  const device = newDeviceKeys() // this computer's own keys for the Drive coming in
  let done = false
  return new Promise((resolve, reject) => {
    let finish = async (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      setTimeout(() => net.destroy().catch(() => {}), 500) // let the confirmation leave
      if (err) fs.rmSync(staging, { recursive: true, force: true })
      err ? reject(err) : resolve(value)
    }
    const timer = setTimeout(() => finish(new Error('Couldn’t reach the other computer. Check that it is showing the code and is online.')), EXPIRES_MS)
    net.on('connection', (socket) => {
      socket.on('error', () => {})
      let identity = null
      let index = null
      const docs = []
      const send = channel(socket, key, async (msg) => {
        try {
          if (msg.type === 'refused') return finish(new Error('This computer already has files, so it can’t take another Drive.'))
          if (msg.type === 'identity') identity = msg.identity
          else if (msg.type === 'index') index = msg.index
          else if (msg.type === 'doc') {
            if (!/^[0-9a-f]{32}$/.test(msg.docId)) return
            docs.push(msg.docId)
            new FileStore(path.join(staging, 'files')).importDoc(msg.docId, msg.files)
            onStatus({ phase: 'receiving', count: docs.length })
          } else if (msg.type === 'done') {
            if (!identity || !index || docs.length !== msg.count) throw new Error('The transfer was incomplete. Try again.')
            await installStaged({ staging, dataDir, identity, index, device, beforeInstall })
            send({ type: 'received', count: docs.length })
            onStatus({ phase: 'done', count: docs.length })
            finish(null, { count: docs.length, userId: identity.userId })
          }
        } catch (err) {
          finish(err)
        }
      })
      onStatus({ phase: 'connected' })
      send({ type: 'ready', empty: isEmpty(), device: { id: device.id, enc: device.encPublic, name: deviceName } })
    })
    // Look up the other computer now and every couple of seconds, in case it
    // was still announcing itself the first time.
    const discovery = net.join(topic, { server: false, client: true })
    const retry = setInterval(() => { if (!done && !net.connections.size) discovery.refresh().catch(() => {}) }, 2000)
    net.once('close', () => clearInterval(retry))
    const stop = finish
    finish = async (err, value) => { clearInterval(retry); return stop(err, value) }
  })
}

// The last step of bringing a Drive here (from another computer or from a
// backup): the files are already in staging/files; write the identity and
// the index next to them, then swap everything into place.
export async function installStaged ({ staging, dataDir, identity, index, device = null, beforeInstall = async () => {} }) {
  const indexStore = new FileStore(path.join(staging, 'files'))
  const ydoc = new Y.Doc()
  Y.applyUpdate(ydoc, Buffer.from(index, 'base64'))
  indexStore.load('drive-index', new Y.Doc())
  indexStore.compact('drive-index', ydoc)
  installIdentity(staging, identity, device)
  await beforeInstall() // e.g. stop the running (empty) Drive
  fs.rmSync(path.join(dataDir, 'files'), { recursive: true, force: true })
  fs.renameSync(path.join(staging, 'files'), path.join(dataDir, 'files'))
  fs.renameSync(path.join(staging, 'identity.json'), path.join(dataDir, 'identity.json'))
  fs.rmSync(staging, { recursive: true, force: true })
}
