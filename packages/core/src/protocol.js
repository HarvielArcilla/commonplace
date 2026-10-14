// Wire format. Transport-agnostic: anything that is a duplex byte stream works
// (a Hyperswarm socket today, a relay WebSocket or LAN TCP socket later).
//
//   frame   = u32 length | u8 type | 16-byte docId | payload
//   payload = AES-256-GCM sealed with the document's encKey
//
// One connection can carry many documents, because Hyperswarm keeps a single
// connection per pair of peers no matter how many topics they share.

export const PROTOCOL_VERSION = 1

export const MSG = {
  HELLO: 1, // sealed(u32 jsonLen | json {userId, name, color} | stateVector)
  UPDATE: 2, // sealed(Yjs update)
  ACK: 3, // sealed(stateVector) - "this is everything I have now"
  AWARENESS: 4 // sealed(y-protocols awareness update) - cursors and presence
}

const MAX_FRAME = 64 * 1024 * 1024

export function encodeFrame (type, docId, payload) {
  const frame = Buffer.alloc(4 + 1 + 16 + payload.length)
  frame.writeUInt32BE(1 + 16 + payload.length, 0)
  frame.writeUInt8(type, 4)
  Buffer.from(docId, 'hex').copy(frame, 5)
  Buffer.from(payload).copy(frame, 21)
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
      if (len < 17 || len > MAX_FRAME) throw new Error('invalid frame length')
      if (this.buf.length < 4 + len) return
      const type = this.buf.readUInt8(4)
      const docId = this.buf.subarray(5, 21).toString('hex')
      const payload = this.buf.subarray(21, 4 + len)
      this.buf = this.buf.subarray(4 + len)
      this.onFrame(type, docId, payload)
    }
  }
}

export function encodeHello (user, stateVector) {
  const json = Buffer.from(JSON.stringify({ v: PROTOCOL_VERSION, ...user }))
  const head = Buffer.alloc(4)
  head.writeUInt32BE(json.length)
  return Buffer.concat([head, json, Buffer.from(stateVector)])
}

export function decodeHello (plain) {
  const len = plain.readUInt32BE(0)
  const user = JSON.parse(plain.subarray(4, 4 + len).toString('utf8'))
  return { user, stateVector: plain.subarray(4 + len) }
}
