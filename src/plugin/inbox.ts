// Suggestions on screen: a read member sending what it changed to the owner, and the owner's list of suggestions, each
// file looked at beside the folder as it is now, then taken in or left out. Decisions live in suggestions.ts.
import { Modal, Notice, type App } from 'obsidian';
import type { WaitingSuggestion } from '../core/engine.ts';
import { fileName } from '../core/paths.ts';
import type { SuggestedFile, Suggestion } from '../core/suggest.ts';
import { errorText } from '../core/text.ts';
import type CofferPlugin from './main.ts';
import { sharePolicy } from './members.ts';
import { ChangePicker } from './resolve.ts';
import { momentLabel } from './restore.ts';
import { labelOf, type Share } from './settings.ts';
import { MAX_COMPARE_BYTES, asText, type Snapshot } from './status.ts';
import { filesLine, isRefused, moreWaitingText, movedTo, refusedText, reviewSuggested, reviewText, sentText, suggestable, type Review } from './suggestions.ts';
import { showDiff, showWhole } from './timemachine.ts';
import { button, buttonRow, message } from './ui.ts';

/** A read member's changes to `share`, sent to its owner as one suggestion. */
export class SendSuggestionModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private notes: string[] = [];
  private others: string[] = [];
  private error = '';
  private busy = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    ({ notes: this.notes, others: this.others } = suggestable(this.plugin.unsentOf(this.share)));
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private owner(): string {
    return this.plugin.standingOf(this.share)?.owner || 'the owner';
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    const owner = this.owner();
    this.setTitle('Send as a suggestion');
    if (!this.notes.length) {
      c.createEl('p', {
        cls: 'coffer-intro',
        text: this.others.length
          ? 'Only notes and canvases can be suggested, and none of the files changed here is one.'
          : `Nothing is changed in “${labelOf(this.share)}” on this device.`,
      });
      button(buttonRow(c), 'Close', () => this.close(), 'cta');
      return;
    }
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `Send what you changed in “${labelOf(this.share)}” to ${owner}. ${owner} sees each note beside the folder as it is now, and takes it in or leaves it out. Your own copy here stays as it is.`,
    });
    const list = c.createDiv({ cls: 'coffer-files' });
    for (const path of this.notes) list.createDiv({ cls: 'coffer-file', text: path });
    if (this.others.length) {
      c.createDiv({ cls: 'coffer-hint', text: `Not sent, because only notes and canvases can be suggested: ${this.others.join(', ')}` });
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    button(row, this.busy ? 'Sending…' : 'Send suggestion', () => this.send(), 'cta').setDisabled(this.busy);
  }

  private async send(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const out = await this.plugin.sendSuggestion(this.share, this.notes);
      const text = sentText(out, this.owner(), (p) => p);
      if (out.sent.length) {
        new Notice(text, 10_000);
        this.close();
        return;
      }
      this.error = text;
    } catch (e) {
      this.error = isRefused(e) ? refusedText(this.plugin.standingOf(this.share)?.owner ?? '', sharePolicy(this.share, 'readAndInbox').title) : `Could not send it: ${errorText(e)}`;
    }
    this.busy = false;
    this.render();
  }
}

type View = 'list' | 'one' | 'file';

/** Owner: the suggestions members sent for `share`; each file looked at, then taken into the folder or left out. */
export class SuggestionsModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private view: View = 'list';
  private items?: WaitingSuggestion[];
  /** How many more wait behind `items`, which are only the newest. */
  private more = 0;
  private loading = false;
  private error = '';
  private busy = false;
  /** The suggestion open, its sender's name, and the file looked at. */
  private chosen?: { s: Suggestion; name: string };
  private file?: SuggestedFile;
  /** What taking the file in does, worked out against the file as it was `shown`; `at` is where it is now, if it moved. */
  private review?: Review;
  private shown?: Snapshot;
  private at = '';
  private moved?: string;
  private picker?: ChangePicker;
  private whole = false;
  private stale = '';
  /** Why files of the suggestion open can not be taken in, by path, as worked out before anything of them is read. */
  private refused = new Map<string, string>();
  /** Why the file looked at can not be taken in; then nothing of what is at its path was read. */
  private refusedWhy = '';

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past', 'coffer-resolve');
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.view = 'list';
    this.loading = true;
    this.busy = false;
    this.render();
    try {
      ({ items: this.items, more: this.more } = await this.plugin.suggestions(this.share));
      this.error = '';
    } catch (e) {
      this.error = `Could not read the suggestions: ${errorText(e)}`;
    }
    this.loading = false;
    if (this.view === 'list') this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (this.view === 'list') this.listView(c);
    else if (this.view === 'one') this.oneView(c);
    else this.fileView(c);
  }

  /** A device that only receives may not change the folder or its storage, which taking a suggestion does. */
  private locked(c: HTMLElement): boolean {
    if (!this.plugin.receivesOnly(this.share)) return false;
    message(c, 'This device only receives changes for this folder, so it can not take suggestions in. Turn off Only receive changes on its row first.', 'coffer-note');
    return true;
  }

  private listView(c: HTMLElement): void {
    this.setTitle(`Suggestions for “${labelOf(this.share)}”`);
    const locked = this.locked(c);
    if (this.loading && !this.items) c.createEl('p', { cls: 'coffer-progress', text: 'Reading the suggestions…' });
    else if (this.items && !this.items.length) c.createEl('p', { cls: 'coffer-intro', text: 'No suggestions are waiting.' });
    const now = Date.now();
    const list = c.createDiv({ cls: 'coffer-list' });
    for (const w of this.items ?? []) {
      const s = w.suggestion;
      if (s) {
        const name = w.name ?? 'A member';
        const r = list.createEl('button', { cls: 'coffer-row' });
        r.createDiv({ cls: 'coffer-row-title', text: name });
        r.createDiv({ cls: 'coffer-row-sub', text: `${momentLabel(s.time, now)} · ${filesLine(s)}` });
        r.addEventListener('click', () => this.openOne(s, name));
        continue;
      }
      const r = list.createDiv({ cls: 'coffer-row coffer-suggestion-bad' });
      r.createDiv({ cls: 'coffer-row-title', text: 'A suggestion that can not be opened' });
      r.createDiv({ cls: 'coffer-row-sub', text: 'From someone who is not a member now, or damaged in storage.' });
      button(buttonRow(r), 'Dismiss', () => this.dismiss(w.key)).setDisabled(this.busy || locked);
    }
    if (this.more) c.createEl('p', { cls: 'coffer-hint', text: moreWaitingText(this.more) });
    message(c, this.error);
    button(buttonRow(c), 'Close', () => this.close());
  }

  private openOne(s: Suggestion, name: string): void {
    this.chosen = { s, name };
    this.refused = new Map();
    this.go('one');
    void (async () => {
      const refused = new Map<string, string>();
      for (const f of s.files) {
        const why = await this.plugin.takeProblem(this.share, f.path).catch(() => '');
        if (why) refused.set(f.path, why);
      }
      if (this.chosen?.s.key !== s.key) return;
      this.refused = refused;
      if (this.view === 'one') this.render();
    })();
  }

  private go(view: View): void {
    this.view = view;
    this.error = '';
    this.stale = '';
    this.busy = false;
    this.render();
  }

  private oneView(c: HTMLElement): void {
    const { s, name } = this.chosen!;
    this.setTitle(`Suggestion from ${name}`);
    const locked = this.locked(c);
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `${name} sent ${momentLabel(s.time, Date.now())}${s.device ? `, from ${s.device}` : ''}: ${filesLine(s)}. Look at each, then take it into ${this.share.property ? `“${this.share.property}”` : 'the folder'} or leave it out.`,
    });
    const list = c.createDiv({ cls: 'coffer-list' });
    for (const f of s.files) {
      const r = list.createEl('button', { cls: 'coffer-row' });
      r.createDiv({ cls: 'coffer-row-title', text: f.path });
      const refused = this.refused.get(f.path);
      if (refused) r.createDiv({ cls: 'coffer-row-sub', text: `Can not be taken in. ${refused}` });
      else if (!f.base) r.createDiv({ cls: 'coffer-row-sub', text: 'New' });
      r.addEventListener('click', () => void this.openFile(f));
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => void this.load()).setDisabled(this.busy);
    button(row, 'Leave all out', () => this.dismiss(s.key), 'warning').setDisabled(this.busy || locked);
  }

  private async openFile(f: SuggestedFile): Promise<void> {
    this.file = f;
    this.review = undefined;
    this.refusedWhy = '';
    this.picker = undefined;
    this.whole = false;
    this.go('file');
    const { name } = this.chosen!;
    try {
      let at = f.path;
      // Asked before anything at that path is read: it may be a file of the vault that is not shared.
      let refused = await this.plugin.takeProblem(this.share, at);
      let current = refused ? undefined : await this.plugin.currentFile(this.share, at);
      this.moved = undefined;
      if (!refused && !current && f.base) {
        const moved = movedTo(f.path, f.base, (await this.plugin.look(this.share)).remote);
        if (moved) {
          at = moved;
          this.moved = moved;
          refused = await this.plugin.takeProblem(this.share, moved);
          if (!refused) current = await this.plugin.currentFile(this.share, moved);
        }
      }
      if (refused) {
        if (this.file !== f) return;
        this.at = at;
        this.refusedWhy = refused;
        if (this.view === 'file') this.render();
        return;
      }
      let base: string | null | undefined;
      if (f.base) {
        base = f.base.size > MAX_COMPARE_BYTES ? null : await this.plugin.getEngine(this.share).readVersion(f.base).then((b) => asText(b) ?? null, () => null);
      }
      if (this.file !== f) return;
      this.at = at;
      this.shown = current;
      this.review = reviewSuggested(at, f.text, base, current);
      if (this.review.kind === 'choose') {
        this.picker = new ChangePicker(this.review.regions, {
          mine: 'As it is now',
          theirs: `${name}'s`,
          allMine: 'Keep all as it is now',
          allTheirs: `Use all of ${name}'s`,
          both: `Both keeps the lines as they are now first, then ${name}'s.`,
        });
      }
    } catch (e) {
      if (this.file !== f) return;
      this.error = `Could not compare it with the folder: ${errorText(e)}`;
    }
    if (this.view === 'file' && this.file === f) this.render();
  }

  private fileView(c: HTMLElement): void {
    const f = this.file!;
    const { name } = this.chosen!;
    this.setTitle(fileName(f.path));
    const locked = this.locked(c);
    if (this.refusedWhy) {
      c.createEl('p', { cls: 'coffer-intro', text: `${name}'s “${fileName(f.path)}” can not be taken in. ${this.refusedWhy}` });
      message(c, this.error);
      const row = buttonRow(c);
      button(row, 'Back', () => this.go('one')).setDisabled(this.busy);
      button(row, 'Leave it out', () => this.settle(), 'cta').setDisabled(this.busy || locked);
      return;
    }
    const r = this.review;
    if (!r) {
      if (this.error) {
        message(c, this.error);
        button(buttonRow(c), 'Back', () => this.go('one'));
      } else c.createEl('p', { cls: 'coffer-intro', text: 'Comparing with the folder as it is now…' });
      return;
    }
    const { intro, accept } = reviewText(r, { name, file: fileName(this.at), moved: this.moved });
    c.createEl('p', { cls: 'coffer-intro', text: intro });
    this.showReview(c, r);
    message(c, this.error);
    if (this.stale) {
      message(c, this.stale);
      button(buttonRow(c), 'Compare again', () => void this.openFile(f), 'cta');
      return;
    }
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('one')).setDisabled(this.busy);
    if (r.kind === 'same') {
      button(row, 'Done', () => this.settle(), 'cta').setDisabled(this.busy || locked);
      return;
    }
    button(row, 'Leave it out', () => this.settle()).setDisabled(this.busy || locked);
    if (accept) {
      const waiting = !!this.picker && this.picker.left > 0;
      button(row, this.busy ? 'Saving…' : accept, () => this.accept(), 'cta').setDisabled(this.busy || locked || waiting);
    }
  }

  private showReview(c: HTMLElement, r: Review): void {
    if (r.kind === 'choose') {
      this.picker!.render(c, () => this.render(), this.busy);
      return;
    }
    const text = r.kind === 'apply' ? r.result : r.kind === 'same' ? undefined : r.text;
    if (r.kind === 'apply' && r.lines) {
      const pick = c.createDiv({ cls: 'coffer-pick' });
      for (const [whole, label] of [[false, 'Changes'], [true, 'Whole text']] as const) {
        const b = button(pick, label, () => {
          this.whole = whole;
          this.render();
        });
        b.buttonEl.toggleClass('is-selected', this.whole === whole);
        b.buttonEl.setAttr('aria-pressed', String(this.whole === whole));
      }
      if (!this.whole) {
        c.createDiv({ cls: 'coffer-hint', text: '+ marks a line taking it in adds, − a line it removes.' });
        showDiff(c, r.lines);
        return;
      }
    }
    if (text !== undefined) showWhole(c, text);
  }

  /** The text taking the file in writes. */
  private result(): string | undefined {
    const r = this.review;
    if (!r || r.kind === 'same') return undefined;
    if (r.kind === 'apply') return r.result;
    if (r.kind === 'choose') return this.picker?.text();
    return r.text;
  }

  private async accept(): Promise<void> {
    const text = this.result();
    const f = this.file!;
    if (text === undefined || this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const done = await this.plugin.acceptSuggested(this.share, this.chosen!.s.key, f.path, this.at, new TextEncoder().encode(text), this.shown);
      if (!done) {
        this.stale = `“${fileName(this.at)}” changed while you were looking, so nothing was written. Compare again to see it as it is now.`;
        this.busy = false;
        this.render();
        return;
      }
      new Notice(`Took ${this.chosen!.name}'s “${fileName(this.at)}” into ${this.share.property ? `“${this.share.property}”` : 'the folder'}. It is sent at the next sync.`);
      this.handled(f);
    } catch (e) {
      this.busy = false;
      this.error = `Could not take it in: ${errorText(e)}`;
      this.render();
    }
  }

  /** Leaves the file out, or after "same", takes it off the list. */
  private async settle(): Promise<void> {
    const f = this.file!;
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await this.plugin.settleSuggested(this.share, this.chosen!.s.key, f.path);
      this.handled(f);
    } catch (e) {
      this.busy = false;
      this.error = `Could not take it off the list: ${errorText(e)}`;
      this.render();
    }
  }

  /** After a file was dealt with: the next one of the suggestion, or once none is left, the list. */
  private handled(f: SuggestedFile): void {
    const open = this.chosen!;
    open.s = { ...open.s, files: open.s.files.filter((x) => x !== f) };
    if (open.s.files.length) this.go('one');
    else void this.load();
  }

  private async dismiss(key: string): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await this.plugin.dismissSuggestion(this.share, key);
    } catch (e) {
      this.busy = false;
      this.error = `Could not dismiss it: ${errorText(e)}`;
      this.render();
      return;
    }
    await this.load();
  }
}
