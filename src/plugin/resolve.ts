// Settling a file changed on two devices: change by change when it is text, otherwise by keeping whole files.
import { Modal, Notice, TFile, type App } from 'obsidian';
import { applyChoices, hunks, type Choice, type Hunk } from '../core/merge.ts';
import { conflictOriginal, fileName } from '../core/paths.ts';
import { errorText, plural } from '../core/text.ts';
import type SelfSyncPlugin from './main.ts';
import { lookup } from './obsidianfs.ts';
import { MAX_COMPARE_BYTES, compareConflict, unchangedSince, type Comparison, type Snapshot, type WholeReason } from './status.ts';
import { button, buttonRow, choice, message, openLink } from './ui.ts';

/** Shared lines shown above and below a change. */
const CONTEXT = 3;

const WHY: Record<WholeReason, (name: string) => string> = {
  missing: (name) => `There is no “${name}” any more: it was deleted or renamed. Only this device's version is left.`,
  same: () => 'The two versions are the same, so the copy is not needed.',
  large: () => 'These versions are too large to compare here. Open each to look, then choose which to keep.',
  binary: () => "This kind of file can't be compared line by line. Open each version to look, then choose which to keep.",
  structured: () => 'Mixing lines from two versions could break this kind of file. Open each version to look, then choose which to keep.',
  different: () => 'The two versions are too different to compare line by line. Open each to look, then choose which to keep.',
};

/** Opens the resolver for one conflict copy. */
export function resolveConflict(plugin: SelfSyncPlugin, copy: string): void {
  new ConflictModal(plugin.app, plugin, copy).open();
}

/** Opens the resolver for the first conflict copy still waiting, or says there is none. */
export function resolveFirstConflict(plugin: SelfSyncPlugin): void {
  const copy = plugin.allConflictCopies().find((p) => lookup(plugin.app, p) instanceof TFile);
  if (copy) resolveConflict(plugin, copy);
  else new Notice('No files are waiting to be resolved.');
}

/** Lines as written, one block each, without their line endings. */
function showLines(parent: HTMLElement, lines: string[], cls: string): void {
  if (!lines.length) return;
  const box = parent.createDiv({ cls: `self-sync-lines ${cls}` });
  for (const l of lines) box.createDiv({ cls: 'self-sync-line', text: l.replace(/\r?\n$/, '') });
}

class ConflictModal extends Modal {
  private plugin: SelfSyncPlugin;
  /** This device's version, kept aside by the sync. */
  private copy: string;
  /** The other device's version, under the original name. */
  private original: string;
  private name: string;
  /** Both files as they were compared; nothing is written unless they are still so. */
  private shown?: { mine: Snapshot; theirs?: Snapshot };
  private comparison?: Comparison;
  private hunks: Hunk[] = [];
  private choices: (Choice | undefined)[] = [];
  private at = 0;
  private error = '';
  private stale = '';
  private busy = false;

  constructor(app: App, plugin: SelfSyncPlugin, copy: string) {
    super(app);
    this.plugin = plugin;
    this.copy = copy;
    this.original = conflictOriginal(copy);
    this.name = fileName(this.original);
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal', 'self-sync-resolve');
    this.setTitle(this.name);
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.createEl('p', { cls: 'self-sync-intro', text: 'Comparing the two versions…' });
    this.error = this.stale = '';
    this.busy = false;
    try {
      const mine = await this.snapshot(this.copy);
      if (!mine) {
        await this.forget();
        new Notice(`The conflict copy of “${this.name}” is already gone.`);
        this.close();
        return;
      }
      const theirs = await this.snapshot(this.original);
      this.shown = { mine, theirs };
      this.comparison = compareConflict(this.original, mine, theirs);
      this.hunks = this.comparison.kind === 'lines' ? hunks(this.comparison.regions, CONTEXT) : [];
      this.choices = this.hunks.map(() => undefined);
      this.at = 0;
    } catch (e) {
      this.comparison = undefined;
      this.error = `Could not read the two versions: ${errorText(e)}`;
    }
    this.render();
  }

  private file(path: string): TFile | undefined {
    const f = lookup(this.app, path);
    return f instanceof TFile ? f : undefined;
  }

  /** The file as it is on disk now; undefined when there is none. */
  private async snapshot(path: string): Promise<Snapshot | undefined> {
    const file = this.file(path);
    const stat = file && (await this.app.vault.adapter.stat(file.path));
    if (!file || !stat) return undefined;
    const data = stat.size <= MAX_COMPARE_BYTES ? new Uint8Array(await this.app.vault.readBinary(file)) : undefined;
    return { size: stat.size, mtime: stat.mtime, data };
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.comparison) {
      message(c, this.error);
      button(buttonRow(c), 'Close', () => this.close());
    } else if (this.comparison.kind === 'lines') this.renderChanges(c);
    else this.renderWhole(c, this.comparison.reason);
  }

  private renderChanges(c: HTMLElement): void {
    const total = this.hunks.length;
    const h = this.hunks[this.at];
    const picked = this.choices[this.at];
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: total === 1 ? 'The two versions differ in one place. Choose what to keep.' : `The two versions differ in ${total} places. Choose what to keep at each.`,
    });
    if (total > 1) {
      const nav = c.createDiv({ cls: 'self-sync-resolve-nav' });
      nav.createDiv({ cls: 'self-sync-resolve-count', text: `Change ${this.at + 1} of ${total}` });
      button(nav, '', () => this.go(this.at - 1)).setIcon('chevron-left').setTooltip('Previous change').setDisabled(this.at === 0);
      button(nav, '', () => this.go(this.at + 1)).setIcon('chevron-right').setTooltip('Next change').setDisabled(this.at === total - 1);
    }

    const card = c.createDiv({ cls: 'self-sync-hunk' });
    showLines(card, h.before, 'self-sync-context');
    this.side(card, 'This device', h.change.a, 'mine', picked);
    this.side(card, 'Other device', h.change.b, 'theirs', picked);
    showLines(card, h.after, 'self-sync-context');

    c.createDiv({ cls: 'self-sync-pick-label', text: 'Keep' });
    const pick = c.createDiv({ cls: 'self-sync-pick' });
    const options: [Choice, string][] = [['mine', 'This device'], ['theirs', 'Other device']];
    if (h.change.a.length && h.change.b.length) options.push(['both', 'Both']);
    for (const [value, text] of options) {
      const b = button(pick, text, () => this.choose(value)).setDisabled(this.busy);
      b.buttonEl.toggleClass('is-selected', picked === value);
      b.buttonEl.setAttr('aria-pressed', String(picked === value));
    }
    if (options.length === 3) c.createDiv({ cls: 'self-sync-hint', text: "Both keeps this device's lines first, then the other device's." });
    if (total > 1) {
      const all = buttonRow(c);
      button(all, 'Use all from this device', () => this.chooseAll('mine')).setDisabled(this.busy);
      button(all, 'Use all from other device', () => this.chooseAll('theirs')).setDisabled(this.busy);
    }

    const left = this.choices.filter((x) => !x).length;
    this.footer(c, left ? `Still to choose: ${plural(left, 'change')}.` : '', () => this.saveLines(), left > 0);
  }

  private side(parent: HTMLElement, label: string, lines: string[], which: 'mine' | 'theirs', picked: Choice | undefined): void {
    const box = parent.createDiv({ cls: `self-sync-side is-${which}` });
    const kept = picked === which || picked === 'both';
    if (picked) box.addClass(kept ? 'is-kept' : 'is-dropped');
    const head = box.createDiv({ cls: 'self-sync-side-label' });
    head.createSpan({ text: label });
    if (picked) head.createSpan({ cls: 'self-sync-side-state', text: kept ? 'Keeping' : 'Not keeping' });
    if (lines.length) showLines(box, lines, 'self-sync-changed');
    else box.createDiv({ cls: 'self-sync-none', text: 'Not in this version' });
  }

  private go(at: number): void {
    this.at = Math.max(0, Math.min(this.hunks.length - 1, at));
    this.render();
    this.contentEl.querySelector('.self-sync-resolve-nav')?.scrollIntoView({ block: 'nearest' });
  }

  /** A first choice at a change moves on to the next one still open. */
  private choose(value: Choice): void {
    const first = !this.choices[this.at];
    this.choices[this.at] = value;
    const n = this.choices.length;
    const next = first ? [...Array(n).keys()].map((k) => (this.at + k) % n).find((i) => !this.choices[i]) : undefined;
    if (next === undefined) this.render();
    else this.go(next);
  }

  private chooseAll(value: Choice): void {
    this.choices = this.hunks.map(() => value);
    this.render();
  }

  private async saveLines(): Promise<void> {
    const choices = this.choices.filter((x): x is Choice => !!x);
    if (this.comparison?.kind !== 'lines' || choices.length !== this.hunks.length) return;
    const text = applyChoices(this.comparison.regions, choices);
    await this.settle(async (copy, original) => {
      await this.app.vault.modify(original!, text);
      await this.app.fileManager.trashFile(copy);
    }, `Saved “${this.name}”.`);
  }

  private renderWhole(c: HTMLElement, reason: WholeReason): void {
    c.createEl('p', { cls: 'self-sync-intro', text: WHY[reason](this.name) });
    const files = c.createDiv({ cls: 'self-sync-files' });
    this.fileRow(files, 'This device', this.copy);
    if (reason !== 'missing') this.fileRow(files, 'Other device', this.original);

    const options = c.createDiv({ cls: 'self-sync-options' });
    const option = (title: string, hint: string, run: () => Promise<void>) => {
      choice(options, title, hint, () => void run()).disabled = this.busy;
    };
    const trashCopy = (copy: TFile) => this.app.fileManager.trashFile(copy);
    if (reason === 'same') {
      option('Remove the copy', 'Nothing is lost: the other file is the same.', () => this.settle(trashCopy, `Removed the copy of “${this.name}”.`));
      option('Keep both files', 'Takes this off the list.', () => this.keepBoth());
    } else if (reason === 'missing') {
      option("Keep this device's version", `Puts it back as “${this.name}”.`, () =>
        this.settle((copy) => this.app.fileManager.renameFile(copy, this.original), `Kept this device's version of “${this.name}”.`),
      );
      option('Remove the copy', `Leaves no file called “${this.name}”.`, () => this.settle(trashCopy, `Removed the copy of “${this.name}”.`));
      option('Keep the copy as it is', 'Takes it off this list.', () => this.keepBoth());
    } else {
      option("Keep this device's version", "Replaces the other device's version.", () =>
        this.settle(async (copy, original) => {
          await this.app.vault.modifyBinary(original!, await this.app.vault.readBinary(copy));
          await this.app.fileManager.trashFile(copy);
        }, `Kept this device's version of “${this.name}”.`),
      );
      option("Keep the other device's version", "Removes this device's copy.", () => this.settle(trashCopy, `Kept the other device's version of “${this.name}”.`));
      option('Keep both', 'Leaves both files as they are and takes this off the list.', () => this.keepBoth());
    }
    this.footer(c, '');
  }

  private fileRow(parent: HTMLElement, label: string, path: string): void {
    const row = parent.createDiv({ cls: 'self-sync-file' });
    row.createSpan({ text: `${label}: ${fileName(path)}` });
    openLink(row, this.app, 'Open', path, () => this.close());
  }

  /** Errors, then Cancel and, when there is something to save, Save; after a file changed underneath, only Compare again. */
  private footer(c: HTMLElement, hint: string, save?: () => Promise<void>, blocked = false): void {
    message(c, this.error);
    if (this.stale) {
      message(c, this.stale);
      button(buttonRow(c), 'Compare again', () => this.load(), 'cta');
      return;
    }
    if (hint) c.createDiv({ cls: 'self-sync-hint', text: hint });
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    if (save) button(row, this.busy ? 'Saving…' : 'Save', save, 'cta').setDisabled(blocked || this.busy);
  }

  /** Runs `change` only if neither file changed since they were compared, then takes the copy off the list. */
  private async settle(change: (copy: TFile, original: TFile | undefined) => Promise<void>, done: string): Promise<void> {
    const shown = this.shown;
    if (this.busy || !shown) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const [mine, theirs] = await Promise.all([this.snapshot(this.copy), this.snapshot(this.original)]);
      const copyChanged = !unchangedSince(shown.mine, mine);
      const originalChanged = !unchangedSince(shown.theirs, theirs);
      if (copyChanged || originalChanged) {
        const what = copyChanged && originalChanged ? 'Both versions' : copyChanged ? "This device's copy" : `“${this.name}”`;
        this.stale = `${what} changed while you were choosing, so nothing was saved. Compare again to see the latest.`;
        this.busy = false;
        this.render();
        return;
      }
      await change(this.file(this.copy)!, this.file(this.original));
      await this.forget();
      new Notice(done);
      this.close();
    } catch (e) {
      this.busy = false;
      this.error = `Could not finish: ${errorText(e)}`;
      this.render();
    }
  }

  private async keepBoth(): Promise<void> {
    await this.forget();
    new Notice(`Kept both versions of “${this.name}”.`);
    this.close();
  }

  private async forget(): Promise<void> {
    await this.plugin.forgetConflictCopy(this.copy);
  }
}
