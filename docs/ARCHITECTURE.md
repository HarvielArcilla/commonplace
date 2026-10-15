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
| Ownership | An owner-signed membership log per file | Ownership governs who may take part, not edits. Edits never wait for the owner. |
| Roles | Owner, editor, viewer; enforced by every peer | Each connection proves its identity; peers accept edits only from editors. |
| Revoking | Remove + rotate to a new key epoch | Removed people get nothing new. What they already have stays with them. |
| Devices | One computer per identity; moving is explicit | Membership is signed by one key, so it must not be in two places at once. |
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

**Document types (`packages/docs`).** Two types share one content format (a ProseMirror tree in the `content` fragment), so converting between them later is cheap:

- *Markdown document* (`markdown`; older files use `docs`): flowing text. Imports and exports `.md` through `@tiptap/markdown`, including `$math$`, `$$block math$$` and tables.
- *Paged document* (`paged`): page setup (size, orientation, margins, page numbers) is stored in the file's `page` map, so every collaborator sees the same pages. Fonts, sizes, colors, highlight and alignment are text marks and attributes. Imports `.docx` with mammoth (structure, plus page setup read from the file's last section) and exports `.docx` with the `docx` library and PDF through Chromium's printer.

Both have links (Ctrl/Cmd+click opens them in the browser), LaTeX math rendered with KaTeX, tables and images. Images are stored inside the document as data URLs, up to 8 MB each.

**Pagination (`packages/docs/src/pagination.js`).** The paged editor stays one continuous ProseMirror view. After each change it measures the natural layout (spacers hidden for the measurement, all within one frame) and decides where pages end. Paragraphs and headings split at the first line that doesn't fit, with widow and orphan control; images, tables, math, code and list items move whole. An invisible spacer widget (a view decoration, never part of the document or the CRDT) is inserted before the line or block, exactly tall enough to reach the next page's text area. Because measurement never sees the spacers, the result can't oscillate. Sheets are drawn behind the text from the page count; PDF export uses the same breaks.

**Units and zoom.** Pages are 96 px per inch and text sizes are in points, so a page has the proportions of paper. Defaults (Georgia 12 pt, headings 20/16/13 pt, code Courier New 10 pt) match the .docx export. Zoom scales everything together; "Fit" uses 100% unless the window is narrower than the page.

**Indentation.** Paragraphs and headings carry `indent` (0.5 in steps) and `firstLine` attributes that are kept when Enter splits a paragraph. Tab indents (first line at the start of a paragraph), Shift+Tab outdents, and Backspace at the start removes indentation first. Lists and tables handle Tab first. Indents export to .docx; Markdown has no way to express them.

**Drive folders.** Folders are personal: they live in your Drive index (a local CRDT), never in the shared files. Deleting a folder moves its contents up a level; it never deletes files.

**Membership (`core/src/members.js`).** Each file carries an append-only log signed by its current owner: `create`, `add` (with role), `role`, `remove`, `rotate`, `owner` (transfer) and `revoke-invites`. Every peer replays and checks the whole log; forged or out-of-order entries are ignored. Files made before membership get a log the next time their owner runs the app, with everyone already in the file kept as editors.

- **Identity proof.** Each `HELLO` is signed by the person's key over the file, the key epoch, and the Noise public key of that very connection, so it can't be replayed on another connection.
- **Roles.** Peers accept `UPDATE` frames only from connections whose signed identity has the editor or owner role. A viewer's client is read-only, and even a modified one can't change anyone else's copy.
- **Invite links** carry the file's root secret plus a token signed by the owner naming a role. Someone holding a valid token can start immediately (while the file is on its first key); the owner's app adds them to the log the next time both are online.
- **Removing someone** appends `remove` and `rotate`: a fresh random key is sealed (X25519 + HKDF + AES-GCM) to each remaining member's encryption key, and every invite link issued before it stops working. Members move to the new key's network topic; they keep listening on older topics only to hand out the log, so people who were offline during the change can catch up. The removed person keeps everything they already had; they get nothing new. If they were offline at the moment of removal and reconnect to a member who also missed the change, those two can still exchange edits until either reaches someone who has the log. That window closes as soon as the log reaches them.
- **Joining after a key change** needs the owner online, since only the owner can seal the current key to a newcomer.
- **Transferring ownership** is one signed `owner` entry. The previous owner becomes an editor.

**Presence and background sync.** Files sync whenever the app is running, so edits move as often as possible. Presence ("Maya is here") comes from the editor's awareness state, which exists only while someone has the file open. Per file, background sync can be turned off ("syncs only while open"); the app then leaves the file's topics and tells connected peers it has stopped (`LEAVE`).

**Moving to another computer (`drive/src/move.js`).** An identity, its Drive index and every file move together, directly, while both computers are online. The old computer shows a one-time code; both sides derive a private meeting topic and an encryption key from it. The new computer must have an empty Drive. It writes everything to a staging folder, swaps it into place, and confirms; only then does the old computer delete its identity and files and start fresh. Collaborators see the same person, so nothing needs re-sharing.

**Conflicts (`core/src/conflicts.js`).** The CRDT merges everything, so edits to different paragraphs made while apart simply combine. Each computer keeps `base.bin`, the last state it had fully in common with a peer (saved when both state vectors match, and when a connection closes while in sync). When a peer reconnects and both sides changed the file since then, the engine captures three versions before applying the peer's catch-up update: *base*, *mine*, and *theirs* (base plus the peer's update). The app compares them unit by unit (each top-level block, keyed by the CRDT item that created it, plus the title). A unit changed on both sides with different results is a conflict, and so is one side deleting a block the other edited. Both computers detect the same conflict and record it under the same id in the file's `conflicts` map, with each version's text and a snapshot of its block. The document keeps the merged text meanwhile, with the block highlighted. Only the owner resolves: keep one version, keep both, or keep the merged text. The resolution is an ordinary edit, so it syncs like any other. Live editing never produces conflicts, since both computers' state vectors stay in step. The base is approximate when someone disconnects mid-edit, which can occasionally flag a block both people actually saw.

**Window boundary.** The window is sandboxed, with no Node and no network. It keeps its own Y.Doc mirror and exchanges binary updates with the background process through `preload.cjs`.

## Known limits

- Only the owner can invite people, and new people can join after a key change only while the owner is online.
- An identity lives on one computer. Using one identity on two computers at once isn't supported; losing the computer means losing the identity (a backup phrase is on the roadmap).
- Removing a file from your Drive deletes only your copy.
- Files are stored unencrypted on your own disk, which is protected only by your OS account.
- A peer you share one file with learns the public IDs of other files you're syncing (not their contents or keys).
- The first launch needs Hyperswarm's public bootstrap nodes to join the DHT. You can supply your own list.
- A single table, image or code block taller than a page isn't split across pages on screen (PDF export does split it). Paragraphs do split.
- In justified text, the line just before a page break isn't stretched to full width.
- Math is exported to .docx as its LaTeX source in Cambria Math, not as Word equations.
- .docx import keeps structure but not exact fonts, colors or alignment.
- Headers, footers other than page numbers, columns and footnotes aren't supported yet.

## Roadmap

1. **Identity backup.** A recovery phrase or key file, so losing a computer doesn't lose ownership.
2. **Several computers at once.** Device keys certified by your identity, with one computer at a time holding the owner role for membership changes.
3. **LAN sync.** Find peers on the same network with mDNS, with no internet needed.
4. **Optional relay mode.** A tiny open-source relay anyone can run, set by URL in settings.
5. **Opt-in seeding.** Let an always-on machine hold encrypted copies for availability.
6. **Docs features.** Comments, suggestions, version history, headers and footers, Word equations in .docx, splitting long paragraphs across pages, and images as content-addressed blobs instead of inline data.
7. **CommonSheets and CommonSlides** as new `packages/*` with their own content CRDTs.
