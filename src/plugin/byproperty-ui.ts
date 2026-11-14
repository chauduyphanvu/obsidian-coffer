// Notes shared by a property on screen: what is shared and what waits, and taking notes out. The logic is in
// byproperty.ts; starting one is a path of ShareModal (sharing.ts).
import { Modal, Notice, TFile, type App } from 'obsidian';
import { fileName } from '../core/paths.ts';
import { errorText, plural } from '../core/text.ts';
import { isNote, removedText, type Survey } from './byproperty.ts';
import type CofferPlugin from './main.ts';
import { lookup } from './obsidianfs.ts';
import type { Share } from './settings.ts';
import { button, buttonRow, message, openLink } from './ui.ts';

/** How many files a list shows before it says how many more there are. */
const SHOWN = 200;

const title = (path: string) => fileName(path).replace(/\.md$/i, '');

/** "What's shared": the files in the share, what waits for the sharer, and what is not shared and why. */
export class WhatsSharedModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private survey?: Survey;
  private error = '';
  private busy = false;
  private loading = false;
  private unsubscribe?: () => void;
  /** What the last sync of this share found, when this screen last looked: another one means a sync finished since. */
  private synced?: Survey;
  private running = false;
  /** The Remove dialog opened from here is up: looking again waits until it closes. */
  private child = false;
  /** Something changed while this screen could not look again. */
  private stale = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.survey = this.synced = this.plugin.surveyOf(this.share);
    this.running = this.plugin.running;
    // Looks again when a sync of this share finishes, also one started elsewhere, or when Obsidian has read the vault.
    this.unsubscribe = this.plugin.onChange(() => {
      const synced = this.plugin.surveyOf(this.share);
      if (synced !== this.synced || (this.survey && !this.survey.ready && this.plugin.catalog.ready())) {
        this.synced = synced;
        this.refresh();
      } else if (this.running !== this.plugin.running && !this.busy) {
        if (this.child) this.stale = true;
        else this.render();
      }
      this.running = this.plugin.running;
    });
    this.render();
    void this.load();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private refresh(): void {
    if (this.busy || this.loading || this.child) this.stale = true;
    else void this.load();
  }

  private async load(): Promise<void> {
    this.loading = true;
    this.stale = false;
    try {
      this.survey = await this.plugin.lookAtShared(this.share);
      this.error = '';
    } catch (e) {
      this.error = `Could not look at the vault: ${errorText(e)}`;
    }
    this.loading = false;
    this.busy = false;
    if (this.stale && !this.child) return this.load();
    this.render();
  }

  /** Runs `act`, then looks again; what fails is said on the screen. */
  private async act(act: () => Promise<unknown>): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await act();
    } catch (e) {
      this.error = errorText(e);
    }
    await this.load();
  }

  /** Draws the screen again where it was scrolled to. */
  private render(): void {
    const at = [this.modalEl.scrollTop, this.contentEl.scrollTop];
    this.draw();
    [this.modalEl.scrollTop, this.contentEl.scrollTop] = at;
  }

  private draw(): void {
    const c = this.contentEl;
    const name = this.share.property;
    const v = this.survey;
    c.empty();
    this.setTitle(`What's shared in “${name}”`);
    c.createEl('p', { cls: 'coffer-intro', text: `Notes whose properties say share: ${name} are shared, with the pictures, sound, video and PDF files they show. They stay where they are in your vault.` });
    message(c, this.error);
    if (!v) {
      c.createEl('p', { cls: 'coffer-progress', text: 'Looking at the vault…' });
      return;
    }
    if (!v.ready) message(c, 'Obsidian is still reading this vault. New notes join once it has; what is shared already keeps syncing.', 'coffer-note');
    const close = () => this.close();
    const disabled = this.busy;

    if (v.waiting.length) {
      const list = this.section(c, 'Waiting for you', 'These files are not sent until you say so.');
      for (const w of v.waiting) {
        const why = w.why === 'name' ? `“${title(w.note)}” shows it, and another file in this vault has the same name.` : `A suggestion you took in made “${title(w.note)}” show it.`;
        const row = this.row(list, w.key, why);
        openLink(row, this.app, 'Open', w.key, close);
        button(row, 'Share it', () => this.act(() => this.plugin.shareFiles(this.share, [w.key])), 'cta').setDisabled(disabled);
        button(row, "Don't share", () => this.act(() => this.plugin.keepOutOf(this.share, [w.key]))).setDisabled(disabled);
      }
    }

    if (v.unmarked.length) {
      const list = this.section(c, `No longer say share: ${name}`, `They stay in “${name}”, and what you change in them is not sent until you choose.`);
      for (const key of v.unmarked) {
        const row = this.row(list, key);
        openLink(row, this.app, 'Open', key, close);
        button(row, `Keep in “${name}”`, () => this.act(() => this.keep(key)), 'cta').setDisabled(disabled);
        button(row, 'Remove…', () => this.remove([key])).setDisabled(disabled);
      }
    }

    const fresh = new Set([...v.fresh, ...v.moved.map(([, to]) => to)]);
    if (fresh.size) {
      const list = this.section(c, 'Sent at the next sync', '');
      for (const key of [...fresh].slice(0, SHOWN)) this.row(list, key, v.moved.some(([, to]) => to === key) ? 'Moved here' : '');
      this.more(list, fresh.size);
    }

    const shared = [...v.shared.keys()].filter((k) => !fresh.has(k)).sort();
    const notes = shared.filter(isNote).length;
    const list = this.section(c, `In “${name}” (${plural(notes, 'note')}, ${plural(shared.length - notes, 'file')})`, shared.length ? '' : `Nothing yet. Add share: ${name} to a note's properties, or choose Add to “${name}” in a note's menu.`);
    for (const key of shared.slice(0, SHOWN)) button(this.row(list, key), 'Remove…', () => this.remove([key])).setDisabled(disabled);
    this.more(list, shared.length);

    if (v.unused.length) {
      const unused = this.section(c, 'Files no shared note shows any more', `They stay in “${name}” until you remove them.`);
      for (const key of v.unused.slice(0, SHOWN)) this.row(unused, key);
      this.more(unused, v.unused.length);
      button(buttonRow(unused), v.unused.length === 1 ? 'Remove it…' : 'Remove them…', () => this.remove(v.unused)).setDisabled(disabled);
    }

    if (v.stored.length) {
      const stored = this.section(c, `Only in “${name}”`, `Gone from your vault, and still in “${name}” for the people who have them.`);
      for (const key of v.stored.slice(0, SHOWN)) button(this.row(stored, key), 'Remove…', () => this.remove([key])).setDisabled(disabled);
      this.more(stored, v.stored.length);
    }

    if (v.removedTagged.length) {
      const removed = this.section(c, 'You took these out', `A shared note shows them, or their properties say share: ${name} again. They stay out until you share them again.`);
      for (const key of v.removedTagged) button(this.row(removed, key), 'Share again', () => this.act(() => this.plugin.shareFiles(this.share, [key]))).setDisabled(disabled);
    }

    if (v.notShared.length) {
      const not = this.section(c, 'Not shared', '');
      for (const n of v.notShared.slice(0, SHOWN)) this.row(not, n.key, this.whyNot(n));
      this.more(not, v.notShared.length);
    }

    const row = buttonRow(c);
    button(row, 'Close', () => this.close());
    button(row, this.plugin.running ? 'Syncing…' : 'Sync now', () => this.act(() => this.plugin.sync(true)), 'cta').setDisabled(disabled || this.plugin.running);
  }

  private whyNot(n: Survey['notShared'][number]): string {
    if (n.why === 'conflict') return `A conflict copy of a note that is not in “${this.share.property}”.`;
    const folder = this.plugin.placeOf(n.key).share;
    return folder ? `It is in the shared folder “${folder.folder}”.` : 'This vault leaves it out of sync on this device.';
  }

  private section(c: HTMLElement, heading: string, hint: string): HTMLElement {
    c.createDiv({ cls: 'coffer-section-title', text: heading });
    if (hint) c.createDiv({ cls: 'coffer-hint', text: hint });
    return c.createDiv({ cls: 'coffer-files' });
  }

  private row(list: HTMLElement, path: string, sub = ''): HTMLElement {
    const row = list.createDiv({ cls: 'coffer-file' });
    const text = row.createSpan({ text: path });
    if (sub) text.createDiv({ cls: 'coffer-hint', text: sub });
    return row;
  }

  private more(list: HTMLElement, n: number): void {
    if (n > SHOWN) list.createDiv({ cls: 'coffer-hint', text: `…and ${(n - SHOWN).toLocaleString()} more` });
  }

  private async keep(key: string): Promise<void> {
    const file = lookup(this.app, key);
    if (!(file instanceof TFile)) throw new Error(`“${key}” is not in this vault any more.`);
    await this.plugin.shareNote(this.share, file);
  }

  private remove(paths: string[]): void {
    this.child = true;
    new RemoveModal(this.app, this.plugin, this.share, paths, (removed) => {
      this.child = false;
      if (removed || this.stale) void this.load();
    }).open();
  }
}

/**
 * Taking files out of notes shared by a property, after saying what that does. A note can take the files only it shows
 * with it; that box waits until Obsidian has read the vault, and is checked against every other shared note's bytes.
 */
export class RemoveModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private paths: string[];
  /** Called when the dialog closes, with whether it removed them. */
  private closed?: (removed: boolean) => void;
  private removed = false;
  /** Attachments in the share that only the one note removed shows, once known. */
  private only?: string[];
  private withFiles = false;
  private busy = false;
  private error = '';

  constructor(app: App, plugin: CofferPlugin, share: Share, paths: string[], closed?: (removed: boolean) => void) {
    super(app);
    this.plugin = plugin;
    this.share = share;
    this.paths = paths;
    this.closed = closed;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.render();
    const [one] = this.paths;
    if (this.paths.length === 1 && isNote(one)) {
      this.plugin.filesOnlyIn(this.share, one).then(
        (only) => {
          this.only = only;
          this.render();
        },
        () => (this.only = []),
      );
    }
  }

  onClose(): void {
    this.contentEl.empty();
    this.closed?.(this.removed);
  }

  private render(): void {
    const c = this.contentEl;
    const name = this.share.property;
    const notes = this.paths.filter(isNote);
    const days = this.plugin.settings.retentionDays;
    c.empty();
    this.setTitle(this.paths.length === 1 ? `Remove “${title(this.paths[0])}” from “${name}”?` : `Remove ${plural(this.paths.length, 'file')} from “${name}”?`);
    const one = this.paths.length === 1;
    // Files kept in the share after they were deleted here are only in the share.
    const here = this.paths.some((p) => lookup(this.app, p) instanceof TFile);
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `${one ? 'It is' : 'They are'} deleted from “${name}” on everyone's devices. They can bring ${one ? 'it' : 'them'} back from its history for ${plural(days, 'day')}.${here ? ` ${one ? 'It stays' : 'They stay'} in your vault.` : ''}`,
    });
    if (notes.length) {
      if (here) c.createEl('p', { cls: 'coffer-intro', text: `share: ${name} is taken out of ${notes.length === 1 && one ? 'its' : 'the notes’'} properties, so ${one ? 'it is' : 'they are'} not shared again.` });
    } else c.createEl('p', { cls: 'coffer-intro', text: 'A shared note that shows it looks like the file is missing to the others.' });
    if (this.only?.length) {
      const label = c.createEl('label', { cls: 'coffer-check' });
      const box = label.createEl('input', { attr: { type: 'checkbox' } });
      box.checked = this.withFiles;
      box.addEventListener('change', () => (this.withFiles = box.checked));
      label.appendText(` Also remove ${plural(this.only.length, 'file')} only this note shows: ${this.only.map((k) => fileName(k)).join(', ')}`);
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    button(row, this.busy ? 'Removing…' : `Remove from “${name}”`, () => this.remove(), 'warning').setDisabled(this.busy);
  }

  private async remove(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.render();
    const paths = [...this.paths, ...(this.withFiles ? (this.only ?? []) : [])];
    try {
      const { problems, pending, why } = await this.plugin.removeFromShare(this.share, paths);
      this.removed = true;
      this.close();
      new Notice([removedText(this.share.property, paths, pending, why), ...problems].join('\n'), problems.length || pending ? 15_000 : 5000);
    } catch (e) {
      this.busy = false;
      this.error = `Could not remove it: ${errorText(e)}`;
      this.render();
    }
  }
}

/** What a share by property shows on its row: how many notes and files it holds, as of its last sync. */
export function sharedCounts(survey: Survey | undefined): string {
  if (!survey) return '';
  const keys = [...survey.shared.keys()];
  const notes = keys.filter(isNote).length;
  return `${plural(notes, 'note')}, ${plural(keys.length - notes, 'file')}`;
}
