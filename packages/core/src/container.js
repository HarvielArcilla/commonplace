// Every file in Commonplace is a container with the same outer shape, so
// CommonDrive can list, rename and share any file type without understanding
// its content:
//
//   ydoc.getMap('meta')     - type, title, owner, createdAt, schemaVersion
//   ydoc.getMap('authors')  - Yjs clientID -> { userId, name } (who wrote what)
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
  }, 'local')
}

export function readMeta (ydoc) {
  const meta = ydoc.getMap('meta')
  if (!meta.has('type')) return null // not synced from a peer yet
  const authors = ydoc.getMap('authors')
  const contributors = new Map()
  for (const a of authors.values()) if (a?.userId) contributors.set(a.userId, a.name)
  return {
    type: meta.get('type'),
    title: meta.get('title') || 'Untitled',
    owner: meta.get('owner') || null,
    createdAt: meta.get('createdAt') || null,
    schemaVersion: meta.get('schemaVersion') || 1,
    contributors: [...contributors].map(([userId, name]) => ({ userId, name }))
  }
}
