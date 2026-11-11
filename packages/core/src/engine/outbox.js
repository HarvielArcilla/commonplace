// What respondents and commenters send: only their own answers or
// comments, kept in an outbox until someone who can edit takes them.
// Mixed into SyncEngine.

import * as Y from 'yjs'
import { MSG } from '../protocol.js'
import { seal } from '../crypto.js'
import { canEdit, canRespond } from '../members.js'
import { isResponseUpdate } from '../respond.js'

export class Outbox {
  // As a respondent: adds one answer (an update from responseUpdate) and
  // sends it to everyone connected who can edit. It also waits in an
  // outbox and goes again to each editor I connect to, since there may be
  // nobody to take it right now.
  respond (docId, update) {
    const doc = this.docs.get(docId)
    if (!doc) throw new Error('Unknown document')
    if (!canRespond(doc.myAccess?.role)) throw new Error('Only respondents answer this way.')
    if (!isResponseUpdate(update, this.identity.userId)) throw new Error('That isn’t an answer.')
    Y.applyUpdate(doc.ydoc, update, 'response')
    this._sendOwn(doc, update)
  }

  // A respondent's answer or a commenter's comment: kept in the outbox, sent
  // now to everyone connected who can edit, and again to each editor I meet
  // (and to relays). A commenter's changes are merged into one update, since
  // they can touch the same threads again and again.
  _sendOwn (doc, update, { merge = false } = {}) {
    let box = this.store.readJSON(doc.docId, 'outbox') || []
    if (merge) box = [Buffer.from(Y.mergeUpdates([...box.map((b) => Buffer.from(b, 'base64')), update])).toString('base64')]
    else box.push(Buffer.from(update).toString('base64'))
    this.store.writeJSON(doc.docId, 'outbox', box)
    for (const [conn, link] of doc.links) {
      if (link.contentEpoch === doc.contentEpoch && canEdit(link.role)) conn.send(MSG.UPDATE, doc.docId, doc.contentEpoch, seal(doc.keyFor(doc.contentEpoch), update))
    }
    this.emit('outbox', doc.docId, update)
  }

  outbox (docId) {
    return (this.store.readJSON(docId, 'outbox') || []).map((b64) => Buffer.from(b64, 'base64'))
  }
}
