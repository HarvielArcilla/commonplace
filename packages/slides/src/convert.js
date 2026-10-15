// .pptx export for commonSlides (runs in the background process), with
// PptxGenJS. Slides are 960 x 540 units, exported at 13.33 x 7.5 inches, so
// one unit is one point and font sizes carry over as they are.

import PptxGenJS from 'pptxgenjs'
import { slideIds, readSlide, paragraphs, theme, WIDTH } from './model.js'

const IN = 13.333 / WIDTH // inches per slide unit
const color = (hex) => (typeof hex === 'string' ? hex.replace('#', '').toUpperCase() : undefined)
const firstFont = (stack) => String(stack).split(',')[0].trim().replace(/^["']|["']$/g, '')

export async function exportPptx (ydoc, { title = 'Presentation' } = {}) {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = title
  pptx.author = 'commonSlides'
  const t = theme(ydoc)
  for (const id of slideIds(ydoc)) {
    const s = readSlide(ydoc, id)
    const slide = pptx.addSlide()
    slide.background = { color: color(s.bg) }
    if (s.notes) slide.addNotes(s.notes)
    for (const el of s.elements) {
      const box = { x: el.x * IN, y: el.y * IN, w: el.w * IN, h: el.h * IN }
      if (el.type === 'image' && el.src) {
        slide.addImage({ data: el.src, ...box, altText: el.alt || undefined })
        continue
      }
      const text = textRuns(el, t)
      const shapeOpts = {
        ...box,
        fontFace: firstFont(t.font),
        fontSize: el.size || 20,
        color: color(el.color || t.fg),
        align: el.align || 'left',
        valign: el.valign === 'middle' ? 'middle' : el.valign === 'bottom' ? 'bottom' : 'top',
        bold: el.bold || undefined,
        margin: 6
      }
      if (el.type === 'shape') {
        Object.assign(shapeOpts, {
          shape: el.shape === 'ellipse' ? pptx.ShapeType.ellipse : el.shape === 'round' ? pptx.ShapeType.roundRect : pptx.ShapeType.rect,
          fill: el.fill ? { color: color(el.fill) } : undefined,
          line: el.stroke ? { color: color(el.stroke), width: 1 } : undefined
        })
      }
      slide.addText(text.length ? text : '', shapeOpts)
    }
  }
  return Buffer.from(await pptx.write({ outputType: 'nodebuffer' }))
}

function textRuns (el, t) {
  const out = []
  const paras = paragraphs(el.text)
  paras.forEach((p, i) => {
    const last = i === paras.length - 1
    const runs = p.runs.length ? p.runs : [{ text: '' }]
    runs.forEach((r, j) => {
      out.push({
        text: r.text,
        options: {
          bold: r.bold || el.bold || undefined,
          italic: r.italic || undefined,
          underline: r.underline ? { style: 'sng' } : undefined,
          color: r.color ? color(r.color) : undefined,
          fontSize: r.size || undefined,
          bullet: j === 0 && p.bullet ? (p.bullet === 'number' ? { type: 'number' } : true) : undefined,
          breakLine: j === runs.length - 1 && !last
        }
      })
    })
  })
  return out
}
