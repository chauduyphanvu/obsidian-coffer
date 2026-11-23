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
- `publish`: publish the website from the `site` part of `coffer.json`. Add `--dry-run` to see what would change.
- `join -`: join or follow a shared folder from an invite link on standard input.

Run `node coffer.js --help` for every command.

To check that a release file came from Coffer's release workflow, run:

```sh
gh attestation verify coffer.js --repo chauduyphanvu/obsidian-coffer
```

Next: [[Security]].
