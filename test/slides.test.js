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

// ---- .pptx import, themes and transitions ----------------------------------------

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const rel = (id, type, target) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`
const rels = (...items) => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

// A small deck in the shape PowerPoint writes: a 4:3 slide whose title
// placeholder takes its position from the layout, a body with bullets, a
// picture, a shape colored by its style, notes and a theme.
async function samplePptx () {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<p:presentation ${NS}><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`)
  zip.file('ppt/_rels/presentation.xml.rels', rels(rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'), rel('rId2', 'slide', 'slides/slide1.xml'), rel('rId3', 'theme', 'theme/theme1.xml')))
  zip.file('ppt/theme/theme1.xml', `<a:theme ${NS}><a:themeElements><a:clrScheme name="x"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:accent1><a:srgbClr val="4F81BD"/></a:accent1></a:clrScheme><a:fontScheme name="x"><a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`)
  zip.file('ppt/slideMasters/slideMaster1.xml', `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="F3E6CF"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld></p:sldMaster>`)
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<p:sldLayout ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></a:xfrm></p:spPr></p:sp></p:spTree></p:cSld></p:sldLayout>`)
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', rels(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')))
  zip.file('ppt/slides/slide1.xml', `<p:sld ${NS}><p:cSld><p:spTree>
    <p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en" sz="4400" b="1"/><a:t>Garden club</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2800"/><a:t>Beds planted</a:t></a:r></a:p><a:p><a:r><a:rPr sz="2800"><a:solidFill><a:srgbClr val="C02020"/></a:solidFill></a:rPr><a:t>Red</a:t></a:r><a:br/><a:r><a:t>and more</a:t></a:r></a:p></p:txBody></p:sp>
    <p:sp><p:nvSpPr><p:cNvPr id="4" name="Oval"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="6000000" y="4000000"/><a:ext cx="1000000" cy="1000000"/></a:xfrm><a:prstGeom prst="ellipse"/></p:spPr><p:style><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef></p:style></p:sp>
    <p:pic><p:nvPicPr><p:cNvPr id="5" name="Pic" descr="A dot"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId3"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>
    <p:pic><p:nvPicPr><p:cNvPr id="6" name="Vector"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId4"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm></p:spPr></p:pic>
  </p:spTree></p:cSld></p:sld>`)
  zip.file('ppt/slides/_rels/slide1.xml.rels', rels(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'), rel('rId2', 'notesSlide', '../notesSlides/notesSlide1.xml'), rel('rId3', 'image', '../media/image1.png'), rel('rId4', 'image', '../media/image2.emf')))
  zip.file('ppt/notesSlides/notesSlide1.xml', `<p:notes ${NS}><p:cSld><p:spTree><p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes"/><p:cNvSpPr/><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:p><a:r><a:t>Thank the volunteers</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`)
  zip.file('ppt/media/image1.png', Buffer.from(PNG, 'base64'))
  zip.file('ppt/media/image2.emf', Buffer.from('not really'))
  return zip.generateAsync({ type: 'nodebuffer' })
}

test('.pptx import: inherited placeholders, bullets, styles, pictures, notes and theme', async () => {
  const { importPptx } = await import('@commonplace/slides/pptx-import')
  const { paragraphs, theme } = await import('@commonplace/slides/model')
  const d = new Y.Doc()
  slidesApp.initContent(d)
  const { slides, warnings } = await importPptx(d, await samplePptx())
  assert.equal(slides, 1)
  assert.equal(warnings, 1) // the .emf picture
  const [id] = slideIds(d)
  const s = readSlide(d, id)
  assert.equal(s.bg, '#f3e6cf') // from the master
  assert.equal(s.notes, 'Thank the volunteers')
  assert.equal(theme(d).font, '"Calibri", Arial, Helvetica, sans-serif')
  const title = s.elements.find((e) => e.role === 'title')
  // 4:3 into 16:9: scaled by 540/7.5in and centered.
  assert.deepEqual([title.x, title.y, title.w, title.h], [156, 22, 648, 90])
  assert.equal(title.size, 44)
  assert.deepEqual(paragraphs(title.text)[0].runs.map((r) => [r.text, r.bold]), [['Garden club', true]])
  const body = s.elements.find((e) => e.role === 'body')
  const paras = paragraphs(body.text)
  assert.deepEqual(paras.map((p) => p.bullet), ['bullet', 'bullet'])
  assert.equal(paras[1].runs[0].color, '#c02020')
  assert.equal(plainText(body.text), 'Beds planted\nRedand more')
  const oval = s.elements.find((e) => e.type === 'shape')
  assert.equal(oval.shape, 'ellipse')
  assert.equal(oval.fill, '#4f81bd')
  const pic = s.elements.find((e) => e.type === 'image')
  assert.match(pic.src, /^data:image\/png;base64,/)
  assert.equal(pic.alt, 'A dot')
})

test('.pptx import refuses files that are not presentations', async () => {
  const { importPptx } = await import('@commonplace/slides/pptx-import')
  const d = new Y.Doc()
  await assert.rejects(importPptx(d, Buffer.from('hello')), /isn’t a PowerPoint/)
  const zip = new JSZip()
  zip.file('word/document.xml', '<w:document/>')
  await assert.rejects(importPptx(d, await zip.generateAsync({ type: 'nodebuffer' })), /isn’t a PowerPoint/)
})

test('themes restyle every slide; transitions are per slide', async () => {
  const { applyTheme, setTransition, theme, THEMES } = await import('@commonplace/slides/model')
  const d = new Y.Doc()
  slidesApp.initContent(d)
  const second = addSlide(d, { layout: 'content' })
  applyTheme(d, 'ink')
  assert.equal(theme(d).title, THEMES.ink.title)
  assert.deepEqual(slideIds(d).map((id) => readSlide(d, id).bg), [THEMES.ink.bg, THEMES.ink.bg])
  setTransition(d, [second], 'fade')
  assert.deepEqual(slideIds(d).map((id) => readSlide(d, id).transition), ['none', 'fade'])
  setTransition(d, slideIds(d), 'none')
  assert.equal(readSlide(d, second).transition, 'none')
  const pptx = await JSZip.loadAsync(await exportPptx(d))
  assert.ok(pptx.file('ppt/slides/slide1.xml'))
})
