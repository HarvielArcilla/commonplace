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

**Document types (`packages/docs`).** Two types share one content format (a ProseMirror tree in the `content` fragment), so converting between them later is cheap:

- *Markdown document* (`markdown`; older files use `docs`): flowing text. Imports and exports `.md` through `@tiptap/markdown`, including `$math$`, `$$block math$$` and tables.
- *Paged document* (`paged`): page setup (size, orientation, margins, page numbers) is stored in the file's `page` map, so every collaborator sees the same pages. Fonts, sizes, colors, highlight and alignment are text marks and attributes. Imports `.docx` with mammoth (structure, plus page setup read from the file's last section) and exports `.docx` with the `docx` library and PDF through Chromium's printer.

Both have links (Ctrl/Cmd+click opens them in the browser), LaTeX math rendered with KaTeX, tables and images. Images are stored inside the document as data URLs, up to 8 MB each.

**Pagination (`packages/docs/src/pagination.js`).** The paged editor stays one continuous ProseMirror view. After each change it measures every top-level block (list items individually) and inserts an invisible spacer widget before any block that would cross the bottom margin, tall enough to push it to the next page's top margin. Spacers are view decorations, never part of the document or the CRDT. Sheets are drawn behind the text from the page count. PDF export uses the same breaks. Narrow windows zoom the pages to fit.

**Drive folders.** Folders are personal: they live in your Drive index (a local CRDT), never in the shared files. Deleting a folder moves its contents up a level; it never deletes files.

**Window boundary.** The window is sandboxed, with no Node and no network. It keeps its own Y.Doc mirror and exchanges binary updates with the background process through `preload.cjs`.

## Known limits

- Anyone with the invite link can read and edit. There are no read-only roles and no removing people yet.
- Removing a file deletes only your copy.
- Files are stored unencrypted on your own disk, which is protected only by your OS account.
- A peer you share one file with learns the public IDs of other files you're syncing (not their contents or keys).
- The first launch needs Hyperswarm's public bootstrap nodes to join the DHT. You can supply your own list.
- A single paragraph or table taller than a page isn't split across pages on screen (PDF export does split it).
- Math is exported to .docx as its LaTeX source in Cambria Math, not as Word equations.
- .docx import keeps structure but not exact fonts, colors or alignment.
- Headers, footers other than page numbers, columns and footnotes aren't supported yet.

## Roadmap

1. **Membership.** The owner signs a member list (user ID to role). Peers reject edits from non-members. Read-only roles. Removing someone rotates the file key.
2. **Your devices.** Sync the Drive index between your own computers, linked by QR code, plus a recovery phrase for your identity.
3. **LAN sync.** Find peers on the same network with mDNS, with no internet needed.
4. **Optional relay mode.** A tiny open-source relay anyone can run, set by URL in settings.
5. **Opt-in seeding.** Let an always-on machine hold encrypted copies for availability.
6. **Docs features.** Comments, suggestions, version history, headers and footers, Word equations in .docx, splitting long paragraphs across pages, and images as content-addressed blobs instead of inline data.
7. **CommonSheets and CommonSlides** as new `packages/*` with their own content CRDTs.
