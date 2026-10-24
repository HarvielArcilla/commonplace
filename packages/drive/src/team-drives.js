// The structures behind servers and team drives (see docs/TEAM-DRIVES.md),
// shared by the app and the server.
//
// A server document (type 'server'): owned by the server's identity, with
// its admins as managers.
//   status    the server writes: { version, startedAt, seenAt, usedBytes, freeBytes }
//   drives    the server writes: driveId -> { name, secret, at }
//   requests  admins write: id -> { kind, by, args, at, state: 'pending' }
//             and the server answers in place: state 'done' (with result)
//             or 'failed' (with error)
//
// A team drive's catalog: a shared folder owned by the server's identity,
// with meta.drive = { host } and its rules in the 'policy' map.

export const STATUS = 'status'
export const DRIVES = 'drives'
export const REQUESTS = 'requests'
export const POLICY = 'policy'

const HEX32 = /^[0-9a-f]{32}$/

// What a server can be asked to do.
export const REQUEST_KINDS = ['createDrive', 'adminLink', 'driveAdmin']

// A team drive's rules, with the defaults:
//   handover   files moved in carry the owner's handover
//   keepCopies the server keeps a read-only copy of files that leave
//   onDemand   people's computers sync the drive's files only while open
export const DEFAULT_DRIVE_POLICY = { handover: true, keepCopies: true, onDemand: false }

export function drivePolicy (catalogYdoc) {
  const p = catalogYdoc?.getMap(POLICY)
  const out = { ...DEFAULT_DRIVE_POLICY }
  if (p) for (const k of Object.keys(out)) if (typeof p.get(k) === 'boolean') out[k] = p.get(k)
  return out
}

export const serverApp = {
  type: 'server',
  kind: 'server',
  name: 'Server',
  description: 'A server you help run.',
  hidden: true, // shown in Settings → Servers, not as a file
  schemaVersion: 1,
  exports: [],
  initContent () {},
  preview () { return '' },
  thumbnail () { return null },
  history: { roots: [] }
}

// What a server document says, checked.
export function readServerDoc (ydoc) {
  const s = ydoc.getMap(STATUS)
  const num = (k) => (Number.isFinite(s.get(k)) ? s.get(k) : null)
  const drives = []
  for (const [id, d] of ydoc.getMap(DRIVES).entries()) {
    if (!HEX32.test(id) || !d || typeof d.secret !== 'string') continue
    drives.push({ id, name: typeof d.name === 'string' ? d.name.slice(0, 120) : 'Team drive', secret: d.secret, at: Number(d.at) || 0 })
  }
  return {
    status: {
      version: typeof s.get('version') === 'string' ? s.get('version').slice(0, 20) : null,
      startedAt: num('startedAt'),
      seenAt: num('seenAt'),
      usedBytes: num('usedBytes'),
      freeBytes: num('freeBytes')
    },
    drives: drives.sort((a, b) => a.at - b.at)
  }
}
