// Files left in storage until asked for (What to sync → Download only when asked): a list to choose from.
import { FuzzySuggestModal, Notice, TFile, type App } from 'obsidian';
import { errorText, plural } from '../core/text.ts';
import type CofferPlugin from './main.ts';
import { lookup } from './obsidianfs.ts';
import { sizeLabel } from './restore.ts';
import type { Share } from './settings.ts';
import { vaultPath } from './shares.ts';

/** A file left in storage, by its path in the vault or in `share`. */
interface Left {
  share?: Share;
  path: string;
  size: number;
}

type Choice = { all: Left[] } | { one: Left };

/** Looks in the storage of the vault and every shared folder, then lists what is left there. */
export async function chooseDeferred(plugin: CofferPlugin): Promise<void> {
  const looking = new Notice('Looking in storage…', 0);
  const left: Left[] = [];
  try {
    // Notes shared by a property only send: nothing is downloaded into the vault through them.
    for (const share of plugin.targets().filter((s) => !s?.property)) {
      for (const f of await plugin.getEngine(share).deferred()) left.push({ share, ...f });
    }
  } catch (e) {
    new Notice(`Could not look in storage: ${errorText(e)}`, 10_000);
    return;
  } finally {
    looking.hide();
  }
  if (!left.length) new Notice('No file is left in storage: every file within the limits set on this device is here.');
  else new DeferredModal(plugin.app, plugin, left).open();
}

/** Choosing a file downloads it and opens it; the first entry downloads them all. */
class DeferredModal extends FuzzySuggestModal<Choice> {
  private plugin: CofferPlugin;
  private left: Left[];

  constructor(app: App, plugin: CofferPlugin, left: Left[]) {
    super(app);
    this.plugin = plugin;
    this.left = left;
    this.setPlaceholder('Download a file left in storage…');
  }

  getItems(): Choice[] {
    return [{ all: this.left }, ...this.left.map((one) => ({ one }))];
  }

  getItemText(c: Choice): string {
    if ('all' in c) return `All ${c.all.length.toLocaleString()} (${sizeLabel(c.all.reduce((n, f) => n + f.size, 0))})`;
    return `${vaultPath(c.one.share, c.one.path)} · ${sizeLabel(c.one.size)}`;
  }

  onChooseItem(c: Choice): void {
    void this.download('all' in c ? c.all : [c.one]);
  }

  private async download(files: Left[]): Promise<void> {
    const working = new Notice(`Downloading ${plural(files.length, 'file')}…`, 0);
    const failed: string[] = [];
    try {
      const places = new Map<string, { share?: Share; paths: string[] }>();
      for (const f of files) {
        const place = places.get(f.share?.id ?? '') ?? { share: f.share, paths: [] };
        place.paths.push(f.path);
        places.set(f.share?.id ?? '', place);
      }
      for (const { share, paths } of places.values()) {
        const out = await this.plugin.fetchDeferred(paths, share);
        if (out.problem) throw new Error(`${out.problem.title}. ${out.problem.detail}`);
        for (const e of out.result?.errors ?? []) if (paths.includes(e.path)) failed.push(`${vaultPath(share, e.path)}: ${e.message}`);
      }
    } catch (e) {
      new Notice(`Could not download: ${errorText(e)}`, 10_000);
      return;
    } finally {
      working.hide();
    }
    if (failed.length) new Notice(`Could not download ${plural(failed.length, 'file')}.\n${failed.join('\n')}`, 10_000);
    if (failed.length === files.length) return;
    if (files.length === 1) {
      const file = lookup(this.app, vaultPath(files[0].share, files[0].path));
      if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file);
    } else new Notice(`Downloaded ${plural(files.length - failed.length, 'file')}.`);
  }
}
