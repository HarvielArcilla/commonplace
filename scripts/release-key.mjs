// Release signing for maintainers.
//
//   node scripts/release-key.mjs new
//       Makes a release key. Prints the public key (for
//       apps/desktop/src/release-key.js) and the private key (for the
//       RELEASE_SIGNING_KEY Actions secret). Nothing is written to disk.
//
//   RELEASE_SIGNING_KEY=... node scripts/release-key.mjs sign <folder> <version> <commit>
//       Writes release.json (the SHA-256 of every file in <folder>) and
//       release.json.sig into <folder>. CI runs this for each release.
//
//   node scripts/release-key.mjs verify <folder>
//       Checks a downloaded release against the keys built into the app.

import fs from 'node:fs'
import path from 'node:path'
import { newReleaseKey, signManifest, verifyManifest, sha256 } from '../apps/desktop/src/release-sign.js'
import { RELEASE_PUBLIC_KEYS } from '../apps/desktop/src/release-key.js'

const [cmd, ...args] = process.argv.slice(2)
const OWN = new Set(['release.json', 'release.json.sig'])

if (cmd === 'new') {
  const k = newReleaseKey()
  console.log(`Public key (add to apps/desktop/src/release-key.js):\n  ${k.publicKey}\n`)
  console.log(`Private key (add as the Actions secret RELEASE_SIGNING_KEY, and keep a copy offline; never commit it):\n  ${k.privateKey}`)
} else if (cmd === 'sign') {
  const [dir, version, commit] = args
  const secret = process.env.RELEASE_SIGNING_KEY
  if (!dir || !version || !secret) { console.error('usage: RELEASE_SIGNING_KEY=... release-key.mjs sign <folder> <version> <commit>'); process.exit(2) }
  const files = {}
  for (const name of fs.readdirSync(dir).sort()) {
    if (OWN.has(name) || !fs.statSync(path.join(dir, name)).isFile()) continue
    files[name] = sha256(fs.readFileSync(path.join(dir, name)))
  }
  const { json, sig } = signManifest({ version: version.replace(/^v/, ''), commit: commit || null, files }, secret)
  fs.writeFileSync(path.join(dir, 'release.json'), json)
  fs.writeFileSync(path.join(dir, 'release.json.sig'), sig)
  console.log(`Signed ${Object.keys(files).length} files for ${version}`)
} else if (cmd === 'verify') {
  const [dir] = args
  const m = verifyManifest(fs.readFileSync(path.join(dir, 'release.json')), fs.readFileSync(path.join(dir, 'release.json.sig'), 'utf8'), RELEASE_PUBLIC_KEYS)
  if (!m) { console.error('Not signed by a known release key.'); process.exit(1) }
  let bad = 0
  for (const [name, hash] of Object.entries(m.files)) {
    const p = path.join(dir, name)
    if (!fs.existsSync(p)) continue
    const ok = sha256(fs.readFileSync(p)) === hash
    if (!ok) bad++
    console.log(`${ok ? 'ok  ' : 'BAD '} ${name}`)
  }
  process.exit(bad ? 1 : 0)
} else {
  console.error('usage: release-key.mjs new | sign <folder> <version> <commit> | verify <folder>')
  process.exit(2)
}
