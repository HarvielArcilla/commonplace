// Sealing and opening answers (main process only: it holds the identity).
//
// Each form has its own response key pair. Its public half is in the form,
// so anyone answering can seal to it; its private half is sealed to each
// editor (keyGrants), so only people who can edit the form can read the
// answers. Respondents hold the file's key like everyone else, so they
// receive each other's entries, but can't open them.
//
// Who answered isn't secret from other members: the entry's key starts with
// the respondent's ID, and respondents are members of the file. What they
// answered is.

import { sealTo, openSealed, newEncryptionKeyPair, responseUpdate, RESPONSES } from '@commonplace/core'
import { KEY_GRANTS, PUBLIC_KEY, readQuestions } from './model.js'

// As an editor: gives the form's response key to every editor who doesn't
// have it yet. The owner also makes the key if there is none (only the
// owner, so two people can't make different keys at once).
// editors: [{ userId, enc }]. Returns true if anything changed.
export function shareResponseKey (ydoc, identity, editors, { isOwner = false } = {}) {
  const grants = ydoc.getMap(KEY_GRANTS)
  let pair = myKey(ydoc, identity)
  let changed = false
  ydoc.transact(() => {
    if (!grants.get(PUBLIC_KEY) && isOwner) {
      const fresh = newEncryptionKeyPair()
      grants.set(PUBLIC_KEY, fresh.publicKey.toString('hex'))
      pair = { publicKey: fresh.publicKey, privateKey: fresh.privateKey }
      grants.set(identity.userId, sealTo(identity.encPublic, fresh.privateKey))
      changed = true
    }
    if (!pair) return // someone else made the key; an editor who has it will share it
    for (const e of editors) {
      if (!e.enc || e.userId === PUBLIC_KEY || grants.has(e.userId)) continue
      grants.set(e.userId, sealTo(e.enc, pair.privateKey))
      changed = true
    }
  }, 'local')
  return changed
}

function myKey (ydoc, identity) {
  const pub = ydoc.getMap(KEY_GRANTS).get(PUBLIC_KEY)
  const grant = ydoc.getMap(KEY_GRANTS).get(identity.userId)
  if (!pub || !grant) return null
  const priv = identity.openSealed(grant)
  return priv ? { publicKey: Buffer.from(pub, 'hex'), privateKey: priv } : null
}

// As a respondent: the update that adds my answers. answers: { questionId: value }.
// The question titles go along, so the answers still make sense if the form
// changes later.
export function answerUpdate (ydoc, identity, answers) {
  const pub = ydoc.getMap(KEY_GRANTS).get(PUBLIC_KEY)
  if (!pub) throw new Error('This form isn’t ready for answers yet. Its owner needs to open it once.')
  const questions = Object.fromEntries(readQuestions(ydoc).map((q) => [q.id, q.title]))
  const body = { by: identity.userId, name: identity.name, at: Date.now(), questions, answers }
  return responseUpdate(identity.userId, { v: 1, box: sealTo(pub, Buffer.from(JSON.stringify(body))) })
}

// As an editor: every answer I can open, oldest first.
export function readResponses (ydoc, identity) {
  const key = myKey(ydoc, identity)
  if (!key) return null
  const out = []
  for (const [entry, value] of ydoc.getMap(RESPONSES)) {
    const by = entry.split('.')[0]
    const plain = value?.box ? openSealed(key.privateKey, key.publicKey, value.box) : null
    if (!plain) continue
    let body
    try { body = JSON.parse(plain.toString('utf8')) } catch { continue }
    if (body.by !== by) continue // someone sealed an answer in another person's name
    out.push({ id: entry, by, name: String(body.name || ''), at: Number(body.at) || 0, answers: body.answers || {}, questions: body.questions || {} })
  }
  return out.sort((a, b) => a.at - b.at)
}
