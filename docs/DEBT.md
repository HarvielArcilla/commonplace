# Debt

What's known to be messier than it should be, and what was cleaned up.
Each change should leave this list shorter or say why it grew.

## Open

| What | Why it's debt | Plan |
| --- | --- | --- |
| Team drives: `drive/src/team-drives.js`, `drive/src/parts/drives.js`, the server document's `requests`, `renderer/teams-view.js` | Superseded by rosters and drives ([MODEL.md](MODEL.md)); never released. | Remove when drives work. |
| `meta.drive` means two things (a catalog has `{ host }`, a file `{ id, name, host }`) | One key, two shapes, told apart by whether `id` is there. | Goes with team drives. |
| Server requests are trusted because they're in the server's document, not because an admin signed them | Any member of that document could write one as someone else. | Rosters: admins sign what they ask. |
| `handover` entries in file logs | Only needed by team drives. | Stop writing them; keep reading them so existing logs stay valid. |
| Shared folders add every member to every file's log (`add.folder`) | People × files entries, and a removal touches every file. | `scope` entries ([MODEL.md](MODEL.md#shared-folders)), with per-person adds only for older apps. |
| Relays are listed per file, in a map named `helpers` (an older name) | The name no longer says what it is, and a group's relays are set file by file. | Relays per roster; the map's name stays for compatibility. |
| One network topic per file | Load on the network grows with the number of files. | One per drive (phase 4). |
| `drive/src/index.js` is still about 850 lines | Creating, joining, listing and describing files live together. | Split listing and describing into a part when drives land. |
| `describe()` and `listFolders()` recompute per file | Fine at hundreds of files, slow at many thousands. | Cache per change once drives raise the item limit. |
| Unsigned invite links from before roles (`legacyLinks`, `retire-legacy`) | Compatibility with v0.1 files. | Keep until a release can say no v0.1 files remain. |

## Done

| When | What |
| --- | --- |
| Nov 2026 | The envelope (`meta`, `people`, `authors`, `conflicts`) is named once, in core `container.js`, which also owns the title and conflicts over it. Seven apps had the same title code. |
| Nov 2026 | `isHex64` and `isDocId` (core `ids.js`) replace the same regular expressions in sixteen files. |
| Nov 2026 | Signed logs share one chain (core `chain.js`); membership and the roster are two kinds of it. |
| Nov 2026 | The sync engine is split into parts (`core/src/engine/`): membership, computers, outbox. Drive and engine share `mixParts`. |
| Oct 2026 | The Drive split into parts (`drive/src/parts/`). |
