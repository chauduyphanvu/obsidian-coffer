# Coffer

Sync your Obsidian vault between your devices through storage you own: an S3-compatible bucket (Cloudflare R2, Backblaze B2, Amazon S3, MinIO, Wasabi and others) or a WebDAV server (Nextcloud, a NAS). Everything that syncs is encrypted on your device before it leaves, so the storage provider only ever holds data it cannot read.

Coffer runs on desktop and mobile, keeps a version history of every file, merges edits made on two devices, and can bring back deleted files or a whole folder as it was at an earlier time.

> Coffer is young (0.4). It is covered by 771 tests and has been run on macOS and iOS, but keep a backup of a vault you care about while you try it.

## What you need to know first

- **Network use.** Coffer connects only to the storage you configure, to read and write your encrypted vault, and, if you publish a website, to the location you chose for it. It talks to no other server: no analytics, no telemetry, no update checks. Requests go through Obsidian's own `requestUrl`.
- **Publishing is not encrypted.** Only if you use it: the notes you mark `publish: true` are uploaded as readable web pages to the location you choose, and anyone with its address can read them. Nothing is published until you run the command and confirm. See [Publishing a website](#publishing-a-website).
- **No account, no payment.** Coffer is free. The storage itself is billed by your provider, if at all; R2 and B2 both have free tiers of 10 GB.
- **Your passphrase is the only key.** If it is lost, the synced copy cannot be decrypted by anyone, including you. Keep it in a password manager.
- **Files.** Coffer reads and writes only inside your vault, including its settings folder.

## Features

- **End-to-end encryption.** AES-256-GCM, with keys derived from your passphrase. File names, folder names, contents and device names are all encrypted.
- **Efficient transfers.** Files are split into content-defined chunks, so an edit to a large file uploads only the changed part. Identical chunks are stored once, text is compressed before encryption, and small chunks are packed into larger objects so a new device needs few requests to download a vault.
- **Merges, not overwrites.** A note edited on two devices is merged line by line, and word by word inside a paragraph; its properties are merged key by key. Canvases are merged node by node, and settings files key by key. When a merge is not possible, both versions are kept side by side, and a resolver walks you through the differences.
- **History and restore.** Every version is kept for a day, then hourly states for a week, then daily states for the retention window (30 days by default). You can restore a version of a file, bring back deleted files, or return a folder or the whole vault to an earlier time, with a preview of what will change.
- **Safety checks.** A sync that would delete more than 10 files and half the vault stops and asks first. Each change is chained to the one before it, so a device notices if storage was rolled back or tampered with. A "Check synced data for damage" command checks the stored data end to end, and "Repair synced data" stores again, from the files on a device that has them, whatever it finds missing.
- **Sharing.** Share one folder with other people as members who can edit, only read, or read and suggest changes, each joining through their own invite link; or share notes scattered across the vault by marking them with a property. A shared folder gets its own storage. See [Sharing](#sharing).
- **Publishing a website** (optional). Mark notes with `publish: true` and Coffer turns them into web pages, with the pictures they show, at a bucket or WebDAV folder of its own. These pages are not encrypted. See [Publishing a website](#publishing-a-website).
- **Made for phones too.** Setup works from a phone, a new device joins by opening a setup link, and edits are sent before the app is suspended.
- **Clear status.** The status bar says when the vault last synced; a problems screen says plainly what is wrong and what to do.
- **Command-line tool** (optional) to keep a folder in sync from an always-on computer. See [Command line](#command-line).

## Install

Coffer needs Obsidian 1.13.1 or later (an older Obsidian gets Coffer 0.1.0).

From Obsidian: **Settings → Community plugins → Browse**, search for **Coffer**, install and enable it.

By hand: download `main.js`, `manifest.json` and `styles.css` from the [latest release](../../releases/latest) into `<vault>/.obsidian/plugins/coffer/`, then enable Coffer under **Settings → Community plugins**. (The settings folder may have another name if you changed it in Obsidian.)

## Set up

### First device

1. Create a bucket (or a WebDAV folder) and a key for it. See [Storage providers](#storage-providers).
2. In Obsidian, open the command palette and run **Coffer: Set up sync**, or click the notice that appears after enabling the plugin.
3. Choose **This is my first device**, pick your provider and fill in its details. Coffer checks that the storage works before going on.
4. Choose a passphrase of at least 8 characters, or tap **Suggest a passphrase** for a random one (five groups of four letters and digits), and save it in your password manager.
5. The first sync uploads the vault. When it is done, click **Copy setup link**.

### More devices

1. Install Coffer on the device, ideally in a new, empty vault.
2. Open the setup link there (or run **Set up sync**, choose **I already sync another device** and paste it), enter the passphrase, and click **Connect**.

The setup link carries the storage address and keys, encrypted with your passphrase. Treat it like a password. You can copy it again later under **Settings → Coffer → Add another device**. A link takes a moment to prepare, because it is sealed as strongly as the vault key (see [How it works](#how-it-works)). A link made by this version does not open in Coffer 0.2 or earlier, including the 0.1.0 that an Obsidian older than 1.13.1 gets; on such a device, join or update by choosing **This is my first device**, entering the storage details by hand and then the passphrase. Links made by those versions still open here.

Keep a vault in one sync tool only: don't put a Coffer vault inside iCloud Drive, Dropbox or OneDrive, or run Obsidian Sync on it at the same time.

## Storage providers

Use a key that can reach only the bucket you sync to. A device that only receives changes (see [What syncs](#what-syncs)) can use a key that may only read.

| Provider | What Coffer asks for |
| --- | --- |
| Cloudflare R2 | Account ID, bucket, and an R2 API token with object read and write on that bucket |
| Backblaze B2 | The bucket's endpoint (like `s3.us-west-004.backblazeb2.com`), bucket, and an application key limited to it |
| Amazon S3 | The bucket's region, bucket, and an access key |
| Other S3-compatible | Endpoint, region if the provider has one, bucket, keys, and whether it needs path-style addresses (MinIO and most self-hosted servers do) |
| WebDAV | Folder address, user name and password (for Nextcloud, an app password). The folder is created if missing |

**Folder in bucket** lets one bucket hold several vaults; it is filled in from the vault's name.

No CORS configuration is needed. For Amazon S3, this IAM policy is enough (replace `my-notes`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::my-notes" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::my-notes/*" }
  ]
}
```

Turning on versioning for the bucket, with a rule that deletes old versions after a month, adds a second safety net.

## What syncs

- Every file in the vault up to the size limit (500 MB on desktop, 200 MB on mobile by default). Larger files stay on their device and are listed as problems.
- The settings folder (settings, themes and plugins), except the workspace layout. This can be turned off under **Settings → Coffer**. Because plugins sync, installing or updating a plugin on one device brings it to the others.
- Not synced: names starting with a dot (other than the settings folder), which Obsidian cannot see, and anything matching the patterns under **Leave out**.
- **Download only when asked** (off by default). Under **Settings → Coffer → What to sync**, set a size above which files stay in storage and take no room on this device, as on a phone. The command **Download a file left in storage** lists them, and choosing one downloads and opens it. A downloaded file syncs like any other, and this device never deletes a file it has not downloaded.
- **Only receive changes** (off by default, per vault and per shared folder), for a device that must never write to storage, as when its keys can only read. What you edit or add there stays there and is listed as not sent; where storage changes the same file, the two are merged, or this device's version is kept beside it; a file you delete there comes back from storage. Turn it on under **Settings → Coffer → Storage and passphrase**, or when you join. The command-line tool takes `"readOnly": true` under `sync`, and then refuses `clean`, `repair`, `restore`, `restore-at` and `change-passphrase`.

Coffer syncs when Obsidian starts, a few seconds after an edit, every few minutes, and sooner when it notices another device has synced. All of these can be changed in settings.

## Sharing

Everything shared is encrypted like the vault, in storage you choose, and separate from the vault's own: people you share with hold no key to the rest of your notes. Add one under **Settings → Coffer → Shared folders**.

- **A shared folder with members.** You are its owner, and invite each person with their own link, which works once, expires, and needs no passphrase. A member can edit, only read, or read and suggest. Every change is signed by the device that made it, and devices accept only changes signed by a current member who may edit, so "only read" holds even where the storage key itself could write. Someone invited to edit only reads until one of your devices has confirmed them, and an invite to edit is for one device.
- **Removing someone.** Remove them under **Members**; their changes are refused from then on. To also stop them reading what is added later, give the folder new storage keys (**Give everyone new storage keys**): the new keys reach the remaining members through storage.
- **Suggestions.** A member who reads and suggests sends the edits they made on their own device; you review each file and take it in or leave it out.
- **Activity.** **Show recent changes in a shared folder** lists who changed what.
- **Limited storage keys.** For S3, R2 and B2, Coffer writes the provider rule, when you invite someone, for a key that reaches only the shared folder: one that writes, one that only reads, one that reads and may send suggestions. Give members a limited key, not your own.
- **Follow links.** Where a shared folder's storage can be read publicly, a follow link lets someone receive it with no storage key at all. A follower cannot be removed afterwards short of sharing the folder again elsewhere.
- **Your other devices.** A shared folder added on one device is offered on your others, to add with one tap.
- **Notes shared by a property.** Choose a name, such as `Family`, and every note whose properties say `share: Family` is shared, with the attachments it shows, at its place in the vault. This is one way: members read, or read and suggest, and nothing they do changes your vault unless you take a suggestion in. A note that stops saying `share: Family` stays shared until you remove it, under **What's shared**. One device sends these notes, and a vault has one such share.
- **A shared folder with a passphrase**, as before 0.4: everyone who has the storage keys and the passphrase is an equal. These keep working, and still work with 0.3. A folder with members needs 0.4 on every device; to move, share the folder again with members.

What members cannot be stopped from doing: anyone whose storage key can write can delete objects or add garbage that holds a shared folder up until the owner removes it. They cannot get a change accepted.

## Publishing a website

Sharing sends notes, encrypted, to people who hold a key. Publishing is different: it turns notes into web pages that anyone with their address can read in a browser, with no key and no sign-in. The pages are **not encrypted**, and they go to a location of their own, not to the storage your vault syncs to. Sync and sharing stay encrypted and are not touched by it. Nothing is published until you ask.

### Marking notes

A note is on the website when its properties say `publish: true` (in Obsidian, a checkbox property named `publish`). The commands **Put the current note on the website** and **Take the current note off the website** set and remove it. Notes that Obsidian Publish publishes carry the same property, so they are picked up too.

### What goes up

Those notes become pages, and the pictures, sound, video and PDF files they show or link to go up with them. Nothing else goes up.

- A note's properties are not shown, except `title`, which is the page's title.
- `%%comments%%` and HTML comments are removed.
- A link to a note that is not published shows as plain text. A note embedded in another shows as a link to it.
- A file whose name exists more than once in the vault is left out, unless the note links it with its folder.
- Files left out of sync, files in hidden folders and conflict copies are never published. In Obsidian, neither are notes inside a shared folder.

### Where it goes

Under **Settings → Coffer → Website**, choose an S3-compatible bucket or a WebDAV folder, with keys of its own. It must not be the bucket or folder your vault or a shared folder syncs to, nor a folder inside it or one that holds it: Coffer refuses those. Use a key that can reach only that location.

Coffer uploads the files; making them readable to the public is up to you, with your provider's own setting for it (public access to the bucket, or a domain connected to it). The site's entry page is `index.html`.

### Publishing

Run **Publish notes to the website…**. Coffer builds the site and compares it with what is at the location, then shows what would change: new, changed and removed pages and files, and what was left out. It uploads only after you confirm, and only the files that changed; pages you took off are deleted from the location. Nothing is published automatically, so a note you mark does not go up until you run the command.

### How the site looks

One page per note, at its place in the vault (`Folder/Note.html`), and an `index.html` front page: a note you choose with a list of the other pages under it, or the list alone. When you choose none, a published note named `index.md` at the top of the vault is the front page. Every page uses one stylesheet, light or dark as the reader's device is set. There are no scripts, and Coffer adds no trackers.

### Good to know

- The file and folder names of the notes you publish are visible in their page addresses.
- Pictures go up exactly as they are, including any location data a phone stored in them. An image a note takes from another website is loaded from there by the reader's browser.
- Taking a page off deletes it from your location, but not from caches or from copies others made, and a bucket with versioning keeps the old versions.
- Coffer keeps a list of what it uploaded in `coffer-site.json` at the location, and only ever deletes files on that list. Files you put there yourself are left alone.
- Coffer renders the notes itself, so what plugins draw (Dataview queries, Mermaid diagrams, math typesetting) appears as source text, and an embedded note is a link, not its text shown in place.

## Commands

| Command | What it does |
| --- | --- |
| Sync now | Syncs right away |
| Show sync status and problems | Opens the problems screen |
| Set up sync | Connects this vault to storage, or joins with a setup link |
| Sync now, allowing large deletions in the vault | Goes ahead with a sync the safety check stopped |
| Check storage connection | Tests that the storage supports everything Coffer needs |
| Show version history of the current file | Lists stored versions, with a diff, and restores one |
| Download a file left in storage | Lists the files kept in storage by the size setting, and downloads the one you choose |
| Show recent changes in a shared folder | Lists who changed what in a shared folder with members |
| Add the current note to the notes shared by property | Marks the note to be shared at the next sync |
| Remove the current note from the notes shared by property… | Deletes the note for the people it is shared with, and keeps yours |
| Publish notes to the website… | Shows what would change on the website, and uploads it once you confirm |
| Put the current note on the website | Marks the note `publish: true`, so the next publish includes it |
| Take the current note off the website | Removes `publish: true` from the note, so the next publish deletes its page |
| Restore deleted files | Lists deleted files that can still be brought back |
| Restore the vault or a folder to an earlier time | Previews and applies a point-in-time restore |
| Resolve a file changed on two devices | Walks through a conflict copy line by line |
| Check synced data for damage | Verifies the stored data end to end |
| Repair synced data from this device's files | Stores again what the check found missing or damaged, from the files on this device |
| Delete expired versions from storage | Runs the cleanup now (it also runs weekly, and after a day when storage has filled up with many small objects) |

## How it works

- **Storage layout.** `vault.json` holds the vault key, wrapped with a key derived from your passphrase (PBKDF2-SHA-256, 600,000 iterations for a new vault; setup links and invites are sealed at that cost too, or the vault's own if it is higher). It is the only object stored unencrypted, and it reveals nothing but the salt and iteration count. Changes are stored as numbered commits (`log/`), with periodic snapshots of the whole file table (`snap/`), and file contents live in encrypted packs (`pack/`).
- **Keys.** Separate keys for encryption and for chunk IDs are derived from the vault key. Chunk IDs are keyed hashes, so storage cannot check whether you hold a particular file.
- **Commits.** Commits are numbered, and each is written only if its number is still free, so two devices can never overwrite each other's changes. Each commit includes a hash of the one before it.
- **What the storage provider can see:** how many objects there are, their sizes, and when they are written. Nothing else.
- **Changing the passphrase** re-wraps the vault key; nothing else is re-uploaded. Other devices ask for the new passphrase on their next sync. A vault made with fewer than 600,000 iterations is raised to that cost at the same time, and a higher cost is never lowered; entering the current passphrase again does only that.

## Command line

The same engine runs from Node.js 22.18 or later, for an always-on computer that keeps a copy in sync. Download `coffer.js` from the release and run it; it is one file with nothing to install. If Node stops with `Cannot use import statement outside a module`, a nearby `package.json` says `"type": "commonjs"`: rename the file to `coffer.mjs`, which Node always reads as a module.

```sh
node coffer.js watch --config=coffer.json
```

To check that the file was built by this repository's release workflow, run `gh attestation verify coffer.js --repo chauduyphanvu/obsidian-coffer`. From a clone, `npm ci` and then `npm run cli -- watch --config=coffer.json` run the same code.

`coffer.json`:

```json
{
  "vault": "/path/to/vault",
  "remote": { "type": "s3", "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "my-notes", "prefix": "Notes", "pathStyle": false },
  "sync": { "deviceName": "nas" }
}
```

Secrets come from the environment: `COFFER_PASSPHRASE` (at least 8 characters to make a new vault, and the same for `COFFER_NEW_PASSPHRASE`), and `COFFER_ACCESS_KEY` with `COFFER_SECRET_KEY` for S3, or `COFFER_WEBDAV_PASSWORD` for WebDAV. Other commands: `join`, `sync`, `fetch`, `check`, `history`, `restore`, `deleted`, `log`, `restore-at`, `verify`, `repair`, `clean`, `change-passphrase`, `accept-storage` and `publish`. Run `node coffer.js --help` (from a clone, `npm run cli`) for details, and `--version` for the version.

To publish a website (see [Publishing a website](#publishing-a-website)), add a `site` to `coffer.json`: where it goes, as a `remote` of type `s3`, `webdav` or `folder` with the same fields as the vault's `remote`, and optionally a `title` and a `home`, the note that is the front page.

```json
"site": {
  "remote": { "type": "s3", "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "my-site", "prefix": "", "pathStyle": false },
  "title": "My notes",
  "home": "Home.md"
}
```

`node coffer.js publish --config=coffer.json` uploads the website and prints what changed. Unlike the command in Obsidian it does not ask first, so run it with `--dry-run` to see what it would do: that prints the same and writes nothing. The website's keys are separate from the vault's: `COFFER_SITE_ACCESS_KEY` and `COFFER_SITE_SECRET_KEY` for S3, or `COFFER_SITE_WEBDAV_PASSWORD` for WebDAV. `publish` reads only the vault folder, so it needs no passphrase and no sync keys, works on a device that only receives, and leaves the sync state alone. A `folder` site writes plain files you can host anywhere; the folder must be outside the vault, neither inside it nor holding it.

To keep large files off this machine, set `deferAboveMB` under `sync` to a size in MB: files above it stay in storage, `sync` lists them as not downloaded, and `fetch <path>...` downloads the ones you name, after which they sync like any other file.

To join a shared folder with members, or follow one, pass its link on standard input so it stays out of shell history: `pbpaste | node coffer.js join - --config=family.json --vault=Family`. The keys are kept in `<folder>/.coffer/keys.json`, readable by you alone, and the other commands then work on that config. The command line cannot own a shared folder, send suggestions, or send notes shared by a property.

## Known limitations

- In a shared folder with members, a device that joins with an invite made before someone was removed can be shown storage put back to before the removal, until the folder is given new keys.

- If objects are deleted from storage by something other than Coffer, **Check synced data for damage** reports which files are affected, and **Repair synced data** stores them again from a device that still has those files. What no device has any more cannot be recovered, and neither can an earlier version that no current file shares data with.
- If storage is put back to an older copy, a device notices when it next sends a change, and at once takes back the one change it sent, or within an hour if it has nothing to send, as a device that only receives never does.
- In the device list, another device's "changes behind" count can be up to 30 minutes old.

## Build from source

```sh
npm ci
npm run build      # dist/main.js, dist/manifest.json, dist/styles.css, dist/coffer.js
npm test
```

## License

[MIT](LICENSE)
