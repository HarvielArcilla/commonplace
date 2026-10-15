# Commonplace

Free, collaborative documents that run entirely on the computers of the people using them. There are no accounts and no servers. CommonDrive keeps your files; CommonDocs edits them; CommonSheets and CommonSlides come later on the same foundation.

CommonDocs has two kinds of document:

- **Markdown documents** for notes and writing that flows, with markdown shortcuts. Import and export `.md`.
- **Paged documents** for work that needs real pages: paper size, margins, fonts, colors and alignment. Import and export `.docx`, export PDF.

Both support links, LaTeX math, tables and images. CommonDrive shows files as a list or as icons, with personal folders, filters, sorting and search.

Sharing works with roles: invite people to edit or only view, change their role, remove them, or hand ownership to someone else. Removing someone stops sending them anything new; what they already have stays with them. You can move your whole Drive to another computer while both are online.

Edits made while people are apart merge on their own, like a git merge. If two people changed the same paragraph (or the title), the file's owner sees both versions side by side and decides what stays.

## How it works

- Every file is a CRDT (Yjs). Copies that have seen the same edits are identical, in any order, so nobody has to be online to "own" consistency.
- Your edits are saved on your computer first. When anyone else with the file is online at the same time as you, your computers find each other on a peer-to-peer network (Hyperswarm), connect directly, and exchange what each is missing.
- Every byte that leaves your computer is encrypted with the file's key. The key travels only inside the invite link, or sealed to each member after someone is removed.
- Your identity is a keypair created on first launch. Your name and cursor color are yours to pick. Each file's owner signs who may read or edit it, and every computer checks those signatures.

The tradeoff, chosen on purpose: a file can only sync while at least one other person who has it is online. Nothing waits on a server.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## Install

One command installs everything it needs (Git and Node.js too, if they're missing) into `Commonplace` in your home folder, and adds a launcher. Run it again later to update.

**macOS or Linux** (Terminal):

```sh
curl -fsSL https://raw.githubusercontent.com/HarvielArcilla/commonplace/main/scripts/install.sh | bash
```

**Windows** (PowerShell):

```powershell
powershell -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/HarvielArcilla/commonplace/main/scripts/install.ps1 | iex"
```

Then double-click **Commonplace** on your Desktop (or in the app menu on Linux). When your computer asks whether Commonplace may use the network, allow it, or other people's computers can't reach yours.

The scripts are short and commented: read [install.sh](scripts/install.sh) or [install.ps1](scripts/install.ps1) before running them if you like. Settings: `COMMONPLACE_DIR` (install location), `COMMONPLACE_NO_SHORTCUT=1`.

### By hand

Requires Git and Node 20+.

```sh
git clone https://github.com/HarvielArcilla/commonplace.git
cd commonplace
npm install
npm start            # builds the window UI and starts the app
npm test             # sync, access and conflict tests on a private local DHT
```

On Windows, if PowerShell says running scripts is disabled, use `npm.cmd install` and `npm.cmd start`.

To try collaboration on one computer, start a second copy with its own identity and files:

```sh
COMMONPLACE_PROFILE=bob npm start                 # macOS / Linux
$env:COMMONPLACE_PROFILE="bob"; npm.cmd start     # Windows PowerShell
```

Create a document in one window, open **Share**, copy an invite link, and paste it into **Join with invite** in the other.

To run on a private network instead of the public DHT, set `COMMONPLACE_BOOTSTRAP=host:port` (and optionally `COMMONPLACE_DHT_HOST`).

## Build installers

```sh
npm run dist:mac -w @commonplace/desktop   # .dmg and .zip, Apple Silicon and Intel (run on a Mac)
npm run dist:win -w @commonplace/desktop   # .exe installer, x64 and ARM64 (run on Windows)
```

GitHub Actions (`.github/workflows/build.yml`) runs the tests and builds both on every push to `main`.

Builds are unsigned, because signing requires paid certificates. On macOS, right-click the app and choose Open the first time. On Windows, choose More info, then Run anyway in the SmartScreen prompt.

## Layout

```
packages/core    identity, encryption, storage, sync engine, P2P transport
packages/drive   CommonDrive: the file index and background syncing
packages/docs    CommonDocs: the app descriptor and the rich-text editor
apps/desktop     Electron shell (background process + window UI)
scripts/         one-step installers and launchers
test/            end-to-end sync, access and conflict tests
```

## License

MIT. See [LICENSE](LICENSE).
