# Commonplace

Free, collaborative documents, spreadsheets and presentations that run entirely on the computers of the people using them. There are no accounts and no servers. CommonDrive keeps your files; CommonDocs, CommonSheets and CommonSlides edit them.

CommonDocs has two kinds of document:

- **Markdown documents** for notes and writing that flows, with markdown shortcuts. Import and export `.md`.
- **Paged documents** for work that needs real pages: paper size, margins, fonts, colors and alignment. Import and export `.docx`, export PDF.

Both support links, LaTeX math, tables, images, comments, and a suggesting mode whose edits others accept or reject.

**CommonSheets** has formulas (SUM, AVERAGE, IF, VLOOKUP, SUMIF and more), several sheets per file, number formats and styles. It imports and exports `.xlsx` and `.csv`.

**CommonSlides** has layouts, text boxes, shapes, images, speaker notes and full-screen presenting. It exports `.pptx` and PDF.

CommonDrive shows files as a list or as icons, with personal folders, filters, sorting and search. Every file keeps a version history on each computer; any version can be viewed and restored.

Sharing works with roles: invite people to edit or only view, change their role, remove them, or hand ownership to someone else. Invite links expire (after 7 days unless you choose otherwise) and can be limited to one person or need your approval for each person. Removing someone stops sending them anything new; what they already have stays with them.

Use the same Drive on several computers: **Link another computer** in your profile keeps them in sync, files, folders and all. Or move your Drive to a new computer.

Edits made while people are apart merge on their own, like a git merge. If two people changed the same paragraph (or the title), the file's owner sees both versions side by side and decides what stays.

## How it works

- Every file is a CRDT (Yjs). Copies that have seen the same edits are identical, in any order, so nobody has to be online to "own" consistency.
- Your edits are saved on your computer first. When anyone else with the file is online at the same time as you, your computers find each other on a peer-to-peer network (Hyperswarm), connect directly, and exchange what each is missing.
- Every byte that leaves your computer is encrypted with the file's key. The key travels only inside the invite link, or sealed to each member after someone is removed.
- Your identity is a keypair created on first launch. Your name and cursor color are yours to pick. Each file's owner signs who may read or edit it, and every computer checks those signatures.
- Computers on the same network find each other directly and sync without internet.

The tradeoff, chosen on purpose: a file syncs only while at least one other person who has it is online. If you'd rather not wait for that, run an always-on helper (below). It's optional and needs nothing but a computer you leave on.

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

Then double-click **Commonplace** on your Desktop (or in the app menu on Linux). When your computer asks whether Commonplace may use the network, allow it (on Windows, for private networks too, for same-network sync), or other people's computers can't reach yours.

When a new version is on GitHub, the Drive shows **A new version of Commonplace is available**; choose **Update and restart** to update in place (or run the install command again). The check asks GitHub's public API about this project's commits, and sends nothing about you or your files; set `COMMONPLACE_NO_UPDATE_CHECK=1` to turn it off. Closing the window quits Commonplace, and files stop syncing until you open it again.

The scripts are short and commented: read [install.sh](scripts/install.sh) or [install.ps1](scripts/install.ps1) before running them if you like. Settings: `COMMONPLACE_DIR` (install location), `COMMONPLACE_NO_SHORTCUT=1`.

### By hand

Requires Git and Node 20+.

```sh
git clone https://github.com/HarvielArcilla/commonplace.git
cd commonplace
npm install
npm start            # builds the window UI and starts the app
npm test             # end-to-end tests on a private local DHT
```

On Windows, if PowerShell says running scripts is disabled, use `npm.cmd install` and `npm.cmd start`.

To try collaboration on one computer, start a second copy with its own identity and files:

```sh
COMMONPLACE_PROFILE=bob npm start                 # macOS / Linux
$env:COMMONPLACE_PROFILE="bob"; npm.cmd start     # Windows PowerShell
```

Create a document in one window, open **Share**, copy an invite link, and paste it into **Join with invite** in the other.

To run on a private network instead of the public DHT, set `COMMONPLACE_BOOTSTRAP=host:port` (and optionally `COMMONPLACE_DHT_HOST`).

## Always-on helper (optional)

A helper is a small program you leave running on any computer that stays on: an old laptop, a Raspberry Pi, a free cloud VM. It keeps encrypted copies of files it can't read, so people who are never online at the same time still sync, and it passes changes along live when two computers can't reach each other directly. It can't forge edits either: every change is signed by the person who made it and checked against the file's members.

```sh
npm run helper                     # from a clone of this repo, or:
node packages/helper/bin/commonplace-helper.js --dir ~/helper-data --quota 4
```

It prints an address starting with `cph1.`. Paste it into your profile in Commonplace (used for new files and to sync your own computers), or into a file's **Share** dialog. Everyone working on that file then uses it.

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
packages/drive   CommonDrive: the file index, background syncing, history, linked computers
packages/docs    CommonDocs: the app descriptor, rich-text editor, comments and suggestions
packages/sheets  CommonSheets: workbook model, formula engine, .xlsx and .csv
packages/slides  CommonSlides: deck model, text-box editor, .pptx
packages/helper  the optional always-on helper
apps/desktop     Electron shell (background process + window UI)
scripts/         one-step installers and launchers
test/            end-to-end sync, access, conflict, history, helper and app tests
```

## License

MIT. See [LICENSE](LICENSE).
