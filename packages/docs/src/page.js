// Page setup for paged documents. Stored in the document itself
// (ydoc.getMap('page').get('setup')), so every collaborator sees the same pages.
// Pure data, no DOM: used by the editor, the PDF printer and the .docx exporter.

export const PAGE_SIZES = {
  letter: { label: 'Letter (8.5 × 11 in)', width: 8.5, height: 11, pdf: 'Letter' },
  a4: { label: 'A4 (210 × 297 mm)', width: 8.27, height: 11.69, pdf: 'A4' },
  legal: { label: 'Legal (8.5 × 14 in)', width: 8.5, height: 14, pdf: 'Legal' }
}

export const DEFAULT_PAGE = {
  size: 'letter',
  orientation: 'portrait',
  margins: { top: 1, right: 1, bottom: 1, left: 1 }, // inches
  // A line of text at the top and bottom of every page. {page}, {pages},
  // {title} and {date} are filled in.
  header: '',
  footer: '{page}'
}

export const PAGE_FIELDS = ['page', 'pages', 'title', 'date']

// Splits header or footer text into text and fields:
// 'Page {page} of {pages}' -> ['Page ', { field: 'page' }, ' of ', { field: 'pages' }]
export function pageLine (text) {
  return String(text || '').split(/(\{(?:page|pages|title|date)\})/).filter(Boolean).map((part) => {
    const m = /^\{(page|pages|title|date)\}$/.exec(part)
    return m ? { field: m[1] } : part
  })
}

// Fills in a header or footer for one page.
export function fillPageLine (text, { page, pages, title = '', date = new Date() }) {
  return pageLine(text).map((p) => typeof p === 'string' ? p : { page: String(page), pages: String(pages), title, date: date.toLocaleDateString() }[p.field]).join('')
}

export const PX_PER_INCH = 96
export const PAGE_GAP = 28 // px between sheets on screen

export function normalizePage (setup) {
  const s = { ...DEFAULT_PAGE, ...(setup || {}) }
  s.margins = { ...DEFAULT_PAGE.margins, ...(setup?.margins || {}) }
  if (!PAGE_SIZES[s.size]) s.size = DEFAULT_PAGE.size
  if (s.orientation !== 'landscape') s.orientation = 'portrait'
  for (const k of ['top', 'right', 'bottom', 'left']) {
    const v = Number(s.margins[k])
    s.margins[k] = Number.isFinite(v) ? Math.min(Math.max(v, 0.25), 3) : 1
  }
  // Files from before headers and footers had only "page numbers: yes/no".
  if (setup && setup.footer == null && 'pageNumbers' in setup) s.footer = setup.pageNumbers ? '{page}' : ''
  s.header = String(s.header || '').slice(0, 200)
  s.footer = String(s.footer || '').slice(0, 200)
  s.pageNumbers = /\{page\}/.test(s.footer) || /\{page\}/.test(s.header)
  return s
}

// Page dimensions in inches, with orientation applied.
export function pageInches (setup) {
  const s = normalizePage(setup)
  const { width, height } = PAGE_SIZES[s.size]
  return s.orientation === 'landscape' ? { width: height, height: width } : { width, height }
}

// Everything the on-screen layout needs, in CSS pixels.
export function pageGeometry (setup) {
  const s = normalizePage(setup)
  const { width, height } = pageInches(s)
  const px = (inches) => Math.round(inches * PX_PER_INCH)
  const m = { top: px(s.margins.top), right: px(s.margins.right), bottom: px(s.margins.bottom), left: px(s.margins.left) }
  return {
    width: px(width),
    height: px(height),
    margins: m,
    contentWidth: px(width) - m.left - m.right,
    contentHeight: px(height) - m.top - m.bottom,
    gap: PAGE_GAP,
    pageNumbers: s.pageNumbers,
    header: s.header,
    footer: s.footer
  }
}

export function readPage (ydoc) {
  return normalizePage(ydoc.getMap('page').get('setup'))
}
