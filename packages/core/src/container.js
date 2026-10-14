// Every file in Commonplace is a container with the same outer shape, so
// CommonDrive can list, rename and share any file type without understanding
// its content:
//
//   ydoc.getMap('meta')     - type, title, owner, createdAt, schemaVersion
//   ydoc.getMap('authors')  - Yjs clientID -> { userId } (who wrote what)
//   ydoc.getMap('people')   - userId -> { name, color }, each person keeps
//                             their own entry current, so renames reach
//                             every document they're part of
//   everything else         - owned by the app for that type (docs, sheets...)

export const CONTAINER_SCHEMA = 1

export function initContainer (ydoc, { type, title, owner, schemaVersion }) {
  const meta = ydoc.getMap('meta')
  ydoc.transact(() => {
    meta.set('containerSchema', CONTAINER_SCHEMA)
    meta.set('type', type)
    meta.set('title', title)
    meta.set('owner', { userId: owner.userId, name: owner.name })
    meta.set('createdAt', Date.now())
    meta.set('schemaVersion', schemaVersion)
    ydoc.getMap('people').set(owner.userId, { name: owner.name, color: owner.color })
  }, 'local')
}

// Keeps my entry in the document's people map current. Returns true if it changed.
export function updatePerson (ydoc, { userId, name, color }) {
  const people = ydoc.getMap('people')
  const cur = people.get(userId)
  if (cur && cur.name === name && cur.color === color) return false
  people.set(userId, { name, color })
  return true
}

export function readMeta (ydoc) {
  const meta = ydoc.getMap('meta')
  if (!meta.has('type')) return null // not synced from a peer yet
  const people = ydoc.getMap('people')
  const nameOf = (userId, fallback) => people.get(userId)?.name || fallback || 'Someone'
  const contributors = new Map()
  for (const a of ydoc.getMap('authors').values()) if (a?.userId) contributors.set(a.userId, nameOf(a.userId, a.name))
  const owner = meta.get('owner') || null
  return {
    type: meta.get('type'),
    title: meta.get('title') || 'Untitled',
    owner: owner ? { userId: owner.userId, name: nameOf(owner.userId, owner.name) } : null,
    createdAt: meta.get('createdAt') || null,
    schemaVersion: meta.get('schemaVersion') || 1,
    contributors: [...contributors].map(([userId, name]) => ({ userId, name }))
  }
}
