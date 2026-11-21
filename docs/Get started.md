## Before you start

- **Storage.** You need an S3-compatible bucket or a WebDAV folder, and an access key for it. See [[Storage providers]]. Cloudflare R2 and Backblaze B2 each give 10 GB of free storage.
- **Passphrase.** Your passphrase is the only key. If you lose it, no person can decrypt your synced data. Keep it in a password manager.
- **One sync tool.** Do not put a Coffer vault in iCloud Drive, Dropbox, OneDrive, or Obsidian Sync at the same time.
- **Network access.** Coffer connects only to your storage, and to your website location if you publish. It sends no analytics, no telemetry, and no update checks.

## Install

Coffer needs Obsidian 1.13.1 or later.

- **From Obsidian:** open **Settings → Community plugins → Browse**. Search for **Coffer**. Install and enable it.
- **Manual install:** download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/chauduyphanvu/obsidian-coffer/releases/latest). Put them in `<vault>/.obsidian/plugins/coffer/`. Enable Coffer under **Settings → Community plugins**.

## First device

1. Make a bucket or WebDAV folder and an access key for it.
2. In Obsidian, run **Coffer: Set up sync** from the command palette.
3. Select **This is my first device**. Select your provider. Enter the storage details. Coffer tests the storage before it continues.
4. Enter a passphrase of at least 8 characters, or select **Suggest a passphrase**. Keep it in a password manager.
5. Wait for the first sync to finish. Select **Copy setup link**.

## More devices

1. Install Coffer on the other device in a new, empty vault.
2. Open the setup link. You can also run **Coffer: Set up sync**, select **I already sync another device**, and paste the link.
3. Enter your passphrase. Select **Connect**.

Coffer encrypts the setup link with your passphrase. Protect it as you protect a password. You can copy it again under **Settings → Coffer → Add another device**.

Next: [[Sync and conflicts]].
