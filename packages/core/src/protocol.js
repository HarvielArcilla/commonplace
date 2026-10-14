// Wire format. Transport-agnostic: anything that is a duplex byte stream works
// (a Hyperswarm socket today, a relay or LAN socket later).
//
//   frame   = u32 length | u8 type | 16-byte docId | u32 epoch | payload
//   payload = AES-256-GCM sealed with that epoch's key for the document
//
// One connection can carry many documents, because Hyperswarm keeps a single
// connection per pair of peers no matter how many topics they share.

export const PROTOCOL_VERSION = 2

export const MSG = {
  HELLO: 1, // sealed(u32 jsonLen | json | stateVector) - who I am, proof of it, what I have
  UPDATE: 2, // sealed(Yjs update)
  ACK: 3, // sealed(stateVector) - "this is everything I have now"
  AWARENESS: 4, // sealed(y-protocols awareness update) - cursors and presence
  MEMBERS: 5, // sealed(json membership log)
  LEAVE: 6 // sealed(empty) - "I've stopped syncing this document for now"
}

const HEADER = 4 + 1 + 16 + 4
const MAX_FRAME = 64 * 1024 * 1024

export function encodeFrame (type, docId, epoch, payload) {
  const frame = Buffer.alloc(HEADER + payload.length)
  frame.writeUInt32BE(HEADER - 4 + payload.length, 0)
  frame.writeUInt8(type, 4)
  Buffer.from(docId, 'hex').copy(frame, 5)
  frame.writeUInt32BE(epoch, 21)
  Buffer.from(payload).copy(frame, HEADER)
  return frame
}

export class FrameReader {
  constructor (onFrame) {
    this.onFrame = onFrame
    this.buf = Buffer.alloc(0)
  }

  push (chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk)
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0)
      if (len < HEADER - 4 || len > MAX_FRAME) throw new Error('invalid frame length')
      if (this.buf.length < 4 + len) return
      const type = this.buf.readUInt8(4)
      const docId = this.buf.subarray(5, 21).toString('hex')
      const epoch = this.buf.readUInt32BE(21)
      const payload = this.buf.subarray(HEADER, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      this.onFrame(type, docId, epoch, payload)
    }
  }
}

export function encodeHello (info, stateVector) {
  const json = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, ...info }))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(json.length)
  return Buffer.concat([head, json, Buffer.from(stateVector)])
}

export function decodeHello (plain) {
  const len = plain.readUInt32BE(0)
  const info = JSON.parse(plain.subarray(4, 4 + len).toString('utf8'))
  return { info, stateVector: plain.subarray(4 + len) }
}

// What a HELLO signature covers: this document, this epoch, and the Noise key
// of the connection it was sent on, so it can't be replayed elsewhere.
export function helloProof (docId, epoch, connectionKeyHex, encPublic) {
  return `commonplace/hello/v2|${docId}|${epoch}|${connectionKeyHex || ''}|${encPublic || ''}`
}
