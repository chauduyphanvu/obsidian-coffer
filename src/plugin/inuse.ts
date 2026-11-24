// Large files this device keeps only while they are in use (What to sync → Keep while in use): the rule the sync asks,
// and getting a note's missing files when it is opened.
import { FileView, Notice, type TFile } from 'obsidian';
import { inUse, type LinkingNote } from '../core/view.ts';
import { errorText, plural } from '../core/text.ts';
import type CofferPlugin from './main.ts';
import { sizeLabel } from './restore.ts';
import type { Share } from './settings.ts';
import { vaultPath } from './shares.ts';

/** A missing file this small comes by itself when a note that shows it is opened; a larger one is offered. */
const GET_UNASKED_BYTES = 20 << 20;
/** The rule is worked out again when asked this long after the last time. */
const RULE_FOR = 5000;

const MB = 1 << 20;

export class InUse {
  private plugin: CofferPlugin;
  private rule?: { at: number; get: (path: string, mtime: number) => boolean; hold: (path: string, mtime: number) => boolean };

  constructor(plugin: CofferPlugin) {
    this.plugin = plugin;
  }

  /** Large files come and go by use on this device. */
  on(): boolean {
    const s = this.plugin.settings;
    return s.viewDays > 0 && s.deferAboveMB > 0;
  }

  /** Obsidian has read every note's links: before that, a file a recent note links to would look unused. */
  ready(): boolean {
    return this.plugin.catalog.ready();
  }

  /**
   * Whether the file at vault `path` is in use (`inUse`). False for every file while the rule is off. For a file that is
   * `here`, what a tab shows now counts too, however long ago it was opened, and so does what a note in a tab links to:
   * nothing on screen is removed. That brings no file in: opening a note does, and asks first for a large one.
   */
  wants(path: string, mtime: number, here = false): boolean {
    if (!this.on()) return false;
    const now = Date.now();
    if (!this.rule || now - this.rule.at > RULE_FOR) {
      const s = this.plugin.settings;
      const since = now - s.viewDays * 86_400_000;
      for (const [p, time] of Object.entries(s.viewOpened)) if (time < since) delete s.viewOpened[p];
      const open = this.openFiles();
      const rule = { now, days: s.viewDays, pins: s.viewPins.split('\n'), opened: Object.entries(s.viewOpened) };
      this.rule = {
        at: now,
        get: inUse(this.notes(since, new Set()), rule),
        hold: inUse(this.notes(since, open), { ...rule, opened: [...rule.opened, ...[...open].map((p): [string, number] => [p, now])] }),
      };
    }
    return here ? this.rule.hold(path, mtime) : this.rule.get(path, mtime);
  }

  /** The vault paths of the files open in a tab, in any window. */
  private openFiles(): Set<string> {
    const out = new Set<string>();
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const file = leaf.view instanceof FileView ? leaf.view.file : null;
      if (file) out.add(file.path);
    });
    return out;
  }

  /** The notes changed since `since` or open in a tab, with what they link to: files that exist by path, the rest as written. */
  private notes(since: number, open: Set<string>): LinkingNote[] {
    const cache = this.plugin.app.metadataCache;
    const out: LinkingNote[] = [];
    for (const f of this.plugin.app.vault.getMarkdownFiles()) {
      const shown = open.has(f.path);
      if (f.stat.mtime < since && !shown) continue;
      out.push({ path: f.path, mtime: shown ? Math.max(f.stat.mtime, since) : f.stat.mtime, links: [...Object.keys(cache.resolvedLinks[f.path] ?? {}), ...Object.keys(cache.unresolvedLinks[f.path] ?? {})] });
    }
    return out;
  }

  /** What notes link to may have changed: the rule is worked out again when next asked. */
  stale(): void {
    this.rule = undefined;
  }

  /** Vault `paths` were opened or asked for just now: they count as in use from here on. */
  opened(paths: string[]): void {
    const s = this.plugin.settings;
    for (const p of paths) s.viewOpened[p] = Date.now();
    this.rule = undefined;
  }

  /**
   * A file was opened. A large file counts as in use; a note gets the files it links to that are left in storage, the
   * small ones at once and the others when the user says so.
   */
  async fileOpened(file: TFile | null): Promise<void> {
    const plugin = this.plugin;
    if (!file || !this.on() || !plugin.configured()) return;
    if (file.extension !== 'md') {
      if (file.stat.size > plugin.settings.deferAboveMB * MB) this.opened([file.path]);
      return;
    }
    const missing = Object.keys(plugin.app.metadataCache.unresolvedLinks[file.path] ?? {});
    if (!missing.length) return;
    const linked = inUse([{ path: file.path, mtime: 1, links: missing }], { now: 1, days: 0, pins: [], opened: [] });
    const left: Left[] = [];
    try {
      for (const share of plugin.targets().filter((s) => !s?.property)) {
        for (const f of await plugin.getEngine(share).deferred({ refresh: false })) if (linked(vaultPath(share, f.path), 0)) left.push({ share, ...f });
      }
    } catch {
      // Storage cannot be asked now: the files stay where they are, on the list in settings.
      return;
    }
    const small = left.filter((f) => f.size <= GET_UNASKED_BYTES);
    const large = left.filter((f) => f.size > GET_UNASKED_BYTES);
    if (small.length) void this.get(small, false);
    if (large.length) this.offer(large);
  }

  private offer(files: Left[]): void {
    const total = sizeLabel(files.reduce((n, f) => n + f.size, 0));
    const what = files.length === 1 ? `“${vaultPath(files[0].share, files[0].path)}” (${total}) is` : `${plural(files.length, 'file')} of this note (${total}) are`;
    const notice = new Notice(
      createFragment((el) => {
        el.createDiv({ text: `${what} in storage, not on this device.` });
        el.createEl('button', { text: 'Get', cls: 'mod-cta coffer-notice-button' }).addEventListener('click', (ev) => {
          ev.stopPropagation();
          notice.hide();
          void this.get(files, true);
        });
      }),
      15_000,
    );
  }

  /** Downloads `files` and counts them as in use. Says so when asked for by hand, or when it fails. */
  private async get(files: Left[], asked: boolean): Promise<void> {
    const working = asked ? new Notice(`Downloading ${plural(files.length, 'file')}…`, 0) : undefined;
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
        const failed = (out.result?.errors ?? []).filter((e) => paths.includes(e.path));
        if (failed.length) throw new Error(failed.map((e) => `${vaultPath(share, e.path)}: ${e.message}`).join('\n'));
      }
    } catch (e) {
      new Notice(`Could not download this note's files: ${errorText(e)}`, 10_000);
    } finally {
      working?.hide();
    }
  }
}

/** A file left in storage, by its path in the vault or in `share`. */
interface Left {
  share?: Share;
  path: string;
  size: number;
}
