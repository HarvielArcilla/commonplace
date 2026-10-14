// Reads a .docx file into HTML the editor can load, plus its page setup.
// Runs in Node (the background process).
//
// Mammoth keeps structure (headings, lists, tables, links, images, bold,
// italic, underline, strikethrough). Exact fonts, colors and alignment are
// not carried over yet.

import mammoth from 'mammoth'
import JSZip from 'jszip'
import { DEFAULT_PAGE, PAGE_SIZES } from '../page.js'

const STYLE_MAP = [
  'u => u',
  'strike => s',
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh"
]

export async function importDocx (buffer) {
  const [{ value: html, messages }, page] = await Promise.all([
    mammoth.convertToHtml({ buffer }, { styleMap: STYLE_MAP }),
    readPageSetup(buffer)
  ])
  return { html, page, warnings: messages.filter((m) => m.type === 'warning').length }
}

// Page size, orientation and margins from the last section of the document.
export async function readPageSetup (buffer) {
  try {
    const zip = await JSZip.loadAsync(buffer)
    const xml = await zip.file('word/document.xml')?.async('string')
    if (!xml) return { ...DEFAULT_PAGE }
    const sections = xml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/g)
    const sect = sections?.[sections.length - 1] || ''
    const attr = (tag, name) => {
      const m = new RegExp(`<w:${tag}\\b[^>]*\\bw:${name}="([^"]+)"`).exec(sect)
      return m ? m[1] : null
    }
    const w = Number(attr('pgSz', 'w')) / 1440
    const h = Number(attr('pgSz', 'h')) / 1440
    const landscape = attr('pgSz', 'orient') === 'landscape' || (w && h && w > h)
    const short = Math.min(w, h)
    const long = Math.max(w, h)
    let size = DEFAULT_PAGE.size
    let best = Infinity
    for (const [key, s] of Object.entries(PAGE_SIZES)) {
      const d = Math.abs(s.width - short) + Math.abs(s.height - long)
      if (d < best) { best = d; size = key }
    }
    const margin = (side) => {
      const v = Number(attr('pgMar', side)) / 1440
      return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : DEFAULT_PAGE.margins[side]
    }
    return {
      ...DEFAULT_PAGE,
      size: w && h ? size : DEFAULT_PAGE.size,
      orientation: landscape ? 'landscape' : 'portrait',
      margins: { top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') },
      pageNumbers: /<w:footerReference/.test(sect)
    }
  } catch {
    return { ...DEFAULT_PAGE }
  }
}
