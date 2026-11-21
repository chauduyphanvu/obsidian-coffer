## Encryption

Coffer encrypts on your device, before anything goes to storage.

- AES-256-GCM encrypts file contents, file names, folder names, and device names.
- Your passphrase unlocks the vault key through PBKDF2-SHA-256 (600,000 iterations for a new vault). HKDF-SHA-256 derives separate keys from it for encryption and for chunk names.
- `vault.json` is the only object that is not encrypted. It holds the vault key, wrapped with your passphrase.
- Your storage provider sees only how many objects there are, their sizes, and when they were written. It cannot test whether you have a given file.

## Two devices at once

Coffer needs no lock and no server. Each commit has a number and contains the hash of the commit before it. A device writes a commit only if its number is still free, which storage checks for it. Two devices cannot write over each other.

## Shared folders

Every device in a shared folder signs its changes with ECDSA P-256, and accepts changes only from current editors. See [[Shared folders]].

## Code you can check

Coffer has no runtime dependencies and sends no telemetry. The tests include fuzz tests, where three devices make random changes while requests fail and the app stops at random. Every release file has a GitHub build attestation. The code is on [GitHub](https://github.com/chauduyphanvu/obsidian-coffer).

## Known limits

- **Lost passphrase:** no person can decrypt your synced data without it.
- **Data deleted from storage by another tool:** weekly cleanup and **Check synced data for damage** list the files affected, and a device that still has them can upload them again. Data missing from every device cannot come back.
- **Storage returned to an older state:** a device finds out on its next upload, or within an hour when idle.
- **No outside security audit yet.**
