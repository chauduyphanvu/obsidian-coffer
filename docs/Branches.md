A branch is a second line of your vault's history. A device on a branch has the branch's files and syncs with the other devices on it. Your other devices carry on with the main line as if nothing happened. Later you merge the branch back, or close it and drop what it changed.

Use one to try something large without doing it to every device at once: reorganise folders, rename a hundred notes, clean out an archive. Look at the result on one device for a few days, then merge it or throw it away.

Stored data is shared between lines, so a branch costs only what changes on it.

## Before the first branch

A vault has to be upgraded once before it can have branches. Coffer offers this when you start the first one. After the upgrade, a version of Coffer before 0.12.0 refuses to open the vault and asks to be updated, because its cleanup would delete data a branch still needs. So Coffer upgrades only when every device that syncs the vault has reported a version with branches. Update Coffer on each device and sync once; a device that is gone for good can be forgotten under **Settings → Coffer → Devices**.

The upgrade cannot be undone. Nothing else about the vault changes, and a vault you never upgrade works exactly as before.

## Use a branch

Run **Branches: start, switch, merge or close**, or open **Settings → Coffer → Devices → Branches**.

- **Start.** Give the branch a name. It starts as the vault is now, and this device is on it at once. No file changes. Other devices stay where they are until they switch.
- **Switch.** A device takes the files of the line it switches to. Coffer syncs first, then changes only the files that differ; nothing is sent as a deletion. If an edit could not be sent first, it is merged into the line you go to, or kept as a conflict copy.
- **Merge.** On the main line, **Merge into the main line** brings the branch's changes in. On the branch, **Bring in the main line** does the opposite. You see what will change before anything does:
  - A file only the other line changed is taken as it is.
  - A note changed on both lines is combined, the way a sync combines edits from two devices.
  - Where that cannot be done, both versions are kept, the other line's as a conflict copy.
  - A file edited on one line and deleted on the other stays.
  - A file or folder moved on one line takes the other line's edits and new files with it.

  A merge downloads and uploads almost nothing, because the versions it takes are already in storage; a file this device leaves in storage stays there. It is one change in the history, so **Undo** in **Show recent changes** takes it back out. The branch stays open and can be merged again.
- **Close.** A closed branch takes no more changes. What it holds that was never merged can no longer be reached, and its data is removed from storage 30 days later. A device still on it is told at its next sync and offered **Switch to the main line**; what it had not sent yet goes along.

The status bar names the branch a device is on, and the device list says which line each device is on.

## Good to know

- Version history, Rewind and Undo work on a branch, and reach back before the branch started.
- A branch merges with the main line only, and a new branch starts from the main line.
- Shared folders have one line. Branches are for the vault.
- With **Live link** on, devices link only with devices on the same line.
- If the app is closed in the middle of a switch, the next sync finishes it.

From the command line: `branch`, `branch start <name>`, `branch switch <name|main>`, `branch merge <name> [--dry-run]`, `branch close <name>` and `upgrade`. See [[Command line]].
