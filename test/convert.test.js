import { test } from 'node:test'
import assert from 'node:assert/strict'
import { exportDocx, importDocx } from '@commonplace/docs/convert'
import { computeBreaks } from '@commonplace/docs/pagination'
import { pageGeometry, normalizePage } from '@commonplace/docs/page'

// 1x1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='

const sample = {
  type: 'doc',
  content: [
    { type: 'heading', attrs: { level: 1, textAlign: 'center' }, content: [{ type: 'text', text: 'Quarterly notes' }] },
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Bold', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'a link', marks: [{ type: 'link', attrs: { href: 'https://example.com' } }] },
        { type: 'text', text: ' and ' },
        { type: 'text', text: 'red 14pt', marks: [{ type: 'textStyle', attrs: { color: '#b4532a', fontSize: '14pt', fontFamily: 'Arial, sans-serif' } }] },
        { type: 'text', text: ' and math ' },
        { type: 'inlineMath', attrs: { latex: 'E = mc^2' } }
      ]
    },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'first point' }] }] }] },
    { type: 'orderedList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'step one' }] }] }] },
    { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Name' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] }] }] },
    { type: 'image', attrs: { src: PNG, alt: 'dot' } },
    { type: 'pageBreak' },
    { type: 'blockMath', attrs: { latex: '\\int_0^1 x\\,dx' } }
  ]
}

test('docx export then import keeps structure and page setup', async () => {
  const setup = normalizePage({ size: 'a4', orientation: 'landscape', margins: { top: 0.5, right: 0.75, bottom: 0.5, left: 0.75 }, pageNumbers: true })
  const buf = await exportDocx(sample, setup, { title: 'Quarterly notes' })
  assert.ok(buf.length > 1000)
  const { html, page } = await importDocx(buf)
  assert.match(html, /<h1>Quarterly notes<\/h1>/)
  assert.match(html, /<strong>Bold<\/strong>/)
  assert.match(html, /<a href="https:\/\/example.com">a link<\/a>/)
  assert.match(html, /<ul><li>first point<\/li><\/ul>/)
  assert.match(html, /<ol><li>step one<\/li><\/ol>/)
  assert.match(html, /<table>/)
  assert.match(html, /<img[^>]+src="data:image\/png;base64,/)
  assert.match(html, /E = mc\^2/)
  assert.equal(page.size, 'a4')
  assert.equal(page.orientation, 'landscape')
  assert.equal(page.margins.top, 0.5)
  assert.equal(page.margins.left, 0.75)
  assert.equal(page.pageNumbers, true)
})

test('docx export keeps indents and uses the editor\'s default fonts', async () => {
  const JSZip = (await import('jszip')).default
  const doc = { type: 'doc', content: [{ type: 'paragraph', attrs: { indent: 2, firstLine: 1 }, content: [{ type: 'text', text: 'Indented' }] }, { type: 'codeBlock', content: [{ type: 'text', text: 'x = 1' }] }] }
  const xml = await (await JSZip.loadAsync(await exportDocx(doc, normalizePage({})))).file('word/document.xml').async('string')
  assert.match(xml, /<w:ind w:left="1440" w:firstLine="720"\/>/)
  assert.match(xml, /Courier New/)
})

test('pagination: blocks move whole, paragraphs split by line, with widow and orphan control', () => {
  const geo = pageGeometry({ size: 'letter', margins: { top: 1, right: 1, bottom: 1, left: 1 } })
  assert.equal(geo.contentHeight, 864) // 11in - 2in, at 96 px per inch
  const stride = geo.height + geo.gap
  const lines = (top, n, h = 24) => Array.from({ length: n }, (_, i) => ({ top: top + i * h, bottom: top + (i + 1) * h }))

  // An image that doesn't fit moves to the next page whole.
  let r = computeBreaks([{ top: 0, bottom: 800 }, { top: 810, bottom: 1000 }], geo)
  assert.equal(r.pages, 2)
  assert.deepEqual(r.breaks, [{ unit: 1, height: stride - 810 }])

  // A long paragraph splits at the first line that doesn't fit.
  r = computeBreaks([{ top: 0, bottom: 700 }, { top: 710, bottom: 710 + 20 * 24, lines: lines(710, 20) }], geo)
  // lines 0..5 fit (710 + 6*24 = 854 <= 864); line 6 starts the next page
  assert.deepEqual(r.breaks, [{ unit: 1, line: 6, height: stride - (710 + 6 * 24) }])
  assert.equal(r.pages, 2)

  // Orphan: only one line would stay behind, so the whole paragraph moves.
  r = computeBreaks([{ top: 0, bottom: 830 }, { top: 840, bottom: 840 + 5 * 24, lines: lines(840, 5) }], geo)
  assert.deepEqual(r.breaks, [{ unit: 1, height: stride - 840 }])

  // Widow: only the last line would move, so the last two move together.
  r = computeBreaks([{ top: 0, bottom: 700 }, { top: 744, bottom: 744 + 6 * 24, lines: lines(744, 6) }], geo)
  // natural fit is lines 0..4 (744+5*24=864); line 5 alone would be a widow
  assert.deepEqual(r.breaks, [{ unit: 1, line: 4, height: stride - (744 + 4 * 24) }])

  // A manual page break starts a new page.
  r = computeBreaks([{ top: 0, bottom: 40 }, { top: 50, bottom: 50, forced: true }, { top: 60, bottom: 90 }], geo)
  assert.deepEqual(r.breaks, [{ unit: 2, height: stride - 60 }])
  assert.equal(r.pages, 2)

  // Results never depend on spacers, so recomputing is stable.
  const units = [{ top: 0, bottom: 700 }, { top: 710, bottom: 710 + 40 * 24, lines: lines(710, 40) }]
  assert.deepEqual(computeBreaks(units, geo), computeBreaks(units, geo))
})
