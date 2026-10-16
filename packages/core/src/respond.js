// Respondents: people who can read a form and add their own answers, and
// nothing else.
//
// Everyone who can open a file holds its key, so the file can't hide one
// respondent's answers from another. Instead, answers are sealed to the
// form's response key before they go in (see @commonplace/forms), and this
// file checks the other half: that an update from a respondent only adds
// answers, under their own name, and changes nothing else.
//
// An answer is one entry in the file's `responses` map, keyed
// `<respondent's userId>.<random id>`, whose value is plain JSON. In Yjs
// terms, a valid update is made of brand-new map entries of that root (no
// left or right neighbor, so it can't replace or reorder anything), holding
// one JSON value each, and deletes nothing. Each answer is written by its
// own fresh Y.Doc, so the update carries nothing but the answer.

import crypto from 'node:crypto'
import * as Y from 'yjs'

export const RESPONSES = 'responses'
export const MAX_RESPONSE_BYTES = 256 * 1024

export const responseKey = (userId) => `${userId}.${crypto.randomBytes(8).toString('hex')}`

// Makes the update that adds one answer.
export function responseUpdate (userId, value) {
  const doc = new Y.Doc()
  doc.getMap(RESPONSES).set(responseKey(userId), value)
  const update = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return update
}

export function isResponseUpdate (update, userId) {
  if (!update || update.length > MAX_RESPONSE_BYTES || !/^[0-9a-f]{64}$/.test(String(userId))) return false
  let decoded
  try { decoded = Y.decodeUpdate(update) } catch { return false }
  const { structs, ds } = decoded
  if (!structs.length || ds.clients.size) return false
  const key = new RegExp(`^${userId}\\.[0-9a-f]{16}$`)
  return structs.every((s) => s instanceof Y.Item &&
    s.parent === RESPONSES &&
    typeof s.parentSub === 'string' && key.test(s.parentSub) &&
    s.origin === null && s.rightOrigin === null &&
    s.content instanceof Y.ContentAny && s.content.getLength() === 1)
}
