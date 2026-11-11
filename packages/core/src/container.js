// Every file in commonplace is a container with the same outer shape, so
// commonDrive can list, rename and share any file type without understanding
// its content:
//
//   META     - containerSchema, type, title, owner, createdAt, schemaVersion
//   AUTHORS  - Yjs clientID -> { userId } (who wrote what)
//   PEOPLE   - userId -> { name, color }, each person keeps their own entry
//              current, so renames reach every document they're part of
//   CONFLICTS - edits made apart that the owner decides (drive/parts/conflicts.js)
//   everything else - owned by the app for that type (docs, sheets...)
//
// The envelope belongs to core, so apps never touch META themselves: they
// read and set the title through title() and setTitle(), and conflicts over
// the title are handled here (envelopeUnits, resolveEnvelope).
//
// This file has no imports, so apps and the renderer can use it
// ('@commonplace/core/container').

export const CONTAINER_SCHEMA = 1
export const META = 'meta'
export const AUTHORS = 'authors'
export const PEOPLE = 'people'
export const CONFLICTS = 'conflicts'

export const title = (ydoc) => ydoc.getMap(META).get('title')
export const setTitle = (ydoc, value) => ydoc.getMap(META).set('title', value)

export function initContainer (ydoc, { type, title, owner, schemaVersion }) {
  const meta = ydoc.getMap(META)
  ydoc.transact(() => {
    meta.set('containerSchema', CONTAINER_SCHEMA)
    meta.set('type', type)
    meta.set('title', title)
    meta.set('owner', { userId: owner.userId, name: owner.name })
    meta.set('createdAt', Date.now())
    meta.set('schemaVersion', schemaVersion)
    ydoc.getMap(PEOPLE).set(owner.userId, { name: owner.name, color: owner.color })
  }, 'local')
}

// Keeps my entry in the document's people map current. Returns true if it changed.
export function updatePerson (ydoc, { userId, name, color }) {
  const people = ydoc.getMap(PEOPLE)
  const cur = people.get(userId)
  if (cur && cur.name === name && cur.color === color) return false
  people.set(userId, { name, color })
  return true
}

export function readMeta (ydoc) {
  const meta = ydoc.getMap(META)
  if (!meta.has('type')) return null // not synced from a peer yet
  const people = ydoc.getMap(PEOPLE)
  const nameOf = (userId, fallback) => people.get(userId)?.name || fallback || 'Someone'
  const contributors = new Map()
  for (const a of ydoc.getMap(AUTHORS).values()) if (a?.userId) contributors.set(a.userId, nameOf(a.userId, a.name))
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

// ---- conflicts over the envelope ------------------------------------------------

// The envelope's conflict units (the title), alongside the app's own.
export function envelopeUnits (ydoc) {
  const t = title(ydoc)
  return t == null ? new Map() : new Map([['title', { kind: 'title', sig: String(t), text: String(t), prev: null }]])
}

// The versions a decision keeps: 'v0' | 'v1' (one), 'both', or 'current'
// (none: keep what the merge produced). Only versions that still exist.
export function chosenVersions (rec, choice) {
  if (choice === 'current') return []
  const picked = choice === 'both' ? rec.versions : [rec.versions[Number(String(choice).slice(1))]].filter(Boolean)
  return picked.filter((v) => v.exists)
}

// Applies a decision on an envelope unit. False if the unit is the app's.
export function resolveEnvelope (ydoc, rec, choice) {
  if (rec.kind !== 'title') return false
  const kept = chosenVersions(rec, choice)
  if (kept.length) setTitle(ydoc, kept.map((v) => v.text).join(' / '))
  return true
}
