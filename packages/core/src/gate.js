// Who may change what. Every computer decides for itself whether to take an
// update, the same way whether it came from a peer or from a relay box:
//
//   editors and the owner   anything
//   respondents             only new answers of their own (respond.js),
//                           up to this computer's limit per person
//   commenters              only the comment threads (threads.js)
//   viewers, anyone else    nothing
//
// Respondents and commenters send only their own changes, kept in an
// outbox (usesOutbox), since a catch-up update from them would carry
// everyone else's edits too and be refused.

import { canEdit, canRespond, canComment } from './members.js'
import { isResponseUpdate } from './respond.js'
import { isCommentUpdate } from './threads.js'

// answerAllowed(): whether this computer takes another answer from them.
export function mayApply (ydoc, { role, userId, update, answerAllowed = () => true }) {
  if (canEdit(role)) return true
  if (canRespond(role)) return isResponseUpdate(update, userId) && answerAllowed()
  if (canComment(role)) return isCommentUpdate(ydoc, update)
  return false
}

export const usesOutbox = (role) => canRespond(role) || canComment(role)
