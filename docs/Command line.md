The same sync engine runs on Node.js 22.18 or later, for an always-on computer such as a NAS or a home server. Download `coffer.js` from the [latest release](https://github.com/chauduyphanvu/obsidian-coffer/releases/latest) and run it with no installation. If Node stops with `Cannot use import statement outside a module`, rename the file to `coffer.mjs`.

```sh
node coffer.js watch --config=coffer.json
```

An example `coffer.json`:

```json
{
  "vault": "/path/to/vault",
  "remote": { "type": "s3", "endpoint": "https://s3.us-east-1.amazonaws.com", "region": "us-east-1", "bucket": "my-notes", "prefix": "Notes", "pathStyle": false },
  "sync": { "deviceName": "nas" }
}
```

Secrets come from environment variables: `COFFER_PASSPHRASE`, and `COFFER_ACCESS_KEY` with `COFFER_SECRET_KEY` (S3) or `COFFER_WEBDAV_PASSWORD` (WebDAV).

## Common commands

- `watch`: keep the vault in sync. Add `--publish` to publish the website after syncs that change something.
- `status`: check storage access, the sync state, and conflict copies, without writing to storage. Add `--json` for scripts. It exits with `1` when something is wrong.
- `export <dir>`: write a decrypted copy of the vault into an empty folder, for your usual backups. Add `--at=<time>` for the vault at an earlier time.
- `activity`: list the latest changes, each after its number. `undo <number>` takes one of them back out and keeps everything done since. Add `--dry-run` to see what would change.
- `branch`: list the vault's branches and the line this device is on. `branch start <name>`, `branch switch <name>` (or `main`), `branch merge <name>` (add `--dry-run` to see what would change) and `branch close <name>` do what the Branches screen does. `upgrade` makes the vault one that can have branches, once every device runs 0.12.0 or later; it is not undone. See [[Branches]].
- `fetch <path>...` and `evict <path>...`: download a file that `sync.deferAboveMB` leaves in storage, or remove one from this device again; storage keeps it. `sync --keep-days=N` keeps the large files changed in the last N days, or linked from a note changed in that time, and removes the others from this device.
- `publish`: publish the website from the `site` part of `coffer.json`. Add `--dry-run` to see what would change.
- `join -`: join or follow a shared folder from an invite link on standard input.
- `capture <file>...`: send notes to a shared folder with a send-only key from `COFFER_CAPTURE_KEY`. It needs no config file, passphrase or vault, and can read nothing. From standard input: `echo "Call the dentist" | node coffer.js capture - --name="Inbox/dentist.md"`.
- `suggest`: on a device that joined to read and suggest, send the notes changed here to the owner's device.

Run `node coffer.js --help` for every command.

To check that a release file came from Coffer's release workflow, run:

```sh
gh attestation verify coffer.js --repo chauduyphanvu/obsidian-coffer
```

Next: [[Security]].
