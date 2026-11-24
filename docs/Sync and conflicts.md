## What syncs

Coffer syncs all vault files up to the size limit: 500 MB on desktop and 200 MB on mobile by default. Larger files stay on their device, and Coffer lists them as problems.

Coffer also syncs the settings folder: settings, themes, and plugins, without the workspace layout. You can turn that off under **Settings → Coffer → What to sync**. Files and folders whose names start with a dot do not sync, except the settings folder. Neither do the patterns under **Leave out**.

## When it syncs

Coffer syncs at startup, a few seconds after a change, on a regular schedule, and more often when another device syncs. On mobile, it sends changes before the operating system stops the app. You can change these times in settings.

Coffer is not real time. Two people who type in the same note at the same time see each other's changes after the next sync.

### Live link between your devices

Storage cannot tell a device that another one has synced, so each device looks every so often. With **Live link between your devices** turned on, under **Settings → Coffer → When to sync**, your devices connect to each other directly, and one syncs the moment another has. A change then shows on the other device a few seconds after you stop typing.

- **Turn it on on each device.** It is off by default. A device that only receives changes can not take part.
- **When a link forms.** After one device receives a change from the other, while Obsidian is open on both. This takes up to a minute or so. The first change still arrives at the next look; the ones after it arrive at once. **Settings → Coffer → Devices** shows "Linked now" beside a linked device.
- **Same network, unless you say otherwise.** Devices find each other on the same network with no outside server. To link across networks, enter the address of a STUN server under **Link across networks through**. That server tells each device its public address; it sees the devices' network addresses and nothing else. Some networks block direct connections even then.
- **What goes over the link.** Only "I have synced up to this change". Your files still go through your storage, encrypted as always.
- **How devices find each other.** Each leaves the other a small encrypted document in your storage, which is deleted once read. Only a device with your vault's key can read or write one.
- **If no link forms,** or it ends, as when a phone puts Obsidian in the background, sync carries on as before.
- **While linked,** an edit is sent 2 seconds after the last one, if your setting is longer.

It is for the devices of one vault. Shared folders are not linked. Typing in the same note on two devices at once still merges at each sync, not letter by letter.

## Changes from two devices

Coffer does a three-way merge: it compares each device's version with the last version both devices agreed on.

- **Notes:** line by line and word by word, and properties key by key. Lines that two devices add at the same place are both kept.
- **Canvases:** node by node. **Bases:** line by line. **Settings files:** key by key.
- **Moves:** if one device moves a note and another device changes it, Coffer puts the change at the new place.
- **When a merge is not possible:** Coffer keeps both versions. The second one gets "(conflict …)" in its name. Coffer does not overwrite a change from another device.

To resolve a conflict, run **Resolve a file changed on two devices**. For each change, keep the lines from this device, the other device, or both.

![[conflict-resolver.png]]

## Files on demand

Under **Settings → Coffer → What to sync**, turn on **Download only when asked** to keep large files only in storage. Run **Download a file left in storage** to download and open one.

### Keep large files only while in use

With a size set above, set **Keep large files while in use** to a number of days. A file over that size is then on this device only while it is in use:

- it was changed or opened in that many days, or
- a note changed in that many days links to it or embeds it, or
- it is in a folder listed under **Always keep on this device**.

A file in use is downloaded by itself. A file no longer in use is removed from this device at the next sync. It stays in storage and on your other devices, it is not put in the trash, and no other device deletes it. A file you changed here is sent before it is removed.

When you open a note, Coffer gets the files it shows that are in storage: files up to 20 MB at once, larger ones when you choose **Get**. Notes, canvases and files under the size are always on every device. Files linked only from a canvas are not counted as in use: pin their folder.

Set the days to 0 to turn this off. Large files then come only when you choose them, and stay.

## Read-only devices

Turn on **Only receive changes** at setup, or under **Settings → Coffer → Storage and passphrase**. Changes on that device stay there. If you delete a file on it, Coffer downloads it again.

## Safety checks

- A sync that would delete more than 10 files and half of the vault stops and asks first. Run **Sync now, allowing large deletions in the vault** to go on.
- Run **Check synced data for damage** to test what storage holds.

Next: [[History and restore]].
