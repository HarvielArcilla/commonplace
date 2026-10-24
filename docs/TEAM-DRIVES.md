# Servers and team drives

How commonplace grows from people syncing with each other to an organization
running its own always-on server, without accounts and without changing who
owns what.

## Words

| Word | Meaning |
| --- | --- |
| **Identity** | A key pair a computer makes for itself. People and servers each have one. Nobody issues it, and only its own keys (and its recovery key) manage it. |
| **Owner** | The person who decides who has a file. Always a person, wherever the file is. |
| **Drive** | Where a file belongs. Every file belongs to exactly one: **My Drive**, or a **team drive**. |
| **Host** | Who keeps a complete copy of a drive's files and serves them: for My Drive, the people who have each file; for a team drive, its server. People choose a drive, never a host. |
| **Server** | A commonplace with no window, left running (`packages/server`). It has its own identity and hosts team drives. |
| **Team drive** | A drive on a server. People in it see its files; its **admins** run it. |
| **Relay** | Unchanged: a blind mailbox that helps files in My Drive. Not a host: it can't read, admit anyone or act for anyone. |
| **Handover** | The owner's signed promise, made when a file moves into a team drive that asks for it: if the owner leaves the drive, the drive's server may pass ownership to one of its admins. |

## Structures

**The server document** (type `server`). Owned by the server's identity; its
admins are members with the manager role. It's the control plane, and it
syncs like any file:

- `status`: written by the server (version, when it started, storage used and free, when it was last seen);
- `drives`: written by the server: each team drive's id, name and secret, so admins can open it;
- `requests`: written by admins (make a team drive, make someone a drive admin, a link for another admin); the server carries them out and writes the result back.

**A team drive's catalog.** A shared folder (type `folder`) owned by the
server's identity, with `meta.drive = { host }`. Its items are the drive's
files and folders; its members are the drive's people (admins are managers);
its `policy` map holds the drive's rules (`handover`, `keepCopies`,
`onDemand`). Because it is a shared folder, everything about joining, nesting
and leaving already works.

**A file in a team drive.** Its membership log has:

- the owner (a person), as always;
- the server's identity as a manager ("Can edit and share"), so the server can let people in, hand out keys and end access with nobody else online;
- a `handover` entry if the drive asks for one (marked `critical`, so older apps stop syncing it rather than ignore it).

Its `meta.drive` records `{ id, name, host }`, so everyone who has it, in the
drive or not, can see where it belongs ("From Acme design").

## Who does what

- **The host grants access.** For files in a team drive, the server adds and removes people as the drive's membership changes (as a manager it may), instead of each file's owner. So a team drive never waits for an owner's computer.
- **Owners stay owners.** Moving a file in or out is the owner's choice. Managers of the drive can't take files out of someone's ownership; only a handover can, and only after the owner leaves the drive.
- **Handover.** When an owner is no longer in the drive, the server passes ownership of their files with a handover to the drive's first admin (who can pass it on), and removes the former owner as the drive's policy says (keep a read-only copy, or not).
- **Moving out.** The owner removes the file from the drive: the handover is withdrawn, the server is removed (the file moves to a new key), and `meta.drive` is cleared. If the drive keeps copies, the server keeps the copy it had, read-only.
- **The server can read what it hosts.** That's what lets it act, keep backups and (later) search. Files that need no such trust stay in My Drive, with a relay if they want one.

## Admins

- A new server prints a **link for its first admin**: an ordinary invite link to its server document, for the manager role, that works once and for a week. Opening it in the app (Join with invite) makes that person an admin; the server then shows in Settings → Servers and team drives. `commonplace-server --admin-link` prints another.
- More admins: an admin asks the server for another link (a request), and hands it to the next person.
- Admins create team drives (a request), add and remove people (the drive's People… dialog, which is the shared folder's Share dialog), make someone a drive admin (a request: only the server's identity, the catalog's owner, can give the manager role), and set the drive's rules.
- Anyone in a drive can add their own files to it. Only a file's owner moves it in or out.

## What people see

- **Drive switcher**: once you're in a team drive, the first crumb in commonDrive reads "My Drive ▾" (or the team drive's name) and opens a menu of drives, with where each is hosted, and a way to Settings → Servers and team drives. Without team drives it stays "commonDrive", as before.
- **Inside a team drive**: its files and folders, a line saying where it's hosted and whether the server is online, People…, and (for admins) Drive settings: the rules and who's an admin. The footer says the files are kept by the server, instead of "Nothing is stored on a server".
- **Moving a file in** (Move to…, or New/Upload while in the drive): "Acme server will keep this and manage who has access… You stay the owner", plus the handover if the drive asks for one. Moving out says the server keeps a read-only copy (or not) and that people lose what they had through the drive. Someone else's file can't move between drives.
- **File details**: Owner · Drive · Hosted by · Folder.
- **Sync notes**: "Syncing with Acme server"; when it's away, "Acme server is offline. Edits reach the drive when it's back" (in place of "the owner is offline", which matters less there).
- **Hiding a team drive** from a computer keeps your files in it for everyone; leaving for good is an admin removing you, and then the handover applies.

## Running a server

```
npx commonplace-server --dir /srv/commonplace --name "Acme server"
```

It keeps everything its drives hold (files that leave keep their read-only copy), accepts larger files than a person's computer would, and writes its status (version, storage used and free, last seen) every minute for its admins to see. It uses the same network settings as the app (`COMMONPLACE_BOOTSTRAP`).

## Not yet

- **On-demand sync** (`onDemand` in the rules): people's computers would sync a drive's files only while open. The rule is stored; nothing reads it yet.
- **Choosing who gets handed-over files**: today it's the drive's first admin, who can pass them on.
- **Removing an admin** of a server: the owner of the server document (the server) would have to do it, so it needs a request kind.
- **The server's own identity** lives on its disk unprotected. Protecting it with a recovery key, as people can, and backing it up, should come next: whoever has that key is the server.
- **Moving a whole team drive to another server.**
