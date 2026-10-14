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

test('pagination pushes a block that does not fit to the next page', () => {
  const geo = pageGeometry({ size: 'letter', margins: { top: 1, right: 1, bottom: 1, left: 1 } })
  // contentHeight = 1056 - 192 = 864
  assert.equal(geo.contentHeight, 864)
  const blocks = [
    { pos: 0, height: 400, marginTop: 0 },
    { pos: 10, height: 400, marginTop: 12 },
    { pos: 20, height: 100, marginTop: 12 }, // 400+12+400+12+100 > 864 -> new page
    { pos: 30, height: 20, marginTop: 12, forced: true }, // manual break
    { pos: 40, height: 30, marginTop: 12 }
  ]
  const { breaks, pages } = computeBreaks(blocks, geo)
  assert.equal(pages, 3)
  assert.deepEqual(breaks.map((b) => b.pos), [20, 40])
  // Spacer fills the rest of page 1, then bottom margin, gap and top margin.
  assert.equal(breaks[0].height, (864 - 812) + 96 + geo.gap + 96)
})
