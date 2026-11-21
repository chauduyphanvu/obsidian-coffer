Add a shared folder under **Settings → Coffer → Shared folders**. Each shared folder uses its own encrypted storage, separate from your vault. People in a share do not get a key to your other notes.

- **Members.** Invite each person with a link that expires. No passphrase is necessary. Members can edit, only read, or read and suggest. Devices sign every change, and accept changes only from current editors, also when someone's storage key can write.
- **Suggestions.** Members who suggest send changes for you to check. You decide which files to accept.
- **Removal.** Remove a member under **Members** to stop their future changes. To keep them from reading new data, replace the storage keys with **Give everyone new storage keys**.
- **Limited keys.** For S3, R2, and B2, Coffer shows key rules for each role where the provider supports them. Give members a limited key, not your own.
- **Follow links.** For storage that anyone can read, a follow link gives read-only access with no storage keys. You cannot remove a follower without a new share in different storage.
- **Share by property.** Pick a name, for example `Family`, to share the notes that say `share: Family`, with the files they embed. This kind of share goes one way: others read, or read and suggest.
- **Your other devices** show the shared folder, and you can add it with one tap. Run **Show recent changes** to see who changed each file.

> [!caution] What a member with a write key can do
> They can delete objects or add invalid data in storage. That stops sync until the owner removes the invalid data, but devices do not accept their changes.

Next: [[Website]].
