// A cloud's roster: the signed list of a group's people, admins, groups,
// hosts and rules (docs/MODEL.md). It is a chain (chain.js) whose first
// entry is signed by the cloud's own key, and everything after by its
// admins. Nobody issues it and no server keeps it: every member holds a
// copy and checks every entry.
//
//   create  - generation `gen` of the cloud: its key (`cloud`), name and
//             first admins. Signed by the cloud's key, which is then sealed
//             with the cloud's recovery key and deleted.
//   member  - add someone, or change their role (member, admin, host)
//   remove  - take someone out (never the last admin)
//   group   - create or replace a group: id, name, members
//   ungroup - delete a group
//   host    - what a host is: relay or server, and where to reach it
//   rule    - set one of the cloud's rules
//   nodes   - the cloud's own bootstrap nodes ("host:port")
//   rename  - the cloud's name
//
// Recovery: a `create` with a higher gen, signed by the same cloud key
// (opened with the recovery key), starts a new chain that replaces the old
// one, for when admins' keys are lost or admins removed each other.

import { Chain } from './chain.js'
import { isHex64 } from './ids.js'

export const ROSTER_ROLES = ['member', 'admin', 'host']
export const HOST_KINDS = ['relay', 'server']
const GROUP_ID = /^[a-z0-9-]{1,32}$/
const NODE = /^[A-Za-z0-9.:[\]-]{1,253}:\d{1,5}$/
const MAX_MEMBERS = 10000
const MAX_RULE_BYTES = 1024
const cleanName = (v, max = 60) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max)

function emptyState (docId) {
  return {
    docId,
    cloud: null, // the cloud's key: the roster's ID
    gen: 0,
    name: '',
    members: new Map(), // userId -> { role, enc }
    groups: new Map(), // id -> { name, members: Set(userId) }
    hosts: new Map(), // userId -> { kind, address }
    rules: new Map(), // key -> value
    nodes: []
  }
}

const admins = (s) => [...s.members].filter(([, m]) => m.role === 'admin').map(([userId]) => userId)

function apply (s, e, i) {
  switch (e.type) {
    case 'create':
      if (i !== 0 || !isHex64(e.cloud) || !Number.isInteger(e.gen) || e.gen < 1) throw new Error('bad create')
      if (!Array.isArray(e.admins) || !e.admins.length) throw new Error('a cloud needs an admin')
      s.cloud = e.cloud
      s.gen = e.gen
      s.name = cleanName(e.name) || 'Cloud'
      for (const a of e.admins) {
        if (!isHex64(a.userId) || !isHex64(a.enc)) throw new Error('bad admin')
        s.members.set(a.userId, { role: 'admin', enc: a.enc })
      }
      break
    case 'member': {
      if (!isHex64(e.userId) || !ROSTER_ROLES.includes(e.role)) throw new Error('bad member')
      const prev = s.members.get(e.userId)
      const enc = isHex64(e.enc) ? e.enc : prev?.enc
      if (!enc) throw new Error('a member needs an encryption key')
      if (!prev && s.members.size >= MAX_MEMBERS) throw new Error('too many members')
      if (prev?.role === 'admin' && e.role !== 'admin' && admins(s).length === 1) throw new Error('a cloud keeps at least one admin')
      s.members.set(e.userId, { role: e.role, enc })
      if (e.role !== 'host') s.hosts.delete(e.userId)
      break
    }
    case 'remove':
      if (!s.members.has(e.userId)) throw new Error('not a member')
      if (s.members.get(e.userId).role === 'admin' && admins(s).length === 1) throw new Error('a cloud keeps at least one admin')
      s.members.delete(e.userId)
      s.hosts.delete(e.userId)
      for (const g of s.groups.values()) g.members.delete(e.userId)
      break
    case 'group':
      if (!GROUP_ID.test(String(e.id)) || !Array.isArray(e.members)) throw new Error('bad group')
      s.groups.set(e.id, { name: cleanName(e.name) || e.id, members: new Set(e.members.filter((u) => s.members.has(u))) })
      break
    case 'ungroup':
      s.groups.delete(e.id)
      break
    case 'host':
      if (s.members.get(e.userId)?.role !== 'host' || !HOST_KINDS.includes(e.kind)) throw new Error('bad host')
      s.hosts.set(e.userId, { kind: e.kind, address: typeof e.address === 'string' ? e.address.slice(0, 200) : null })
      break
    case 'rule':
      if (typeof e.key !== 'string' || !/^[a-zA-Z]{1,40}$/.test(e.key)) throw new Error('bad rule')
      if (e.value === undefined || e.value === null) s.rules.delete(e.key)
      else if (JSON.stringify(e.value).length <= MAX_RULE_BYTES) s.rules.set(e.key, e.value)
      else throw new Error('rule too large')
      break
    case 'nodes':
      if (!Array.isArray(e.nodes)) throw new Error('bad nodes')
      s.nodes = e.nodes.filter((n) => typeof n === 'string' && NODE.test(n)).slice(0, 16)
      break
    case 'rename':
      s.name = cleanName(e.name) || s.name
      break
    default:
      // From a newer app: skipped, unless it limits who may do what.
      if (typeof e.type !== 'string') throw new Error('bad entry')
      if (e.critical) s.needsNewer = true
  }
}

const ROSTER = {
  prefix: 'commonplace/roster/v1',
  empty: emptyState,
  maySign: (s, e, i) => (i === 0 ? e.type === 'create' && e.by === e.cloud : s.members.get(e.by)?.role === 'admin'),
  apply
}

export class Roster extends Chain {
  constructor (docId, entries = []) {
    super(ROSTER, docId, entries)
  }

  // Starts a cloud. cloudKey: a keySigner (identity.js) for the cloud's own
  // key; admins: [{ userId, enc }].
  static create (cloudKey, docId, { name, admins: first, gen = 1 }) {
    const r = new Roster(docId)
    r.start(cloudKey, { type: 'create', cloud: cloudKey.userId, gen, name, admins: first })
    return r
  }

  get cloud () { return this.state.cloud }
  get gen () { return this.state.gen }
  get name () { return this.state.name }
  get nodes () { return [...this.state.nodes] }
  get needsNewer () { return Boolean(this.state.needsNewer) }

  // A newer generation (recovery) replaces this chain whole, if the same
  // cloud key signed it. Otherwise copies merge as chains do.
  merge (entries) {
    const first = Array.isArray(entries) ? entries[0] : null
    if (this.exists && first && first.type === 'create' && first.gen > this.gen) {
      if (first.by !== this.cloud) return false
      const next = new Roster(this.docId)
      if (!Chain.prototype.merge.call(next, entries)) return false
      this.entries = next.entries
      this.state = next.state
      this.dropped = []
      return true
    }
    if (this.exists && first && first.type === 'create' && first.gen < this.gen) return false
    return super.merge(entries)
  }

  // ---- reading ---------------------------------------------------------------

  member (userId) { return this.state.members.get(userId) || null }
  role (userId) { return this.member(userId)?.role || null }
  isAdmin (userId) { return this.role(userId) === 'admin' }
  admins () { return admins(this.state) }
  members () { return [...this.state.members].map(([userId, m]) => ({ userId, ...m })) }
  groups () { return [...this.state.groups].map(([id, g]) => ({ id, name: g.name, members: [...g.members] })) }
  groupsOf (userId) { return [...this.state.groups].filter(([, g]) => g.members.has(userId)).map(([id]) => id) }
  hosts () { return [...this.state.hosts].map(([userId, h]) => ({ userId, ...h })) }
  rule (key) { return this.state.rules.get(key) ?? null }

  // ---- changing (by an admin; each returns the entry) ---------------------------

  setMember (identity, { userId, enc, role = 'member' }) { return this.append(identity, { type: 'member', userId, enc, role }) }
  remove (identity, userId) { return this.append(identity, { type: 'remove', userId }) }
  setGroup (identity, { id, name, members }) { return this.append(identity, { type: 'group', id, name, members }) }
  removeGroup (identity, id) { return this.append(identity, { type: 'ungroup', id }) }
  setHost (identity, { userId, kind, address }) { return this.append(identity, { type: 'host', userId, kind, address }) }
  setRule (identity, key, value) { return this.append(identity, { type: 'rule', key, value }) }
  setNodes (identity, nodes) { return this.append(identity, { type: 'nodes', nodes }) }
  rename (identity, name) { return this.append(identity, { type: 'rename', name }) }

  append (identity, body) {
    if (!this.isAdmin(identity.userId)) throw new Error('Only the cloud’s admins can change it.')
    return super.append(identity, body)
  }
}
