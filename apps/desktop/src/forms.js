// commonForms in the background process, which holds the keys: giving the
// response key to editors, sealing my answers, and opening answers.

import { canEdit } from '@commonplace/core'
import { shareResponseKey, answerUpdate, readResponses } from '@commonplace/forms/responses'
import { readQuestions } from '@commonplace/forms/model'
import { responsesCsv } from '@commonplace/forms/convert'

export function formServices (drive) {
  const isForm = (docId) => drive.describe(docId)?.kind === 'form'
  const handle = (docId) => {
    const doc = drive.getDoc(docId)
    if (!doc) throw new Error('This file is no longer in your Drive.')
    return doc
  }

  // As an editor: make sure every editor can open the answers.
  function setup (docId) {
    if (!isForm(docId)) return
    const doc = handle(docId)
    const role = drive.engine.access(docId)?.role
    if (!canEdit(role)) return
    const editors = [...doc.members.state.members]
      .filter(([, m]) => canEdit(m.role) && m.enc)
      .map(([userId, m]) => ({ userId, enc: m.enc }))
    shareResponseKey(doc.ydoc, drive.identity, editors, { isOwner: role === 'owner' })
  }

  return {
    setup,
    // Keep the key shared as people are made editors.
    watch () { drive.engine.on('members', (docId) => { try { setup(docId) } catch {} }) },
    submit (docId, answers) {
      const doc = handle(docId)
      drive.engine.respond(docId, answerUpdate(doc.ydoc, drive.identity, answers))
    },
    responses (docId) {
      setup(docId)
      return readResponses(handle(docId).ydoc, drive.identity)
    },
    csv (docId) {
      const doc = handle(docId)
      const all = readResponses(doc.ydoc, drive.identity)
      if (!all) throw new Error('You can’t open this form’s answers on this computer yet.')
      return responsesCsv(readQuestions(doc.ydoc), all)
    }
  }
}
