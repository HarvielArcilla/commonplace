# Architecture

## Goals

1. Completely free to run. Only the users' own computers and internet connections are involved.
2. Real collaboration: live co-editing, cursors, and offline edits that merge cleanly.
3. One foundation for Docs, Sheets and Slides.

## Decisions

| Question | Decision | Why |
|---|---|---|
| Consistency | Yjs CRDT per file | Merges are order-independent, so no owner or server has to sequence edits. |
| Transport (default) | Hyperswarm: DHT discovery, UDP hole punching, Noise-encrypted streams | Runs entirely on peers. No STUN, TURN, or signaling server of ours. |
| Transport (same network) | Multicast discovery, direct TCP, the same Noise handshake | Works with no internet at all. Announcements reveal nothing about which files are there. |
| Availability (optional) | An always-on helper: a blind store-and-forward node anyone can run | Lets people sync without being online at the same time. It can't read or forge anything. |
| Encryption | AES-256-GCM per file, key derived from the file secret in the invite | A peer without the invite cannot read or inject anything. |
| Identity | Ed25519 keypair on first launch. Public key = user ID | No accounts. Names are self-chosen and not unique. |
| Ownership | An owner-signed membership log per file | Ownership governs who may take part, not edits. Edits never wait for the owner. |
| Roles | Owner, editor, viewer; enforced by every peer | Each connection proves its identity; peers accept edits only from editors. |
| Revoking | Remove + rotate to a new key epoch | Removed people get nothing new. What they already have stays with them. |
| Devices | The same identity on each of your computers; the Drive index syncs between them | Simple and private: your computers are just you. A lost computer can be asked to sign out, not cryptographically cut off. |
| Rendering | Webview (Electron) + ProseMirror via TipTap | Text shaping, IME, accessibility and spellcheck come from the browser engine. |
| Shell | Electron | Hyperswarm is JavaScript; identical rendering on macOS and Windows. |

## Pieces

**Container.** Every file is one Yjs document with `meta` (type, title, owner, createdAt, schemaVersion), `authors` (editing session to user), `people` (names), `helpers` (always-on helpers it uses), and app-owned content. commonDrive reads only those, plus what an app descriptor offers (`preview`, `thumbnail`, `units`/`resolve` for conflicts, `history.roots` for restoring, `review` counts), so new apps need no Drive changes.

**Sync engine (`core/src/sync.js`).** Holds every file in memory, persists every change to an append-only log, and speaks a small protocol over any duplex stream:

- `HELLO` carries who I am and my state vector. The reply is exactly what the other peer is missing.
- `UPDATE` carries a Yjs update, forwarded to every other connected peer.
- `ACK` is my state vector after applying updates. It powers "some of your edits are only on this computer".
- `AWARENESS` carries cursors and presence.

All payloads are sealed with the file key. One connection carries many files.

**Discovery (`core/src/swarm.js`).** Each file's DHT topic is a hash of its secret. Files with no connected peers are re-looked-up every 15 seconds, so two people who open at almost the same moment still find each other. A peer that gains a key epoch after connecting (someone admitted after a removal) is greeted again on that epoch, so content starts right away.

**Same network (`core/src/lan.js`).** Every few seconds each computer multicasts its connection key, a TCP port, a random nonce and, for each topic it's syncing, `HMAC(topic, nonce)`. A computer holding the same topic recognizes the tag; nobody else learns anything, and tags change with every announcement. The computer with the smaller key dials, over TCP, wrapped in Hyperswarm's secret-stream (Noise) with the announced key as the expected remote key. It uses the same key pair as the DHT transport, so the engine sees one peer either way.

**Availability.** Every collaborator keeps the full file and serves it to the others. Any online peer that has the latest edits can bring anyone else up to date, so the owner doesn't need to be online. Edits made while nobody else is online wait on your computer until someone is.

**commonDocs (`packages/docs`).** Two types share one content format (a ProseMirror tree in the `content` fragment), so converting between them later is cheap:

- *Markdown document* (`markdown`; older files use `docs`): flowing text. Imports and exports `.md` through `@tiptap/markdown`, including `$math$`, `$$block math$$` and tables.
- *Paged document* (`paged`): page setup (size, orientation, margins, page numbers) is stored in the file's `page` map, so every collaborator sees the same pages. Fonts, sizes, colors, highlight and alignment are text marks and attributes. Imports `.docx` with mammoth (structure, plus page setup read from the file's last section) and exports `.docx` with the `docx` library and PDF through Chromium's printer.

Both have links (Ctrl/Cmd+click opens them in the browser), LaTeX math rendered with KaTeX, tables and images. Images are stored inside the document as data URLs, up to 8 MB each.

**Pagination (`packages/docs/src/pagination.js`).** The paged editor stays one continuous ProseMirror view. After each change it measures the natural layout (spacers hidden for the measurement, all within one frame) and decides where pages end. Paragraphs and headings split at the first line that doesn't fit, with widow and orphan control; images, tables, math, code and list items move whole. An invisible spacer widget (a view decoration, never part of the document or the CRDT) is inserted before the line or block, exactly tall enough to reach the next page's text area. Because measurement never sees the spacers, the result can't oscillate. Sheets are drawn behind the text from the page count; PDF export uses the same breaks.

**Units and zoom.** Pages are 96 px per inch and text sizes are in points, so a page has the proportions of paper. Defaults (Georgia 12 pt, headings 20/16/13 pt, code Courier New 10 pt) match the .docx export. Zoom scales everything together; "Fit" uses 100% unless the window is narrower than the page.

**Indentation.** Paragraphs and headings carry `indent` (0.5 in steps) and `firstLine` attributes that are kept when Enter splits a paragraph. Tab indents (first line at the start of a paragraph), Shift+Tab outdents, and Backspace at the start removes indentation first. Lists and tables handle Tab first. Indents export to .docx; Markdown has no way to express them.

**Comments and suggestions (`packages/docs/src/review.js`, `comments.js`).** A comment is a `comment` mark on the text it's about (several may overlap), so its anchor moves with the text. Threads live in the file's `comments` map as nested CRDT types: each thread is a map, its messages an array, so two people replying at once both land. Suggesting mode uses prosemirror-suggest-changes: in that mode every transaction is rewritten so insertions get an `insertion` mark, deletions become a `deletion` mark instead of removing text, and formatting changes a `modification` mark. Transactions from the CRDT itself (other people's edits) are never rewritten. Who suggested what is in the `suggestions` map. Anyone who can edit can accept or reject; exports leave pending suggestions out.

**Version history (`core/src/history.js`).** Each computer saves a checkpoint a minute after edits pause, and at least every ten minutes during continuous editing. Checkpoints form a chain: the first is the full state, later ones are `Y.diffUpdate` against the previous checkpoint's state vector (new structs plus the delete set), so rebuilding version *k* merges checkpoints 0..*k*. Old checkpoints are thinned (all from two days, then daily for two months, then weekly) by merging a checkpoint into the next. Restoring copies the app's content roots and the title from the old version into the live file as one ordinary edit, which syncs to everyone; the replaced version stays in the history.

**commonSheets (`packages/sheets`).** A workbook is `sheets` (tab order) and `sheetData` (per sheet: name, row ids, column ids, cells keyed `rowId:colId`, column widths). Formulas are typed with A1 references and stored with id references (`{rowId:colId}`, `{sheetId!rowId:colId}`, `$` for absolute), so inserting rows or columns on one computer never breaks a formula being edited on another; deleting a referenced row shows `#REF!`. The evaluator is a small recursive-descent parser with memoized, cycle-checked evaluation over the common functions. Conflicts are per cell. `.xlsx` goes through ExcelJS (formulas with cached results, fonts, fills, alignment, number formats, widths, every sheet); CSV is values only.

**commonSlides (`packages/slides`).** A deck is `slides` (order), `slideData` (per slide: background, notes as `Y.Text`, elements) and `deck` (theme font and colors). Each element is its own map (`type`, position on a 960 × 540 slide, size, style) and each text box its own `XmlFragment` edited by TipTap, so people working on different boxes never touch each other's data. Moves and resizes are written once, on release. `.pptx` goes through PptxGenJS at 13.33 × 7.5 in (one slide unit is one point); PDF prints one page per slide from the same renderer used for presenting.

**Drive folders.** Folders are personal: they live in your Drive index, never in the shared files. Deleting a folder moves its contents up a level; it never deletes files.

**The Drive index across your computers.** The index (files with their secrets, folders, your computers, your helpers) is itself a file in the sync engine, opened from a secret derived from your identity's private key, with no membership log. Only your computers can derive it, so its topic only ever connects your own computers. Files added, removed or organized on one computer appear on the others; a file removed from your Drive is removed on each of them. "Link another computer" copies the identity and Drive with the same one-time-code transfer as a move, without signing out. Each computer keeps its own id (`device.json`, never copied) and registers itself in the index; unlinking marks it, and that computer signs out and deletes its copy when it next syncs.

**Two computers, one owner.** Both of your computers can sign membership entries. If they append different entries at the same position while apart, every peer keeps the branch with the smaller hash, and the computer whose entries lost makes the same changes again (role changes, removals, admissions, invite resets) on top of the winner.

**Membership (`core/src/members.js`).** Each file carries an append-only log signed by its current owner: `create`, `add` (with role), `role`, `remove`, `rotate`, `owner` (transfer) and `revoke-invites`. Every peer replays and checks the whole log; forged or out-of-order entries are ignored. Files made before membership get a log the next time their owner runs the app, with everyone already in the file kept as editors.

- **Identity proof.** Each `HELLO` is signed by the person's key over the file, the key epoch, and the Noise public key of that very connection, so it can't be replayed on another connection.
- **Roles.** Peers accept `UPDATE` frames only from connections whose signed identity has the editor or owner role. A viewer's client is read-only, and even a modified one can't change anyone else's copy.
- **Invite links** carry the file's root secret plus a token signed by the owner naming a role, an expiry (7 days by default), and optionally *one person only* or *owner approves*. Someone holding a plain token can start immediately (while the file is on its first key), from anyone who has the file; the owner's app adds them to the log the next time both are online. Holders of one-person or approval tokens are *gated*: no peer sends them anything until the owner has added them to the log, so those links work only while the owner is online. A one-person token is used up by the `add` entry that names it. Approval requests appear in the owner's Share dialog. Unsigned links from before roles existed are refused (`retire-legacy`). The token also carries the owner's name and the file's helpers, so a joiner knows whose file it is and can fetch it from a helper.
- **Removing someone** appends `remove` and `rotate`: a fresh random key is sealed (X25519 + HKDF + AES-GCM) to each remaining member's encryption key, and every invite link issued before it stops working. Members move to the new key's network topic; they keep listening on older topics only to hand out the log, so people who were offline during the change can catch up. The removed person keeps everything they already had; they get nothing new. If they were offline at the moment of removal and reconnect to a member who also missed the change, those two can still exchange edits until either reaches someone who has the log. That window closes as soon as the log reaches them.
- **Joining after a key change** needs the owner online, since only the owner can seal the current key to a newcomer.
- **Transferring ownership** is one signed `owner` entry. The previous owner becomes an editor.

**Presence and background sync.** Files sync whenever the app is running, so edits move as often as possible. Presence ("Maya is here") comes from the editor's awareness state, which exists only while someone has the file open. Per file, background sync can be turned off ("syncs only while open"); the app then leaves the file's topics and tells connected peers it has stopped (`LEAVE`).

**Always-on helpers (`packages/helper`, `core/src/helper-client.js`, `core/src/helper-protocol.js`).** A helper is a dumb mailbox store reached by its public key over the DHT. A box is named by an Ed25519 public key derived from one key epoch of one file, and every write must be signed by the matching private key, so only people with that epoch's key can find or fill a box, and people removed from a file never learn the next box. Each blob is sealed with the file's key and signed by its writer's identity; readers check the signature and the writer's role (from the log, or the invite carried in the blob) exactly as for edits from peers. A client reads everything after its last-seen sequence number, then sends what the helper lacks, judged from the state vectors of what it read and what it already sent, and while connected streams each change up; the helper relays new blobs to everyone connected to the box, so it also works as a relay. When a box grows long, a client replaces its blobs with one full-state blob. Your own helpers also hold your Drive index, so your computers sync through them.

**Moving to another computer (`drive/src/move.js`).** An identity, its Drive index and every file move together, directly, while both computers are online. The old computer shows a one-time code; both sides derive a private meeting topic and an encryption key from it. The new computer must have an empty Drive. It writes everything to a staging folder, swaps it into place, and confirms; only then does the old computer delete its identity and files and start fresh. Collaborators see the same person, so nothing needs re-sharing.

**Recovery (`drive/src/backup.js`).** A backup is the same bundle a move sends (identity, Drive index, every file's stored updates), gzipped and sealed with AES-256-GCM in one file. Its key comes from scrypt over a recovery key the app generates: 25 Crockford base32 characters, about 125 bits, so it can't be guessed and typos like O for 0 are forgiven. The key is shown once and never stored; only the derived key is kept, in `backup.json` next to `identity.json`, so the app can refresh the same file once a day. That adds nothing for someone who already has this computer's disk, since the identity is there in the clear. A refresh writes a temporary file and renames it over the old one, and it refuses to run if the identity on this computer has changed (after a sign-out, say), so a fresh, empty identity never overwrites someone's backup. Restoring needs an empty Drive and goes through the same staging-and-swap as a move. The restored computer is a new device of the same identity and keeps the same backup file going. Restored files are as of the backup; anything newer arrives by ordinary sync from collaborators, linked computers or a helper, and CRDT merging means the older copy never undoes newer edits.

**Conflicts (`core/src/conflicts.js`).** The CRDT merges everything, so edits to different paragraphs made while apart simply combine. Each computer keeps `base.bin`, the last state it had fully in common with a peer (saved when both state vectors match, and when a connection closes while in sync). When a peer reconnects and both sides changed the file since then, the engine captures three versions before applying the peer's catch-up update: *base*, *mine*, and *theirs* (base plus the peer's update). The app compares them unit by unit (each top-level block, keyed by the CRDT item that created it, plus the title). A unit changed on both sides with different results is a conflict, and so is one side deleting a block the other edited. Both computers detect the same conflict and record it under the same id in the file's `conflicts` map, with each version's text and a snapshot of its block. The document keeps the merged text meanwhile, with the block highlighted. Only the owner resolves: keep one version, keep both, or keep the merged text. The resolution is an ordinary edit, so it syncs like any other. Live editing never produces conflicts, since both computers' state vectors stay in step. The base is approximate when someone disconnects mid-edit, which can occasionally flag a block both people actually saw.

**Window boundary.** The window is sandboxed, with no Node and no network. It keeps its own Y.Doc mirror and exchanges binary updates with the background process through `preload.cjs`.

## Known limits

- Only the owner can invite people. New people can join after a key change, or with a one-person or approval link, only while the owner is online.
- Your computers share one identity. A lost computer can be unlinked (it signs out when it next connects), but until then it holds your identity; there's no cryptographic way to cut it off. Losing every computer without a backup means losing the identity. A backup is only as recent as its last daily refresh: files made since then that nobody else has are lost with the computer, and anyone with the backup file and the recovery key can become you.
- Files are stored unencrypted on your own disk, which is protected only by your OS account.
- A peer you share one file with learns the public IDs of other files you're syncing (not their contents or keys). Your Drive index has a stable topic, so a DHT node could notice the same person coming back.
- The first launch needs Hyperswarm's public bootstrap nodes to join the DHT. You can supply your own list. Same-network sync needs no bootstrap.
- Commenting needs edit access (there's no "can comment" role yet). Suggesting mode is tested with typing, deleting and formatting text; some structural edits (in tables, for example) may not be tracked as suggestions.
- Version history records what each computer saw; it isn't shared, and checkpoints are only as fine as the one-minute pause.
- A helper's operator can't read files, but can see how big and how busy each box is, and could withhold or delete them. Someone who was removed can still read the old epoch's box (with the old key); it holds only what they could already see.
- commonSheets: no charts, conditional formatting, merged cells or filters yet; .xlsx import drops shared formulas (keeping their values).
- commonSlides: no .pptx import, transitions or animations; images are stored inside the file.
- A single table, image or code block taller than a page isn't split across pages on screen (PDF export does split it). Paragraphs do split.
- In justified text, the line just before a page break isn't stretched to full width.
- Math is exported to .docx as its LaTeX source in Cambria Math, not as Word equations.
- .docx import keeps structure but not exact fonts, colors or alignment.
- Headers, footers other than page numbers, columns and footnotes aren't supported yet.

## Roadmap

1. **Per-computer keys.** Device keys certified by your identity, so a lost computer can be cut off for real.
2. **A "can comment" role**, enforced by checking that a commenter's updates touch only comments.
3. **commonSheets:** charts, merged cells, filters and sorting. **commonSlides:** .pptx import, transitions, images as shared blobs.
4. **Docs features.** Headers and footers, Word equations in .docx, and images as content-addressed blobs instead of inline data.
