Coffer keeps every version for 1 day, hourly versions for 1 week, and daily versions for 30 days. You can change the 30 days in settings.

- **One file:** run **Show version history of the current file** to see its versions, what changed in each, and to restore one.
- **Deleted files:** run **Restore deleted files**.
- **The vault or a folder at an earlier time:** run **Restore the vault or a folder to an earlier time**. Each time in the list is when a device synced. Coffer shows which files come back and which change before it does anything.

- **Look before you restore:** run **Rewind: look through the vault as it was at an earlier time**. A tab opens with a slider of the times a device synced. Pick one and browse the vault as it was then: notes are shown as Obsidian shows them, their links lead to the other notes of that time, and their pictures are the ones from then. Nothing changes until you choose to bring a file back, and you see what that would change first.
- **Undo one change:** run **Show recent changes**, find the change, and choose **Undo**. Coffer takes that one change back out and keeps everything done since: a note edited later keeps those edits, and a file that was only moved goes back to its old name with what it holds now. What one device sent within a minute counts as one change. A file that cannot be undone safely, such as one edited later in the same lines, is left as it is and named. Undo is exact for changes from the last day; for older ones, the version from before may already be thinned out of history, and then that file is left as it is.

![[restore-earlier.png]]

A restore does not lose what files hold now: Coffer syncs it first, so it stays in their version history and you can undo the restore. Your other devices get the result when they next sync.

Next: [[Shared folders]].
