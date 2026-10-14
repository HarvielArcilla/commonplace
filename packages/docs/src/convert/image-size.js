// Reads pixel dimensions from PNG, JPEG and GIF headers, without decoding.

export function dataUrlToBuffer (src) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(src || '')
  if (!m) return null
  const mime = m[1] || 'application/octet-stream'
  const data = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8')
  return { mime, data }
}

export function imageType (buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png'
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.length > 6 && buf.toString('ascii', 0, 3) === 'GIF') return 'gif'
  if (buf.length > 2 && buf.toString('ascii', 0, 2) === 'BM') return 'bmp'
  return null
}

export function imageSize (buf) {
  const type = imageType(buf)
  if (type === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (type === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (type === 'bmp') return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  if (type === 'jpg') {
    let off = 2
    while (off + 9 < buf.length) {
      if (buf[off] !== 0xff) { off++; continue }
      const marker = buf[off + 1]
      const len = buf.readUInt16BE(off + 2)
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
      }
      off += 2 + len
    }
  }
  return null
}
