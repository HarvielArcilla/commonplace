// .pptx import for commonSlides (runs in the background process). Reads
// the slides' own XML: text boxes, placeholders (with positions inherited
// from the layout and master), shapes, pictures, tables as text, solid
// backgrounds, theme colors and fonts, and speaker notes.
//
// A .pptx is a zip from anywhere, so it's read defensively: limited in
// size, slide count, unpacked bytes and image sizes, and nothing in it is
// ever run. What can't be carried over (charts, SmartArt, video, pictures
// in unusual formats) is counted in `warnings`.

import JSZip from 'jszip'
import { DOMParser } from '@xmldom/xmldom'
import * as Y from 'yjs'
import { SLIDES, SLIDE_DATA, DECK, WIDTH, HEIGHT } from './model.js'

export const MAX_PPTX_BYTES = 200 * 1024 * 1024
const MAX_UNPACKED_BYTES = 400 * 1024 * 1024
const MAX_SLIDES = 500
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGES_BYTES = 60 * 1024 * 1024
const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

const newId = () => Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6)

// ---- XML helpers ------------------------------------------------------------------

const parse = (text) => new DOMParser({ onError: () => {} }).parseFromString(text, 'text/xml')
const all = (nodes) => Array.from(nodes || []) // xmldom's node lists aren't iterable
const kids = (node, name) => (node ? all(node.childNodes).filter((n) => n.nodeType === 1 && (!name || n.nodeName === name)) : [])
const kid = (node, name) => kids(node, name)[0] || null
// A path of child names: path(sp, 'p:spPr', 'a:xfrm', 'a:off').
const path = (node, ...names) => names.reduce((n, name) => kid(n, name), node)
const attr = (node, name) => node?.getAttribute?.(name) || null
const num = (v, d = 0) => (v == null || v === '' || !Number.isFinite(Number(v)) ? d : Number(v))

function resolvePath (from, target) {
  if (target.startsWith('/')) return target.slice(1)
  const parts = from.split('/').slice(0, -1)
  for (const p of target.split('/')) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p) }
  return parts.join('/')
}

// ---- the package ----------------------------------------------------------------------

export async function importPptx (ydoc, bytes) {
  if (bytes.length > MAX_PPTX_BYTES) throw new Error('That presentation is over 200 MB.')
  let zip
  try { zip = await JSZip.loadAsync(bytes) } catch { throw new Error('That file isn’t a PowerPoint presentation.') }
  let unpacked = 0
  for (const f of Object.values(zip.files)) unpacked += f._data?.uncompressedSize || 0
  if (unpacked > MAX_UNPACKED_BYTES) throw new Error('That presentation unpacks to more than 400 MB.')

  const read = async (name) => { const f = zip.file(name); return f ? f.async('string') : null }
  const xml = async (name) => { const t = await read(name); return t ? parse(t) : null }
  const relsCache = new Map()
  const rels = async (part) => {
    if (relsCache.has(part)) return relsCache.get(part)
    const dir = part.split('/').slice(0, -1).join('/')
    const doc = await xml(`${dir}/_rels/${part.split('/').pop()}.rels`)
    const out = new Map()
    for (const r of doc ? all(doc.getElementsByTagName('Relationship')) : []) {
      out.set(attr(r, 'Id'), { type: (attr(r, 'Type') || '').split('/').pop(), target: attr(r, 'TargetMode') === 'External' ? null : resolvePath(part, attr(r, 'Target') || '') })
    }
    relsCache.set(part, out)
    return out
  }

  const pres = await xml('ppt/presentation.xml')
  if (!pres) throw new Error('That file isn’t a PowerPoint presentation.')
  const size = pres.getElementsByTagName('p:sldSz')[0]
  const cx = num(attr(size, 'cx'), 12192000)
  const cy = num(attr(size, 'cy'), 6858000)
  const k = Math.min(WIDTH / cx, HEIGHT / cy)
  const geo = { k, ox: (WIDTH - cx * k) / 2, oy: (HEIGHT - cy * k) / 2 }

  const presRels = await rels('ppt/presentation.xml')
  const slideParts = all(pres.getElementsByTagName('p:sldId')).map((s) => presRels.get(attr(s, 'r:id'))?.target).filter(Boolean)
  const warnings = { count: 0 }
  if (slideParts.length > MAX_SLIDES) { warnings.count += slideParts.length - MAX_SLIDES; slideParts.length = MAX_SLIDES }

  const firstMaster = [...presRels.values()].find((r) => r.type === 'slideMaster')?.target
  const themePart = [...presRels.values()].find((r) => r.type === 'theme')?.target ||
    (firstMaster && [...(await rels(firstMaster)).values()].find((r) => r.type === 'theme')?.target)
  const theme = readTheme(themePart ? await xml(themePart) : null)

  const images = { bytes: 0 }
  const imageData = async (part) => {
    const ext = part.split('.').pop().toLowerCase()
    const file = zip.file(part)
    if (!file || !IMAGE_TYPES[ext]) return null
    const data = await file.async('nodebuffer')
    if (data.length > MAX_IMAGE_BYTES || images.bytes + data.length > MAX_IMAGES_BYTES) return null
    images.bytes += data.length
    return `data:${IMAGE_TYPES[ext]};base64,${data.toString('base64')}`
  }

  const slides = []
  for (const part of slideParts) {
    const doc = await xml(part)
    if (!doc) { warnings.count++; continue }
    const r = await rels(part)
    const layoutPart = [...r.values()].find((x) => x.type === 'slideLayout')?.target
    const layout = layoutPart ? await xml(layoutPart) : null
    const masterPart = layoutPart ? [...(await rels(layoutPart)).values()].find((x) => x.type === 'slideMaster')?.target : null
    const master = masterPart ? await xml(masterPart) : null
    const ctx = { geo, theme, rels: r, layout, master, imageData, warnings }
    const notesPart = [...r.values()].find((x) => x.type === 'notesSlide')?.target
    slides.push({
      bg: background(doc, theme) || background(layout, theme) || background(master, theme) || '#ffffff',
      elements: await shapes(path(doc.documentElement, 'p:cSld', 'p:spTree'), ctx, identity),
      notes: notesPart ? notesText(await xml(notesPart)) : ''
    })
  }
  if (!slides.length) throw new Error('That presentation has no slides commonplace can read.')

  ydoc.transact(() => {
    const order = ydoc.getArray(SLIDES)
    if (order.length) order.delete(0, order.length)
    const data = ydoc.getMap(SLIDE_DATA)
    for (const key of [...data.keys()]) data.delete(key)
    const deck = ydoc.getMap(DECK)
    deck.set('font', theme.font)
    deck.set('fg', theme.colors.dk1 || '#1f2430')
    deck.delete('title')
    for (const s of slides) {
      const id = newId()
      const slide = new Y.Map()
      data.set(id, slide)
      slide.set('bg', s.bg)
      const elements = new Y.Map()
      slide.set('elements', elements)
      const notes = new Y.Text()
      slide.set('notes', notes)
      if (s.notes) notes.insert(0, s.notes)
      s.elements.forEach((e, z) => {
        const m = new Y.Map()
        elements.set(newId(), m)
        const { paragraphs, ...props } = e
        for (const [key, value] of Object.entries({ ...props, z: z + 1 })) if (value != null) m.set(key, value)
        if (paragraphs) m.set('text', fragment(paragraphs))
      })
      order.push([id])
    }
  })
  return { slides: slides.length, warnings: warnings.count }
}

// ---- theme, colors and backgrounds -------------------------------------------------------

function readTheme (doc) {
  const colors = {}
  const scheme = doc?.getElementsByTagName('a:clrScheme')[0]
  for (const c of kids(scheme)) {
    const name = c.nodeName.replace('a:', '')
    const v = attr(kid(c, 'a:srgbClr'), 'val') || attr(kid(c, 'a:sysClr'), 'lastClr')
    if (v) colors[name] = `#${v.toLowerCase()}`
  }
  const face = attr(path(doc?.getElementsByTagName('a:minorFont')[0], 'a:latin'), 'typeface')
  const font = face && /^[\w .-]+$/.test(face) ? `"${face}", Arial, Helvetica, sans-serif` : 'Arial, Helvetica, sans-serif'
  return { colors, font }
}

const SCHEME = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }

// The color inside a fill-like element (a:solidFill and friends).
function color (node, theme) {
  if (!node) return null
  const srgb = kid(node, 'a:srgbClr')
  if (srgb && /^[0-9a-f]{6}$/i.test(attr(srgb, 'val'))) return `#${attr(srgb, 'val').toLowerCase()}`
  const sys = kid(node, 'a:sysClr')
  if (sys && /^[0-9a-f]{6}$/i.test(attr(sys, 'lastClr'))) return `#${attr(sys, 'lastClr').toLowerCase()}`
  const scheme = kid(node, 'a:schemeClr')
  if (scheme) { const v = attr(scheme, 'val'); return theme.colors[SCHEME[v] || v] || null }
  return null
}

function background (doc, theme) {
  const bg = doc && path(doc.documentElement, 'p:cSld', 'p:bg')
  if (!bg) return null
  return color(path(bg, 'p:bgPr', 'a:solidFill'), theme) || color(kid(bg, 'p:bgRef'), theme)
}

// ---- shapes ------------------------------------------------------------------------------

const identity = (x, y, w, h) => ({ x, y, w, h })

async function shapes (tree, ctx, place) {
  const out = []
  for (const node of kids(tree)) {
    if (node.nodeName === 'p:sp') {
      const e = shape(node, ctx, place)
      if (e) out.push(e)
    } else if (node.nodeName === 'p:pic') {
      const e = await picture(node, ctx, place)
      if (e) out.push(e)
    } else if (node.nodeName === 'p:grpSp') {
      out.push(...await shapes(node, ctx, groupPlace(node, place)))
    } else if (node.nodeName === 'p:graphicFrame') {
      const e = table(node, ctx, place)
      if (e) out.push(e)
      else ctx.warnings.count++
    }
  }
  return out
}

// A group maps its children's coordinates (chOff/chExt) onto its own box.
function groupPlace (grp, place) {
  const xf = path(grp, 'p:grpSpPr', 'a:xfrm')
  const off = kid(xf, 'a:off')
  const ext = kid(xf, 'a:ext')
  const chOff = kid(xf, 'a:chOff')
  const chExt = kid(xf, 'a:chExt')
  if (!off || !ext || !chExt) return place
  const sx = num(attr(ext, 'cx')) / (num(attr(chExt, 'cx')) || 1)
  const sy = num(attr(ext, 'cy')) / (num(attr(chExt, 'cy')) || 1)
  return (x, y, w, h) => place(num(attr(off, 'x')) + (x - num(attr(chOff, 'x'))) * sx, num(attr(off, 'y')) + (y - num(attr(chOff, 'y'))) * sy, w * sx, h * sy)
}

function box (xfrm, ctx, place) {
  const off = kid(xfrm, 'a:off')
  const ext = kid(xfrm, 'a:ext')
  if (!off || !ext) return null
  const p = place(num(attr(off, 'x')), num(attr(off, 'y')), num(attr(ext, 'cx')), num(attr(ext, 'cy')))
  const { k, ox, oy } = ctx.geo
  return { x: Math.round(ox + p.x * k), y: Math.round(oy + p.y * k), w: Math.max(4, Math.round(p.w * k)), h: Math.max(4, Math.round(p.h * k)) }
}

// The layout's (or master's) shape for a placeholder: same idx, else same type.
function inherited (ph, ctx) {
  if (!ph) return null
  const type = attr(ph, 'type') || 'body'
  const idx = attr(ph, 'idx')
  for (const doc of [ctx.layout, ctx.master]) {
    const shapesIn = doc ? all(doc.getElementsByTagName('p:sp')) : []
    const phOf = (sp) => path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')
    const match = shapesIn.find((sp) => idx != null && attr(phOf(sp), 'idx') === idx) ||
      shapesIn.find((sp) => phOf(sp) && (attr(phOf(sp), 'type') || 'body') === type) ||
      (type === 'ctrTitle' && shapesIn.find((sp) => attr(phOf(sp), 'type') === 'title')) ||
      (type === 'subTitle' && shapesIn.find((sp) => (attr(phOf(sp), 'type') || 'body') === 'body'))
    if (match && path(match, 'p:spPr', 'a:xfrm')) return match
  }
  return null
}

const ROLES = { title: 'title', ctrTitle: 'title', body: 'body', subTitle: 'body', obj: 'body' }
const DEFAULT_SIZES = { title: 44, ctrTitle: 54, subTitle: 24, body: 28 }
const PRESETS = { rect: 'rect', roundRect: 'round', ellipse: 'ellipse' }

function shape (sp, ctx, place) {
  const ph = path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph')
  const phType = ph ? attr(ph, 'type') || 'body' : null
  const parent = inherited(ph, ctx)
  const at = box(path(sp, 'p:spPr', 'a:xfrm'), ctx, place) || (parent && box(path(parent, 'p:spPr', 'a:xfrm'), ctx, identity))
  if (!at) return null
  if (['dt', 'ftr', 'sldNum'].includes(phType)) return null // date, footer and number placeholders
  const spPr = kid(sp, 'p:spPr')
  // Colors set on the shape, or else by its style (the theme's look for shapes).
  const style = kid(sp, 'p:style')
  const fill = kid(spPr, 'a:noFill') ? null : color(kid(spPr, 'a:solidFill'), ctx.theme) || color(kid(style, 'a:fillRef'), ctx.theme)
  const ln = kid(spPr, 'a:ln')
  const stroke = kid(ln, 'a:noFill') ? null : color(kid(ln, 'a:solidFill'), ctx.theme) || color(kid(style, 'a:lnRef'), ctx.theme)
  const prst = attr(kid(spPr, 'a:prstGeom'), 'prst')
  const body = kid(sp, 'p:txBody')
  const paragraphs = readParagraphs(body, ctx, { bullets: phType === 'body' || phType === 'obj' })
  const hasText = paragraphs.some((p) => p.runs.some((r) => r.text.trim()))
  const isShape = !ph && (fill || stroke)
  if (!isShape && !hasText) return null
  const anchor = attr(kid(body, 'a:bodyPr'), 'anchor') || attr(kid(parent && kid(parent, 'p:txBody'), 'a:bodyPr'), 'anchor')
  const firstSize = paragraphs.flatMap((p) => p.runs).find((r) => r.size)?.size
  // Runs in the box's own size and the theme's text color follow the box
  // and the deck, so later changes to either reach them.
  for (const r of paragraphs.flatMap((p) => p.runs)) {
    if (r.size && Math.abs(r.size - firstSize) < 0.5) r.size = null
    if (r.color && r.color === ctx.theme.colors.dk1) r.color = null
  }
  return {
    type: isShape ? 'shape' : 'text',
    role: ROLES[phType] || null,
    ...at,
    shape: isShape ? PRESETS[prst] || 'rect' : null,
    fill: isShape ? fill : null,
    stroke: isShape ? stroke : null,
    size: Math.round(firstSize || DEFAULT_SIZES[phType] || 18),
    align: paragraphs[0]?.align || (phType === 'ctrTitle' || phType === 'subTitle' || isShape ? 'center' : 'left'),
    valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : isShape ? 'middle' : 'top',
    paragraphs
  }
}

const ALIGN = { l: 'left', ctr: 'center', r: 'right', just: 'left' }

// [{ bullet, align, runs: [{ text, bold, italic, underline, color, size, br }] }]
function readParagraphs (body, ctx, { bullets }) {
  const out = []
  for (const p of kids(body, 'a:p')) {
    const pPr = kid(p, 'a:pPr')
    const bullet = kid(pPr, 'a:buNone') ? null : kid(pPr, 'a:buAutoNum') ? 'number' : kid(pPr, 'a:buChar') || bullets ? 'bullet' : null
    const runs = []
    for (const r of kids(p)) {
      if (r.nodeName === 'a:br') { runs.push({ text: '', br: true }); continue }
      if (r.nodeName !== 'a:r' && r.nodeName !== 'a:fld') continue
      const rPr = kid(r, 'a:rPr')
      const text = kid(r, 'a:t')?.textContent || ''
      if (!text) continue
      runs.push({
        text,
        bold: attr(rPr, 'b') === '1',
        italic: attr(rPr, 'i') === '1',
        underline: Boolean(attr(rPr, 'u')) && attr(rPr, 'u') !== 'none',
        color: color(kid(rPr, 'a:solidFill'), ctx.theme),
        size: attr(rPr, 'sz') ? num(attr(rPr, 'sz')) / 100 * ctx.geo.k * 12700 : null
      })
    }
    const empty = !runs.some((r) => r.text)
    out.push({ bullet: empty ? null : bullet, align: ALIGN[attr(pPr, 'algn')] || null, runs })
  }
  return out
}

async function picture (pic, ctx, place) {
  const at = box(path(pic, 'p:spPr', 'a:xfrm'), ctx, place)
  const embed = attr(path(pic, 'p:blipFill', 'a:blip'), 'r:embed')
  const target = embed && ctx.rels.get(embed)?.target
  const src = target ? await ctx.imageData(target) : null
  if (!at || !src) { ctx.warnings.count++; return null }
  return { type: 'image', ...at, src, alt: attr(path(pic, 'p:nvPicPr', 'p:cNvPr'), 'descr') || '' }
}

// Tables come over as text, a row per line.
function table (frame, ctx, place) {
  const tbl = frame.getElementsByTagName('a:tbl')[0]
  if (!tbl) return null
  const at = box(kid(frame, 'p:xfrm'), ctx, place)
  if (!at) return null
  const paragraphs = kids(tbl, 'a:tr').map((tr) => ({
    bullet: null,
    align: null,
    runs: [{ text: kids(tr, 'a:tc').map((tc) => all(tc.getElementsByTagName('a:t')).map((t) => t.textContent).join('')).join('   ·   ') }]
  }))
  ctx.warnings.count++
  return { type: 'text', role: null, ...at, size: 16, align: 'left', valign: 'top', paragraphs }
}

function notesText (doc) {
  for (const sp of doc ? all(doc.getElementsByTagName('p:sp')) : []) {
    if (attr(path(sp, 'p:nvSpPr', 'p:nvPr', 'p:ph'), 'type') !== 'body') continue
    return kids(kid(sp, 'p:txBody'), 'a:p').map((p) => all(p.getElementsByTagName('a:t')).map((t) => t.textContent).join('')).join('\n').trim()
  }
  return ''
}

// ---- into the editor's rich text ------------------------------------------------------------

// Paragraphs as the Y.XmlFragment the slide text editor uses: paragraphs,
// bullet and numbered lists, and bold/italic/underline/textStyle marks.
function fragment (paragraphs) {
  const frag = new Y.XmlFragment()
  let list = null
  let kind = null
  let blocks = 0
  let items = 0
  for (const p of paragraphs) {
    const para = new Y.XmlElement('paragraph')
    const nodes = []
    let text = null
    let length = 0 // (a type that isn't in a document yet can't be asked)
    for (const r of p.runs) {
      if (r.br) { nodes.push(new Y.XmlElement('hardBreak')); text = null; continue }
      if (!text) { text = new Y.XmlText(); nodes.push(text); length = 0 }
      const marks = {}
      if (r.bold) marks.bold = {}
      if (r.italic) marks.italic = {}
      if (r.underline) marks.underline = {}
      if (r.color || r.size) marks.textStyle = { color: r.color || null, fontSize: r.size ? `${Math.round(r.size)}px` : null }
      text.insert(length, r.text, marks)
      length += r.text.length
    }
    para.insert(0, nodes)
    if (p.bullet) {
      const next = p.bullet === 'number' ? 'orderedList' : 'bulletList'
      if (!list || kind !== next) { kind = next; list = new Y.XmlElement(kind); frag.insert(blocks++, [list]); items = 0 }
      const item = new Y.XmlElement('listItem')
      item.insert(0, [para])
      list.insert(items++, [item])
    } else {
      list = null
      frag.insert(blocks++, [para])
    }
  }
  if (!blocks) frag.insert(0, [new Y.XmlElement('paragraph')])
  return frag
}
