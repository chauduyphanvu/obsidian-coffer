## Encryption

Coffer encrypts on your device, before anything goes to storage.

- AES-256-GCM encrypts file contents, file names, folder names, and device names.
- Your passphrase unlocks the vault key through PBKDF2-SHA-256 (600,000 iterations for a new vault). HKDF-SHA-256 derives separate keys from it for encryption and for chunk names.
- `vault.json` is the only object that is not encrypted. It holds the vault key, wrapped with your passphrase.
- Your storage provider sees only how many objects there are, their sizes, and when they were written. It cannot test whether you have a given file.

## Two devices at once

Coffer needs no lock and no server. Each commit has a number and contains the hash of the commit before it. A device writes a commit only if its number is still free, which storage checks for it. Two devices cannot write over each other.

## Live link

The live link is off unless you turn it on. Two devices set one up through documents in your storage, sealed with the vault's key like everything else, so only a device that holds the key can start or accept a link. Each document holds the device's network addresses and a fingerprint of the connection's key, and the connection (WebRTC, encrypted with DTLS) accepts only that key. What is sent over it is the number of the newest change a device has synced, which makes the other device sync; no file content, no file names, and no keys. Someone who can write to your storage but has no key can not start a link, and at worst can delete the documents, so that no link forms and sync carries on at its usual pace.

With no server address set, devices exchange addresses on the local network only. With a STUN server set, that server sees each device's public address.

## Shared folders

Every device in a shared folder signs its changes with ECDSA P-256, and accepts changes only from current editors. See [[Shared folders]].

A send-only key is a member's secret with no copy of the folder's master key: the owner's device stores no invite for it, so the secret unwraps nothing. It seals what it sends under a key derived from that secret, which only the owner's devices can derive too. With a storage key limited to the folder's inbox it can not list, read or delete anything in storage either. The rule Coffer gives also refuses a write that would replace a file, so a note waiting in the inbox can not be overwritten. This was checked at Amazon S3; a service that does not know that part of the rule refuses it, and without it someone who knows a waiting file's name could replace it.

## Code you can check

Coffer has no runtime dependencies and sends no telemetry. The tests include fuzz tests, where three devices make random changes while requests fail and the app stops at random. Every release file has a GitHub build attestation. The code is on [GitHub](https://github.com/chauduyphanvu/obsidian-coffer).

## Known limits

- **Lost passphrase:** no person can decrypt your synced data without it.
- **Data deleted from storage by another tool:** weekly cleanup and **Check synced data for damage** list the files affected, and a device that still has them can upload them again. Data missing from every device cannot come back.
- **Storage returned to an older state:** a device finds out on its next upload, or within an hour when idle.
- **No outside security audit yet.**
