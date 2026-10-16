// Ready-made boards for "New from a template".

import { addList, addCard, updateCard } from './model.js'

function boardOf (ydoc, lists) {
  ydoc.transact(() => {
    for (const [name, cards] of lists) {
      const id = addList(ydoc, name)
      for (const c of cards) {
        const [title, notes] = [].concat(c)
        const cardId = addCard(ydoc, id, title)
        if (notes) updateCard(ydoc, cardId, { notes })
      }
    }
  })
}

export const taskTemplates = [
  {
    id: 'tasks.project',
    name: 'Project plan',
    description: 'From ideas to done, with the first steps written down',
    build: (ydoc) => boardOf(ydoc, [
      ['Ideas', ['Things we might do later']],
      ['To do', [['Write a short brief', 'Why, what, and how we’ll know it worked'], 'Agree on a date', 'Share the plan']],
      ['Doing', []],
      ['Done', []]
    ])
  },
  {
    id: 'tasks.move',
    name: 'Moving house',
    description: 'Before, on the day and after',
    build: (ydoc) => boardOf(ydoc, [
      ['A month before', ['Book the van or movers', 'Give notice where needed', 'Sort what to keep, sell or give away']],
      ['The week before', ['Pack room by room', 'Change your address', 'Arrange meter readings']],
      ['Moving day', ['Keep a box of essentials', 'Check every room before leaving']],
      ['After', ['Register with local services', 'Unpack the kitchen first']]
    ])
  },
  {
    id: 'tasks.week',
    name: 'Week',
    description: 'One list per day',
    build: (ydoc) => boardOf(ydoc, ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Weekend'].map((d) => [d, []]))
  }
]
