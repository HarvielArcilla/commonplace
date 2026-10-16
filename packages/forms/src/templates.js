// Ready-made forms for "New from a template".

import { addQuestion, updateQuestion, FORM } from './model.js'

function formOf (ydoc, { description, confirmation, questions }) {
  ydoc.transact(() => {
    const form = ydoc.getMap(FORM)
    form.set('description', description)
    form.set('accepting', true)
    form.set('confirmation', confirmation)
    for (const { type, title, ...rest } of questions) updateQuestion(ydoc, addQuestion(ydoc, { type, title }), rest)
  })
}

export const formTemplates = [
  {
    id: 'form.rsvp',
    name: 'Event sign-up',
    description: 'Who’s coming, who they’re bringing and what to know',
    build: (ydoc) => formOf(ydoc, {
      description: 'Let us know if you can make it.',
      confirmation: 'Thanks, see you there.',
      questions: [
        { type: 'short', title: 'Your name', required: true },
        { type: 'choice', title: 'Can you come?', options: ['Yes', 'No', 'Maybe'], required: true },
        { type: 'dropdown', title: 'How many people are you bringing?', options: ['Just me', '1 more', '2 more', '3 or more'] },
        { type: 'long', title: 'Anything we should know?' }
      ]
    })
  },
  {
    id: 'form.feedback',
    name: 'Feedback',
    description: 'A rating and two open questions',
    build: (ydoc) => formOf(ydoc, {
      description: 'A minute of your time helps us do better next time.',
      confirmation: 'Thank you for the feedback.',
      questions: [
        { type: 'scale', title: 'How was it overall?', low: 1, high: 5, lowLabel: 'Not good', highLabel: 'Great', required: true },
        { type: 'long', title: 'What worked well?' },
        { type: 'long', title: 'What could be better?' }
      ]
    })
  }
]
