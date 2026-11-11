# The model

How access, keys and ownership work once commonplace grows from people
sharing files to groups running their own clouds. This is the design for
phase 1 of the vision; it replaces the team drives in
[TEAM-DRIVES.md](TEAM-DRIVES.md), which were never released.

Status: **design, being built.** Sections say what exists today.

## Names

Names in the schema say what a structure is. Names in the app can change
without touching the schema.

| In the schema | In the app | What it is |
| --- | --- | --- |
| identity | you, a person, a server | A key pair a computer makes for itself (core/identity.js, core/devices.js). |
| roster | a cloud | The signed list of a group's people, admins, groups, hosts and rules. |
| drive | a shared drive | A document whose membership log decides who has the files in it. Belongs to a roster. |
| folder | a shared folder | A document listing files, in someone's My Drive, shared with people. |
| file | a file | A document: a doc, sheet, deck, upload… |
| index | My Drive | A person's private list of their files and folders (no members). |

## One rule for authority

**A document's authority never changes during its life.** Who may sign its
membership, and where its keys come from, is fixed when it's made:

- A file in My Drive or a shared folder has **its own membership log**, owned by a person (as today).
- A file in a drive has **no log of its own**: the drive's log decides who has it, and its keys come from the drive's keys.
- A drive's log is owned by its roster: the roster's admins sign it.

So moving a file between My Drive and a drive makes **a new document**: the
content (with its whole history) is copied into a document of the right
kind, and the old one is closed with `meta.movedTo`. Links to the old one
lead to the new one for people who can open it. Nothing ever has to
re-check a log against a different authority, and old apps never meet a
log whose rules changed under them.

## Chains

Every signed log (a file's membership, a drive's, a roster) is the same
kind of chain (core/chain.js):

```
{ seq, prev, doc, type, by, at, ...fields, sig }
```

- `seq` counts from 0; `prev` is the SHA-256 of the previous entry (canonical JSON); `doc` is the document's ID.
- `sig` is `by`'s signature over the canonical body, with a per-kind prefix (`commonplace/members/v1|`, `commonplace/roster/v1|`). Signatures by a computer key carry the computer's ID (core/devices.js).
- Copies merge by extension. A fork (two entries at the same `seq`) keeps the branch whose first differing entry hashes lower; the losing entries are handed back so their signer can make them again.
- Entries signed by a computer later removed stand only if a good entry follows them.
- An entry type a reader doesn't know is skipped, unless it's marked `critical`: then the reader stops syncing that document until it's updated.

What differs between kinds is only **who may sign what** (`maySign`) and
**what an entry does** (`apply`).

## Roster

A roster is a document of type `roster` whose chain lists the cloud.

**The cloud's key.** Creating a cloud makes a key pair whose public half is
the roster's ID (`rosterId`, hex64). It signs only the first entry, then is
sealed with the cloud's recovery key and deleted. Admins sign everything
after that with their own identities.

Entries:

| type | fields | signed by | does |
| --- | --- | --- | --- |
| `create` | `gen`, `name`, `admins: [{ userId, enc }]` | the cloud's key | starts generation `gen` (1, then each recovery) |
| `member` | `userId`, `enc`, `role`: `member` · `admin` · `host` | an admin | adds someone or changes their role |
| `remove` | `userId` | an admin | takes someone out (not the last admin) |
| `group` | `id`, `name`, `members: [userId]` | an admin | creates or replaces a group |
| `ungroup` | `id` | an admin | deletes a group |
| `host` | `userId`, `kind`: `relay` · `server`, `address`? | an admin | describes a member whose role is `host` |
| `rule` | `key`, `value` | an admin | sets a cloud rule (see below) |
| `nodes` | `nodes: ["host:port"]` | an admin | the cloud's own bootstrap list |
| `rename` | `name` | an admin | renames the cloud |

**Recovery.** A `create` with a higher `gen`, signed by the cloud's key
(opened with the recovery key), starts a new chain that replaces the old
one. Peers keep the chain with the highest `gen`. That is the way back
when admins' keys are lost or two admins removed each other.

**Rules** (all optional): `externalSharing` (`allow` · `deny`),
`requireProtection` (bool), `keepCopies` (bool), `snapshotEvery` (hours).
Rules bind the app and the cloud's hosts; they can't stop a member copying
what they can read, and the app says so.

**The roster's key.** The roster document is encrypted like any document;
every member gets its key (sealed to their `enc`), so every member can read
the roster and sync it. Removing a member moves it to a new key.

Status: core/chain.js and core/roster.js exist (no sync or UI yet).

## Drives

A drive is a document of type `drive`. Its Yjs content is its catalog:

- `items`: fileId → `{ secret, type, title, addedBy, at, folder? }` (`folder` is a folder *inside* the drive: just structure);
- `folders`: folderId → `{ name, parent }`;
- `policy`: the drive's own rules (`keepCopies`, `onDemand`).

Its membership log is the ordinary file log (core/members.js) with two
differences, both fixed by its `create` entry:

- `create` carries `roster: { id, seq, hash }`, and its `owner` is the roster's ID. It is signed by an admin of the roster at that position.
- Any roster admin may sign what an owner may. Each entry an admin signs carries `roster: { seq, hash }`, the roster position that made them an admin; readers check it against the roster's chain. Without that chain, the entry waits (as logs from unknown computers wait today).

Members can be people (`add` with `userId`) or groups (`add` with
`group`, a roster group ID). A person's role in the drive is the highest
of their own and their groups'. Managers ("can edit and share") can add
and remove people and groups; only admins can give the manager role.

**Files in a drive** have no membership log. For drive epoch `e`, a file's
key is derived from the drive's epoch secret:

```
fileSecret(e) = HKDF-SHA256(driveSecret(e), salt = fileId, info = "commonplace/v1/drive-file")
```

and its topic and encryption key come from `fileSecret(e)` the way every
document's do from its secret. So:

- Adding a person or group to a drive gives them every file: one entry.
- Removing one moves the drive to a new epoch: one entry, and every file's next frames use new keys.
- Who may read or edit a file is the drive's answer, checked at every hello.

A file in a drive records who added it (`meta.addedBy`), shown as "Added
by". There is no owner: the file is the drive's.

**Shared beyond the drive** (a later step): sharing one file in a drive
with someone outside it moves that file to a document with its own log,
owned by the drive (`owner` = the roster's ID), whose keys are sealed to
the drive's epoch key and to the outsiders. The rule against changing
authority still holds, because it's a new document.

Status: not built.

## Shared folders

A shared folder stays a document of type `folder` in its owner's My
Drive, listing files by secret (as today). Its files keep their own logs
and owners. What changes is how the folder's people get them:

- Today the file's owner adds every folder member to every file's log (people × files entries).
- Next, the file's log gets one entry, `scope`: `{ scope: folderId, role }`, and each of its epoch keys is sealed under the folder's epoch key (`keys` on `rotate` gain `scope:<folderId>`). A folder member opens the folder's key, then the file's.

Access to a file is then the highest of a person's own role and the roles
the folder gives (checked at runtime against the folder's log, which every
folder member has). Removing someone from a folder moves the folder to a
new key; each file's owner then moves the file to a new key (one entry per
file, by its owner, whenever they're online), as removals always have.

**Older apps** don't know `scope`. Until they're gone, the file's owner
keeps adding folder members who run older apps one by one (their hello says
which version they run), so nobody loses access.

**Handover** (the owner's promise that their files stay when they leave)
is not needed in drives, since drive files belong to the drive. For shared
folders it stays possible, as an opt-in per folder (a later step).

Status: today's per-person adds work. `scope` is not built.

## Hosts

A relay or server is a roster member with role `host`, described by a
`host` entry.

- **A relay** syncs a drive's documents as boxes it can't read (as today). Drives list relays by roster membership instead of each file listing its own.
- **A server** is a host that drives add as a member (usually `viewer`, or `editor` if it must write: search indexes, notifications). It keeps every file, serves members when nobody else is online, and later holds notifications and search.
- **Who a host accepts:** documents of rosters it's a member of, within a quota per roster and per drive.
- **Bootstrap:** a roster's `nodes` are used by every member, alongside or instead of the public ones.

Status: relays work per file; the rest is not built.

## What retires

| Today | Becomes |
| --- | --- |
| Team drives: a shared folder owned by a server identity, `meta.drive`, the server document's requests | Rosters and drives. Never released, so removed outright once drives work. |
| `handover` log entries | Not written. Still read, so logs that have one stay valid. |
| `add.folder` and per-person adds for shared folders | `scope` entries, with per-person adds only for older apps. |
| Relays listed per file (`helpers` map, an old name kept for compatibility) | Relays listed per roster. |
| One network topic per file | One per drive (phase 4). |

## Compatibility

- A drive, a roster and a file in a drive are new document kinds; v0.3.0 apps never open them, since nothing gives them their keys.
- Files in My Drive and shared folders stay readable by v0.3.0 apps, as above.
- New entry types that limit access are `critical`.
- The cross-version check (scripts/compat.mjs) keeps running against the last two releases.
