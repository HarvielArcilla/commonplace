// Converts a CommonDocs document (ProseMirror JSON) to a .docx file.
// Runs in Node (the background process). Supported: headings, paragraphs,
// alignment, bold/italic/underline/strike/code, font, size, color, highlight,
// links, lists, quotes, code blocks, tables, images, rules, page breaks,
// page size/margins/orientation and page numbers.
// Math is written as its LaTeX source in Cambria Math (Word equation objects
// are not generated yet).

import {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, ExternalHyperlink,
  ImageRun, Table, TableRow, TableCell, WidthType, PageBreak, Footer, PageNumber,
  LevelFormat, BorderStyle, ShadingType, PageOrientation
} from 'docx'
import { normalizePage, pageInches } from '../page.js'
import { dataUrlToBuffer, imageType, imageSize } from './image-size.js'

const TWIP = 1440 // per inch
const BODY_FONT = 'Georgia'
const MONO_FONT = 'Courier New'
const MATH_FONT = 'Cambria Math'

const HEADINGS = { 1: HeadingLevel.HEADING_1, 2: HeadingLevel.HEADING_2, 3: HeadingLevel.HEADING_3 }
const ALIGN = { left: AlignmentType.LEFT, center: AlignmentType.CENTER, right: AlignmentType.RIGHT, justify: AlignmentType.JUSTIFIED }

export async function exportDocx (json, pageSetup, { title = '' } = {}) {
  const setup = normalizePage(pageSetup)
  const { width, height } = pageInches(setup)
  const ctx = { listInstance: 0, contentWidthPx: Math.round((width - setup.margins.left - setup.margins.right) * 96) }
  const children = blocks(json?.content || [], ctx)
  if (!children.length) children.push(new Paragraph(''))

  const doc = new Document({
    title,
    creator: 'Commonplace',
    styles: {
      default: {
        document: { run: { font: BODY_FONT, size: 24 }, paragraph: { spacing: { after: 160, line: 300 } } }
      },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 40, bold: true, font: BODY_FONT, color: '1F2430' }, paragraph: { spacing: { before: 360, after: 120 } } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 32, bold: true, font: BODY_FONT, color: '1F2430' }, paragraph: { spacing: { before: 280, after: 100 } } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 26, bold: true, font: BODY_FONT, color: '1F2430' }, paragraph: { spacing: { before: 240, after: 80 } } }
      ]
    },
    numbering: {
      config: [
        { reference: 'cp-bullet', levels: [0, 1, 2, 3, 4].map((level) => ({ level, format: LevelFormat.BULLET, text: ['•', '◦', '▪', '•', '◦'][level], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) },
        { reference: 'cp-ordered', levels: [0, 1, 2, 3, 4].map((level) => ({ level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER][level], text: `%${level + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } } })) }
      ]
    },
    sections: [{
      properties: {
        page: {
          size: {
            // docx expects portrait numbers plus an orientation flag.
            width: Math.round(Math.min(width, height) * TWIP),
            height: Math.round(Math.max(width, height) * TWIP),
            orientation: setup.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT
          },
          margin: {
            top: Math.round(setup.margins.top * TWIP),
            right: Math.round(setup.margins.right * TWIP),
            bottom: Math.round(setup.margins.bottom * TWIP),
            left: Math.round(setup.margins.left * TWIP)
          }
        }
      },
      footers: setup.pageNumbers
        ? { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: [PageNumber.CURRENT], size: 18, color: '8A8F9B' })] })] }) }
        : undefined,
      children
    }]
  })
  return Packer.toBuffer(doc)
}

// ---- blocks ------------------------------------------------------------------

function blocks (nodes, ctx, para = {}) {
  const out = []
  for (const node of nodes) out.push(...block(node, ctx, para))
  return out
}

// Indent levels are 0.5 in each (720 twips), matching the editor.
function indentOf (attrs, para) {
  const left = (para.indent?.left || 0) + (attrs?.indent || 0) * 720
  const firstLine = attrs?.firstLine ? 720 : 0
  return left || firstLine ? { left: left || undefined, firstLine: firstLine || undefined } : para.indent
}

function block (node, ctx, para) {
  const align = ALIGN[node.attrs?.textAlign]
  switch (node.type) {
    case 'paragraph':
      return [new Paragraph({ ...para, indent: indentOf(node.attrs, para), alignment: align, children: inlines(node.content, ctx) })]
    case 'heading':
      return [new Paragraph({ ...para, indent: indentOf(node.attrs, para), heading: HEADINGS[node.attrs?.level] || HeadingLevel.HEADING_1, alignment: align, children: inlines(node.content, ctx) })]
    case 'bulletList':
    case 'orderedList':
      return list(node, ctx, para, 0)
    case 'blockquote':
      return blocks(node.content || [], ctx, {
        ...para,
        indent: { left: (para.indent?.left || 0) + 540 },
        border: { left: { style: BorderStyle.SINGLE, size: 12, color: 'A9B8DA', space: 12 } }
      })
    case 'codeBlock': {
      const text = (node.content || []).map((t) => t.text || '').join('')
      return text.split('\n').map((line) => new Paragraph({
        ...para,
        spacing: { after: 0, line: 260 },
        shading: { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' },
        children: [new TextRun({ text: line || ' ', font: MONO_FONT, size: 20 })]
      }))
    }
    case 'horizontalRule':
      return [new Paragraph({ ...para, border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9CDD5', space: 1 } }, children: [] })]
    case 'blockMath':
      return [new Paragraph({ ...para, alignment: AlignmentType.CENTER, children: [new TextRun({ text: node.attrs?.latex || '', font: MATH_FONT, italics: true })] })]
    case 'image': {
      const run = imageRun(node.attrs, ctx)
      return run ? [new Paragraph({ ...para, alignment: AlignmentType.CENTER, children: [run] })] : []
    }
    case 'table':
      return [table(node, ctx)]
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })]
    default:
      return node.content ? blocks(node.content, ctx, para) : []
  }
}

function list (node, ctx, para, level) {
  const ordered = node.type === 'orderedList'
  const instance = ordered ? ++ctx.listInstance : 0
  const out = []
  for (const item of node.content || []) {
    let first = true
    for (const child of item.content || []) {
      if (child.type === 'bulletList' || child.type === 'orderedList') {
        out.push(...list(child, ctx, para, Math.min(level + 1, 4)))
        continue
      }
      if (first && (child.type === 'paragraph' || child.type === 'heading')) {
        out.push(new Paragraph({
          ...para,
          numbering: ordered ? { reference: 'cp-ordered', level, instance } : { reference: 'cp-bullet', level },
          spacing: { after: 60 },
          children: inlines(child.content, ctx)
        }))
        first = false
      } else {
        out.push(...block(child, ctx, { ...para, indent: { left: 720 * (level + 1) } }))
      }
    }
  }
  return out
}

function table (node, ctx) {
  const rows = (node.content || []).map((row) => new TableRow({
    children: (row.content || []).map((cell) => new TableCell({
      columnSpan: cell.attrs?.colspan > 1 ? cell.attrs.colspan : undefined,
      rowSpan: cell.attrs?.rowspan > 1 ? cell.attrs.rowspan : undefined,
      shading: cell.type === 'tableHeader' ? { type: ShadingType.CLEAR, fill: 'F1F2F5', color: 'auto' } : undefined,
      children: (() => {
        const content = blocks(cell.content || [], ctx)
        return content.length ? content : [new Paragraph('')]
      })()
    }))
  }))
  return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })
}

function imageRun (attrs, ctx) {
  const parsed = dataUrlToBuffer(attrs?.src)
  if (!parsed) return null
  const type = imageType(parsed.data)
  if (!type) return null
  const natural = imageSize(parsed.data) || { width: 400, height: 300 }
  let w = attrs.width || natural.width
  let h = attrs.height || Math.round(w * natural.height / natural.width)
  if (w > ctx.contentWidthPx) { h = Math.round(h * ctx.contentWidthPx / w); w = ctx.contentWidthPx }
  return new ImageRun({ type, data: parsed.data, transformation: { width: w, height: h }, altText: attrs.alt ? { name: attrs.alt, description: attrs.alt, title: attrs.alt } : undefined })
}

// ---- inline ------------------------------------------------------------------

function inlines (nodes = [], ctx) {
  const out = []
  let link = null
  const flush = () => {
    if (link) out.push(new ExternalHyperlink({ link: link.href, children: link.runs }))
    link = null
  }
  for (const node of nodes) {
    const href = node.marks?.find((m) => m.type === 'link')?.attrs?.href
    const run = inlineRun(node, ctx, Boolean(href))
    if (!run) continue
    if (href) {
      if (!link || link.href !== href) { flush(); link = { href, runs: [] } }
      link.runs.push(run)
    } else {
      flush()
      out.push(run)
    }
  }
  flush()
  return out
}

function inlineRun (node, ctx, isLink) {
  if (node.type === 'hardBreak') return new TextRun({ text: '', break: 1 })
  if (node.type === 'inlineMath') return new TextRun({ text: node.attrs?.latex || '', font: MATH_FONT, italics: true })
  if (node.type === 'image') return imageRun(node.attrs, ctx)
  if (node.type !== 'text') return null
  const opts = { text: node.text }
  for (const m of node.marks || []) {
    if (m.type === 'bold') opts.bold = true
    else if (m.type === 'italic') opts.italics = true
    else if (m.type === 'underline') opts.underline = {}
    else if (m.type === 'strike') opts.strike = true
    else if (m.type === 'code') { opts.font = MONO_FONT; opts.shading = { type: ShadingType.CLEAR, fill: 'F3F4F6', color: 'auto' } }
    else if (m.type === 'textStyle') {
      if (m.attrs?.fontFamily) opts.font = firstFont(m.attrs.fontFamily)
      const pt = toPoints(m.attrs?.fontSize)
      if (pt) opts.size = Math.round(pt * 2)
      const color = toHex(m.attrs?.color)
      if (color) opts.color = color
    } else if (m.type === 'highlight') {
      opts.shading = { type: ShadingType.CLEAR, fill: toHex(m.attrs?.color) || 'FFF3A3', color: 'auto' }
    }
  }
  if (isLink) { opts.style = 'Hyperlink'; opts.color = opts.color || '284B8C' }
  return new TextRun(opts)
}

export function firstFont (stack) {
  return String(stack).split(',')[0].trim().replace(/^["']|["']$/g, '')
}

export function toPoints (size) {
  const m = /^([\d.]+)\s*(px|pt)?$/.exec(String(size || '').trim())
  if (!m) return null
  const v = parseFloat(m[1])
  return m[2] === 'pt' ? v : v * 0.75
}

export function toHex (color) {
  if (!color) return null
  const c = String(color).trim()
  let m = /^#([0-9a-f]{6})$/i.exec(c)
  if (m) return m[1].toUpperCase()
  m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
  if (m) return (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase()
  m = /^rgba?\((\d+)\D+(\d+)\D+(\d+)/i.exec(c)
  if (m) return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
  return null
}
