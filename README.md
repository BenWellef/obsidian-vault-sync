# Ben VaultSync

Syncs an Obsidian vault with a GitHub repository over the GitHub REST API. No git
binary, no Dropbox, works on desktop and mobile.

This is a rewrite of a plugin that was lost on 2026-08-27. The original used the
plugin ID `vault-sync`, which is taken in the Obsidian community registry by a
Dropbox-based plugin of the same name. Obsidian treated the folder as an
installed community plugin and overwrote `main.js`, `manifest.json` and
`styles.css` with the registry version. There was no source project and no
backup, so the code was unrecoverable.

Two things follow from that, and both are built in:

- The plugin ID is `ben-vault-sync`, which no registry entry uses.
- The source lives in this repository, outside the vault. The vault is no longer
  the only copy of anything.

## Setup

1. Create a fine-grained GitHub personal access token with **Contents:
   read and write** on the target repository.
2. Enter token, owner, repository and branch in the plugin settings.
3. Press **Test** to verify access before the first sync.
4. Run **VaultSync: sync now** from the command palette or the ribbon icon.

## How syncing works

Every file is identified by its git blob SHA, the same hash the GitHub tree API
reports. That makes a full comparison possible with a single API call and no
downloads.

`data.json` keeps a base state: the SHA both sides last agreed on, per path. Each
sync is a three-way comparison of local, remote and base:

| local | remote | vs. base | action |
|---|---|---|---|
| exists | exists | equal | nothing |
| exists | exists | only local changed | upload |
| exists | exists | only remote changed | download |
| exists | exists | both changed | conflict |
| exists | missing | local == base | delete locally |
| exists | missing | local != base | upload |
| missing | exists | remote == base | delete on remote |
| missing | exists | remote != base | download |

Without the base, a deleted file and a newly added file are indistinguishable.
That is why resetting the sync state is a deliberate action: afterwards every
difference counts as a conflict, which keeps both sides rather than guessing.

The stored mtime is a shortcut, not truth: if a file's mtime is unchanged since
the last sync, its content is taken to be unchanged and it is not re-hashed. A
full vault scan therefore reads only the files that actually moved.

### Conflicts

The losing version is always written next to the winner, so a conflict never
destroys content:

- local wins: remote version saved as `Note.conflict-remote.md`
- remote wins: local version saved as `Note.conflict-local.md`

Strategies: keep the newer version (compares local mtime against the last commit
date for that path), always local, always remote, or keep both and leave the
original file untouched. The last one keeps reporting the conflict until the two
sides agree again.

### Writes are serialized

Every upload and deletion is one commit on one branch, with the message
`vault-sync: update <path>` (or `delete`). Parallel writes to the same branch
collide with HTTP 409, so remote writes run strictly sequentially. Downloads run
four at a time.

If the repository tree comes back truncated (GitHub caps very large trees), the
remote listing is incomplete and a missing path can no longer be read as
"deleted". Deletions are skipped for that run and the notice says so.

## What is synced

Notes always. Attachments, video and audio each have their own switch, because
video and audio bloat git history permanently.

With **Sync Obsidian config** on, `.obsidian` is included, so plugin lists and
settings travel between devices. Excluded within it:

- `workspace.json` and friends: device-specific, would ping-pong forever
- everything in a plugin folder except `manifest.json` and `data.json`:
  bundles, vendored libraries and shipped binaries are reinstallable from the
  registry, and in this vault they came to 77 MB that would sit in git history
  for good
- this plugin's own `data.json`: it holds the access token in plain text
- `.obsidian/plugins/.vault-sync-backup/`: local backup of the lost v1 plugin,
  including a copy of the token

Also always excluded: `.git`, `.trash`, `.smart-env` and other regenerable
caches, `.DS_Store`, and stray nested `.obsidian` folders inside subfolders
(leftovers from opening a subfolder as its own vault).

In v1 this switch did nothing at all: the traversal skipped every dot folder, so
`.obsidian` was never reached. The repository has zero commits touching that
path, which is exactly why the lost source could not be recovered from it.

## Safeguards

Every one of these exists because its absence caused real damage, or because the
same class of mistake nearly did.

**Nothing empty overwrites something that has content.** In either direction,
and regardless of the conflict strategy. A download that arrives empty over a
file with content is refused; so is an upload of an empty local file over a
non-empty remote one; and in a conflict the side with content wins outright,
because a timestamp proves nothing when one version is simply gone. This is the
guard that was missing when a broken download path wrote every file as zero
bytes and the next sync pushed those empties over the good copies.

**Every transfer is hashed.** A download is verified against the blob SHA it was
requested by, before anything is written. An upload is verified against the SHA
GitHub reports for what it stored. A local write is checked for the byte count
that was handed to it. Any mismatch throws and the sync state is not advanced, so
a damaged transfer is reported instead of being recorded as success.

**Bulk deletion stops the sync.** More than 20 deletions that also make up over a
quarter of everything tracked aborts the run without touching anything. If the
repository lists no syncable files while files are tracked, the run aborts too.
Both are what a corrupted listing or a lost sync state looks like, and neither is
ever urgent.

**Incomplete information is never read as deletion.** If the repository tree
comes back truncated, a missing remote path could just be missing from the
listing, so deletions are skipped for that run and the notice says so.

**An mtime of zero is not trusted.** The mtime shortcut skips re-hashing an
unchanged file; a filesystem reporting no mtime would make every file look
unchanged, so the shortcut is skipped in that case.

**Deletions go to the vault trash**, not to unlink, so they stay recoverable.

## iOS and iPadOS

Mobile is not just a smaller desktop here, and three of these bit in practice:

**Response bodies are decoded as text.** `requestUrl` does this on some
platforms, which empties any binary body. Blobs therefore travel as base64
inside JSON, which is plain ASCII and survives it. The raw fallback for blobs
GitHub declines to inline is still guarded by the SHA check.

**Decomposed filenames.** Apple filesystems return an umlaut as a letter plus a
combining mark, while a repository written from Windows holds the composed form.
As raw strings those are different paths, so every accented file would look
absent on one side and new on the other: a mobile sync would delete it from the
repository and re-upload it under the decomposed name. All paths are composed to
NFC before comparison. Lookups on Apple filesystems are normalization-
insensitive, so the composed form still opens the right file. A repository path
that is not already composed is reported and skipped rather than guessed at.

**Short argument lists.** JavaScriptCore, which runs Obsidian on iOS, tolerates
far shorter argument lists than V8. Base64 encoding works in 8 KB chunks and
passes the typed array to `apply` directly, so no call gets a huge argument list
and no intermediate array is built.

**Case-insensitive filesystems.** Two repository paths differing only in
capitalisation are one file on iOS and Windows and would overwrite each other on
every run. Both are reported and skipped.

Periodic sync is unreliable on iOS regardless: the app is suspended in the
background, so the interval only fires while Obsidian is in the foreground. Sync
on startup works normally.

## Development

```bash
npm install
npm run dev      # watch build
npm run build    # typecheck, then production bundle
npm test         # 97 assertions, no network, no local paths
npm run preview -- /path/to/vault    # dry run: what would the next sync upload?
VAULT=/path/to/vault npm run deploy  # build, then copy into the vault
```

`npm test` covers the decision table, the path rules, git blob hashing against
values `git hash-object` produces, and migration of the v1 storage shape. It
needs no vault and no network. Point `V1_DATA` at a real v1 `data.json` for one
extra assertion that migration preserves every tracked file:

```bash
V1_DATA=/path/to/data.json npm test
```

`npm run preview` walks a real vault with the real rules and reports what the
next sync would send, without touching the network.

## Files

| Path | Purpose |
|---|---|
| `src/main.ts` | plugin lifecycle, commands, status bar, auto-sync |
| `src/sync.ts` | the sync engine and the decision table |
| `src/github.ts` | GitHub REST client, retries, base64 |
| `src/paths.ts` | what counts as syncable |
| `src/sha.ts` | git blob SHA-1, Web Crypto with a pure-JS fallback |
| `src/settings.ts` | defaults and migration of stored data |
| `src/settingsTab.ts` | settings UI |

## Note on the token

The token is stored in plain text in `data.json`, as it was in v1. That file is
never synced, but it is not encrypted either: Obsidian offers plugins no secret
storage. Scope the token to the one repository and nothing else.
