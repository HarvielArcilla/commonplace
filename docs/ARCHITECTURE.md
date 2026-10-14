# Architecture

## Goals

1. Completely free to run. Only the users' own computers and internet connections are involved.
2. Real collaboration: live co-editing, cursors, and offline edits that merge cleanly.
3. One foundation for Docs now and Sheets and Slides later.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Consistency | Yjs CRDT per file | Merges are order-independent, so no owner or server has to sequence edits. |
| Transport (default) | Hyperswarm: DHT discovery, UDP hole punching, Noise-encrypted streams | Runs entirely on peers. No STUN, TURN, or signaling server of ours. |
| Transport (optional, later) | A "dumb relay" that stores and forwards encrypted updates | Improves availability for people who want it. The sync engine already accepts any byte stream. |
| Encryption | AES-256-GCM per file, key derived from the file secret in the invite | A peer without the invite cannot read or inject anything. |
| Identity | Ed25519 keypair on first launch. Public key = user ID | No accounts. Names are self-chosen and not unique. |
| Ownership | Creator is the owner (recorded in container metadata) | Ownership governs membership, not edits. Edits never wait for the owner. |
| Rendering | Webview (Electron) + ProseMirror via TipTap | Text shaping, IME, accessibility and spellcheck come from the browser engine. |
| Shell | Electron | Hyperswarm is JavaScript; identical rendering on macOS and Windows. |

## Pieces

**Container.** Every file is one Yjs document with `meta` (type, title, owner, createdAt, schemaVersion), `authors` (editing session to user), and app-owned content (`content` for CommonDocs). CommonDrive reads only `meta` and `authors`, so new apps need no Drive changes.

**Sync engine (`core/src/sync.js`).** Holds every file in memory, persists every change to an append-only log, and speaks a small protocol over any duplex stream:

- `HELLO` carries who I am and my state vector. The reply is exactly what the other peer is missing.
- `UPDATE` carries a Yjs update, forwarded to every other connected peer.
- `ACK` is my state vector after applying updates. It powers "some of your edits are only on this computer".
- `AWARENESS` carries cursors and presence.

All payloads are sealed with the file key. One connection carries many files.

**Discovery (`core/src/swarm.js`).** Each file's DHT topic is a hash of its secret. Files with no connected peers are re-looked-up every 15 seconds, so two people who open at almost the same moment still find each other.

**Availability.** Every collaborator keeps the full file and serves it to the others. Any online peer that has the latest edits can bring anyone else up to date, so the owner doesn't need to be online. Edits made while nobody else is online wait on your computer until someone is.

**Window boundary.** The window is sandboxed, with no Node and no network. It keeps its own Y.Doc mirror and exchanges binary updates with the background process through `preload.cjs`.

## Known limits (milestone 1)

- Anyone with the invite link can read and edit. There are no read-only roles and no removing people yet.
- Removing a file deletes only your copy.
- Files are stored unencrypted on your own disk, which is protected only by your OS account.
- A peer you share one file with learns the public IDs of other files you're syncing (not their contents or keys).
- The first launch needs Hyperswarm's public bootstrap nodes to join the DHT. You can supply your own list.
- No pagination, comments, images, or export yet.

## Roadmap

1. **Membership.** The owner signs a member list (user ID to role). Peers reject edits from non-members. Read-only roles. Removing someone rotates the file key.
2. **Your devices.** Sync the Drive index between your own computers, linked by QR code, plus a recovery phrase for your identity.
3. **LAN sync.** Find peers on the same network with mDNS, with no internet needed.
4. **Optional relay mode.** A tiny open-source relay anyone can run, set by URL in settings.
5. **Opt-in seeding.** Let an always-on machine hold encrypted copies for availability.
6. **Docs features.** Comments, suggestions, images (content-addressed blobs), version history, and export to .docx and PDF.
7. **CommonSheets and CommonSlides** as new `packages/*` with their own content CRDTs.
