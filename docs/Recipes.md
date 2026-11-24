Short answers to "how do I…". Each recipe says what to run and points to the page with more detail. Commands are in the command palette, under **Coffer**.

## Get something back

### Get back text I deleted from a note

1. Open the note.
2. Run **Show version history of the current file**.
3. Pick a version from before the deletion. Coffer shows what changed in it.
4. Restore it, or copy the lines you need back into the note.

Coffer keeps every version for 1 day, hourly versions for 1 week, and daily versions for 30 days. See [[History and restore]].

### Get back a file I deleted

Run **Restore deleted files** and pick the file.

### Undo one bad change and keep my later edits

Use this when a bulk rename went wrong, or a plugin rewrote many notes.

1. Run **Show recent changes**.
2. Find the change and choose **Undo**.

Coffer reverses only that change. Notes you edited afterward keep those edits. If a file cannot be undone safely, Coffer leaves it as it is and tells you which one.

### Put a folder back as it was last week

1. Run **Rewind: look through the vault as it was at an earlier time** to find the right time. Nothing changes while you look.
2. Run **Restore the vault or a folder to an earlier time** and pick that time and the folder.
3. Check the list of files that will come back or change, then restore.

Coffer keeps what the files hold now in their version history, so you can undo the restore.

## Set up devices

### Move to Coffer from iCloud Drive, Obsidian Sync, or another sync tool

Do not keep a vault in two sync tools at once.

1. Pick one device and let the old tool finish syncing, so that device has everything.
2. On that device, stop the old tool for this vault. Turn Obsidian Sync off, or move the vault folder out of iCloud Drive, Dropbox, or OneDrive.
3. Run **Set up sync** and select **This is my first device**.
4. Wait for the first sync to finish, then select **Copy setup link**.
5. On each other device, make a new, empty vault that is not in the old tool.
6. Install Coffer in that vault and open the setup link.
7. Check that every device has its files. Then you can delete the copies of the vault that the old tool still holds.

See [[Get started]].

### Add a phone without filling it with large files

1. Add the phone with the setup link, the same as any other device.
2. On the phone, open **Settings → Coffer → What to sync**.
3. Set **Download only when asked: files larger than (MB)** to a number, for example 5.
4. To have Coffer download large files when you use them and remove them when you stop, set **Keep large files while in use (days)** to a number of days, for example 14.

Notes always stay on the phone. When you open a note, Coffer gets the files it shows. See [[Sync and conflicts]].

### See a change on my other device within seconds

On each device, turn on **Live link between your devices** under **Settings → Coffer → When to sync**. Devices on the same network connect with nothing more to set up. See [[Sync and conflicts]].

### Make a read-only device

Turn on **Only receive changes** at setup, or under **Settings → Coffer → Storage and passphrase**. For this device, a storage key that can only read is enough.

## Try things safely

### Try a big reorganization on one device first

1. Update Coffer on every device and sync each one once.
2. Run **Branches: start, switch, merge or close** and start a branch. Starting your first branch upgrades the vault, and that cannot be undone.
3. Reorganize the vault on this device. Your other devices keep working as they did.
4. When you are done, keep the changes or drop them:
   - To keep them, switch to the main line and choose **Merge into the main line**. Coffer shows what will change first.
   - To drop them, close the branch.

See [[Branches]].

### Fix a note that changed on two devices

When Coffer cannot merge two versions, it keeps both. The second one has "(conflict …)" in its name.

1. Run **Resolve a file changed on two devices**.
2. For each change, keep the lines from this device, the other device, or both.

## Share and publish

### Share a folder with someone who should only read it

1. Open **Settings → Coffer → Shared folders**.
2. Select **Add a shared folder**, then **Share a folder**.
3. Pick the folder.
4. Select **Different storage** and give it its own bucket or WebDAV folder.
5. Open **Members**. Select **Invite someone**, then **For someone who may only read**.
6. Send them the invite link.
7. They install Coffer, select **Add a shared folder**, then select **Join with an invite link**.

They get no key to the rest of your vault. See [[Shared folders]].

### Let a script or a shortcut add notes to my vault

1. Share a folder, for example `Inbox`.
2. Under **Members**, select **Invite someone**, then **Only send notes**. Coffer shows a key. Copy it.
3. On the computer that sends the notes, put that key in `COFFER_CAPTURE_KEY` and run:

```sh
echo "Call the dentist" | node coffer.js capture - --name="Inbox/dentist.md"
```

The key can only add notes. It cannot read anything. See [[Command line]].

### Publish a few notes as a website

1. Under **Settings → Coffer → Website**, add a separate bucket or WebDAV folder.
2. Make that bucket or folder public through your storage provider.
3. In each note to publish, run **Put the current note on the website**.
4. Run **Publish notes to the website…** and check the list before it uploads.

Published pages are not encrypted. See [[Website]].

## Keep my vault safe

### Back up my vault as plain files on a home server

On a computer that is always on, run Coffer from the command line:

```sh
node coffer.js watch --config=coffer.json
```

Set `"readOnly": true` under `sync` in `coffer.json`, so this computer never changes the vault. The vault folder on that computer is a plain copy that your usual backup tool can back up. For a copy made just once, use `export <dir>`. See [[Command line]].

### I lost a device

1. At your storage provider, delete the access key or password your devices use and make a new one. This stops the lost device from reading new changes.
2. On each device you still have, enter the new key or password under **Settings → Coffer → Storage and passphrase**.
3. On one device, select **Change the passphrase on all devices**. Each of your other devices asks for the new passphrase.
4. Under **Settings → Coffer → Devices**, select **Forget** beside the lost device.

The notes already on the lost device stay readable to anyone who can open it. Its screen lock is what protects them.

### Change my passphrase

Under **Settings → Coffer → Storage and passphrase**, select **Change the passphrase on all devices**. Nothing is uploaded again. Each other device asks for the new passphrase once.

### Check that my synced data is not damaged

Run **Check synced data for damage**. If it lists files, run **Repair synced data from this device's files** on a device that still has those files.
