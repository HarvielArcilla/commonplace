// commonSlides: model, concurrent edits, conflicts and .pptx export.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import JSZip from 'jszip'
import { slidesApp } from '@commonplace/slides'
import { addSlide, slideIds, readSlide, addShape, updateElement, plainText, duplicateSlide, deleteSlide, moveSlide, addText } from '@commonplace/slides/model'
import { exportPptx } from '@commonplace/slides/convert'
import { findConflicts, docFrom } from '@commonplace/core'

const sync = (a, b) => {
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)))
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)))
}
const write = (frag, text) => { const t = frag.get(0).get(0); t.insert(t.length, text) }

test('slides: layouts, moving different boxes at once, duplicating and reordering', () => {
  const a = new Y.Doc()
  slidesApp.initContent(a)
  const [first] = slideIds(a)
  const [title, sub] = readSlide(a, first).elements
  assert.equal(title.role, 'title')
  assert.equal(sub.role, 'body')
  const b = new Y.Doc()
  sync(a, b)
  write(title.text, 'Quarterly plan')
  updateElement(b, first, sub.id, { y: 400 })
  write(readSlide(b, first).elements.find((e) => e.id === sub.id).text, 'Team offsite')
  sync(a, b)
  const s = readSlide(a, first)
  assert.equal(plainText(s.elements.find((e) => e.id === title.id).text), 'Quarterly plan')
  assert.equal(s.elements.find((e) => e.id === sub.id).y, 400)
  assert.equal(plainText(s.elements.find((e) => e.id === sub.id).text), 'Team offsite')

  const second = addSlide(a, { layout: 'content', after: first })
  const copy = duplicateSlide(a, first)
  assert.deepEqual(slideIds(a), [first, copy, second])
  moveSlide(a, second, 0)
  assert.deepEqual(slideIds(a), [second, first, copy])
  assert.equal(plainText(readSlide(a, copy).elements[0].text), 'Quarterly plan', 'the copy has its own text')
  deleteSlide(a, copy)
  assert.equal(slideIds(a).length, 2)
})

test('the same box changed on both sides while apart is a conflict', () => {
  const d = new Y.Doc()
  slidesApp.initContent(d)
  const [id] = slideIds(d)
  const box = readSlide(d, id).elements[0].id
  const base = Y.encodeStateAsUpdate(d)
  const mine = docFrom(base)
  const theirs = docFrom(base)
  updateElement(mine, id, box, { x: 10 })
  updateElement(theirs, id, box, { x: 500 })
  addShape(theirs, id, { shape: 'ellipse' })
  const found = findConflicts({ base: docFrom(base), mine, theirs, units: slidesApp.units })
  assert.equal(found.length, 1)
  const rec = { kind: 'element', unit: found[0].key, versions: [found[0].mine, found[0].theirs].map((u) => ({ exists: true, text: u.text, snapshot: slidesApp.snapshotUnit(u) })) }
  slidesApp.resolve(mine, rec, 'v1')
  assert.equal(readSlide(mine, id).elements.find((e) => e.id === box).x, 500)
})

test('exports a .pptx with each slide, its text, shapes and notes', async () => {
  const d = new Y.Doc()
  slidesApp.initContent(d)
  const [first] = slideIds(d)
  write(readSlide(d, first).elements[0].text, 'Hello, slides')
  const second = addSlide(d, { layout: 'content', after: first })
  write(readSlide(d, second).elements[1].text.get(0).get(0), 'First point')
  addShape(d, second, { shape: 'ellipse', fill: '#d4efd9' })
  addText(d, second, { text: 'A note box' })
  readSlide(d, second) && d.getMap('slideData').get(second).get('notes').insert(0, 'Say hello')
  const zip = await JSZip.loadAsync(await exportPptx(d, { title: 'Deck' }))
  const files = Object.keys(zip.files)
  assert.ok(files.includes('ppt/slides/slide1.xml') && files.includes('ppt/slides/slide2.xml'))
  const s1 = await zip.file('ppt/slides/slide1.xml').async('string')
  const s2 = await zip.file('ppt/slides/slide2.xml').async('string')
  assert.match(s1, /Hello, slides/)
  assert.match(s2, /First point/)
  assert.match(s2, /A note box/)
  assert.match(s2, /prstGeom prst="ellipse"/)
  const notes = files.filter((f) => /notesSlide\d+\.xml$/.test(f))
  assert.ok((await Promise.all(notes.map((f) => zip.file(f).async('string')))).some((x) => x.includes('Say hello')))
})
