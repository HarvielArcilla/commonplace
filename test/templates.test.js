// Templates and copies: every built-in template builds, your own come back
// as they were saved, and copies carry content but not people or comments.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Drive } from '@commonplace/drive'
import { docsApps } from '@commonplace/docs'
import { sheetsApp } from '@commonplace/sheets'
import { readSheet, sheetList } from '@commonplace/sheets/model'
import { slidesApp } from '@commonplace/slides'
import { tasksApp } from '@commonplace/tasks'
import { readLists, cardsIn } from '@commonplace/tasks/model'
import { whiteboardApp } from '@commonplace/whiteboard'
import { formsApp } from '@commonplace/forms'
import { readQuestions } from '@commonplace/forms/model'
import { calendarApp } from '@commonplace/calendar'
import { addThread, readThreads } from '@commonplace/core/threads'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cp-templates-'))

test('templates: built-in ones build, mine come back, copies leave people out', async (t) => {
  const drive = new Drive({ dataDir: tmp(), apps: [...docsApps, sheetsApp, slidesApp, tasksApp, whiteboardApp, formsApp, calendarApp], transport: false, lan: false })
  t.after(() => drive.stop())
  await drive.start()

  const list = drive.templates.list()
  assert.ok(list.length >= 14)
  for (const tpl of list) assert.ok(tpl.preview || tpl.thumb, `${tpl.id} has a preview`)

  // A budget from its template: formulas work.
  const budgetId = await drive.templates.create('sheet.budget')
  assert.equal(drive.describe(budgetId).title, 'Monthly budget')
  const ydoc = drive.getDoc(budgetId).ydoc
  const sheet = readSheet(ydoc, sheetList(ydoc)[0].id)
  assert.equal(sheet.get(0, 0).text, 'Category')
  assert.equal(sheet.get(9, 1).input, '=SUM(B2:B9)')

  // A board, then my own template from it.
  const boardId = await drive.templates.create('tasks.move', { title: 'Our move' })
  const boardDoc = drive.getDoc(boardId).ydoc
  assert.equal(readLists(boardDoc).length, 4)
  addThread(boardDoc, { anchor: { kind: 'file' }, userId: drive.identity.userId, text: 'Not in templates' })
  const mine = drive.templates.save(boardId, { name: 'Our moving plan' })
  assert.ok(drive.templates.list().some((x) => x.id === mine && x.mine))
  const again = await drive.templates.create(mine)
  const againDoc = drive.getDoc(again).ydoc
  assert.equal(drive.describe(again).title, 'Our moving plan')
  assert.deepEqual(readLists(againDoc).map((l) => l.name), readLists(boardDoc).map((l) => l.name))
  assert.equal(cardsIn(againDoc, readLists(againDoc)[0].id).length, 3)
  assert.equal(readThreads(againDoc).length, 0)
  drive.templates.remove(mine)
  assert.ok(!drive.templates.list().some((x) => x.id === mine))

  // A copy of a form: same questions, no answers or comments.
  const formId = await drive.templates.create('form.rsvp')
  const copyId = await drive.copy(formId)
  assert.equal(drive.describe(copyId).title, 'Copy of Event sign-up')
  assert.deepEqual(readQuestions(drive.getDoc(copyId).ydoc).map((q) => q.title), readQuestions(drive.getDoc(formId).ydoc).map((q) => q.title))
  assert.equal(drive.describe(copyId).role, 'owner')
})
