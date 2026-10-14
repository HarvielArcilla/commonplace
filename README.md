# Commonplace

Free, collaborative documents that run entirely on the computers of the people using them. There are no accounts and no servers. CommonDrive keeps your files; CommonDocs edits them; CommonSheets and CommonSlides come later on the same foundation.

## How it works

- Every file is a CRDT (Yjs). Copies that have seen the same edits are identical, in any order, so nobody has to be online to "own" consistency.
- Your edits are saved on your computer first. When anyone else with the file is online at the same time as you, your computers find each other on a peer-to-peer network (Hyperswarm), connect directly, and exchange what each is missing.
- Every byte that leaves your computer is encrypted with the file's key. The key travels only inside the invite link.
- Your identity is a keypair created on first launch. Your name and cursor color are yours to pick.

The tradeoff, chosen on purpose: a file can only sync while at least one other person who has it is online. Nothing waits on a server.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and roadmap.

## Run it

Requires Node 20+ on macOS or Windows (Linux works too).

```sh
npm install
npm run dev          # builds the window UI and starts the app
npm test             # sync tests on a private local DHT
```

To try collaboration on one computer, start a second copy with its own identity and files:

```sh
# macOS
COMMONPLACE_PROFILE=bob npm run dev
# Windows (PowerShell)
$env:COMMONPLACE_PROFILE="bob"; npm run dev
```

Create a document in one window, click **Copy invite link**, and paste it into **Join with invite** in the other.

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
test/            end-to-end sync tests
```

## License

MIT. See [LICENSE](LICENSE).
