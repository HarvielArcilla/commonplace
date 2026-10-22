// One computer for the cross-version test (scripts/compat.mjs), running the
// commonplace at `root`, which may be an older release. It takes commands
// as JSON lines on stdin and answers each with a JSON line on stdout, so
// the same script drives every version.
//
//   node peer.mjs <root> <dataDir> <bootstrap host:port>

import path from 'node:path'
import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const [root, dataDir, boot] = process.argv.slice(2)
const load = (p) => import(pathToFileURL(path.join(root, p)).href)
const { Drive } = await load('packages/drive/src/index.js')
const { docsApp, CONTENT_FIELD } = await load('packages/docs/src/index.js')
const Y = await load('node_modules/yjs/dist/yjs.mjs')
const { default: DHT } = await load('node_modules/hyperdht/index.js')

const [host, port] = boot.split(':')
const drive = new Drive({ dataDir, apps: [docsApp], lan: false, swarm: { dht: new DHT({ bootstrap: [{ host, port: Number(port) }], host: '127.0.0.1' }), refreshMs: 500 } })
drive.setProfile({ name: path.basename(dataDir) })
await drive.start()

function append (docId, str) {
  const doc = drive.getDoc(docId)
  doc.ydoc.transact(() => {
    const frag = doc.ydoc.getXmlFragment(CONTENT_FIELD)
    if (!frag.length) { const p = new Y.XmlElement('paragraph'); p.insert(0, [new Y.XmlText()]); frag.insert(0, [p]) }
    const t = frag.get(0).get(0)
    t.insert(t.length, str)
  }, 'local')
}

const commands = {
  async create ({ title, role }) {
    const docId = await drive.create('docs', title)
    return { docId, invite: drive.invite(docId, role || 'editor') }
  },
  async join ({ invite }) { return { docId: await drive.join(invite) } },
  async append ({ docId, text }) { append(docId, text); return {} },
  async read ({ docId }) {
    const doc = drive.getDoc(docId)
    return { text: doc ? docsApp.preview(doc.ydoc) : null, role: drive.describe(docId)?.access?.role || null }
  },
  async stop () { await drive.stop(); setTimeout(() => process.exit(0), 50); return {} }
}

const out = (msg) => process.stdout.write(JSON.stringify(msg) + '\n')
out({ ready: true })
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, cmd, ...args } = JSON.parse(line)
  try { out({ id, ...(await commands[cmd](args)) }) } catch (err) { out({ id, error: err.message }) }
}
