// Rewind: the vault as it was at an earlier time, to look through before anything is restored. A tab with the
// times along the top, the files of that time on one side and the chosen one on the other, its links leading to
// the other notes of that time. Decisions live in restore.ts; this file only shows them.
import { Component, ItemView, MarkdownRenderer, Notice, type WorkspaceLeaf } from 'obsidian';
import { ext, fileName } from '../core/paths.ts';
import { TooOldError, listCommits, tableAt, type PastVault } from '../core/timeline.ts';
import type { Entry } from '../core/types.ts';
import type CofferPlugin from './main.ts';
import type { Look } from './main.ts';
import { MomentPages, PastLinks, changesLabel, dayLabel, deviceLabel, folderTree, historyFailure, matchesQuery, momentLabel, previewVersion, sizeLabel, timeLabel } from './restore.ts';
import { MAX_COMPARE_BYTES, asText, sameBytes } from './status.ts';
import { showDiff, showWhole } from './timemachine.ts';
import { button, buttonRow, message } from './ui.ts';

export const PAST_VIEW = 'coffer-rewind';

const PAGE = 60;
/** Files listed at most for what was typed; typing more narrows it. */
const MAX_FOUND = 200;
/** Pictures larger than this are named, not shown. */
const MAX_PICTURE_BYTES = 20 << 20;
const PICTURES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', svg: 'image/svg+xml' };
const isNote = (path: string) => ext(path) === 'md' || ext(path) === 'markdown';

export class PastVaultView extends ItemView {
  private plugin: CofferPlugin;
  private pages: MomentPages<Look>;
  /** Which of the loaded times is shown, 0 the newest. */
  private at = 0;
  private past?: PastVault;
  private links = new PastLinks([]);
  private tree = folderTree([]);
  private unfolded = new Set<string>();
  private path = '';
  private comparing = false;
  private filter = '';
  private error = '';
  /** Counts what was asked for, so a slower answer for a time or a file chosen earlier is dropped. */
  private asked = 0;
  private shown?: Component;
  private urls: string[] = [];
  private timeEl!: HTMLElement;
  private slider!: HTMLInputElement;
  private filesEl!: HTMLElement;
  private readerEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: CofferPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.pages = new MomentPages(
      () => plugin.look(),
      (l, beforeSeq) => listCommits(l.repo, l.lastSeq, l.cfg, l.now, { limit: PAGE, beforeSeq }),
      PAGE,
    );
  }

  getViewType(): string {
    return PAST_VIEW;
  }

  getDisplayText(): string {
    return 'Rewind';
  }

  getIcon(): string {
    return 'history';
  }

  async onOpen(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    c.addClass('coffer-rewind', 'coffer-past');
    const top = c.createDiv({ cls: 'coffer-rewind-top' });
    this.timeEl = top.createDiv({ cls: 'coffer-rewind-time' });
    const bar = top.createDiv({ cls: 'coffer-rewind-bar' });
    button(bar, 'Earlier', () => this.step(1));
    this.slider = bar.createEl('input', { attr: { type: 'range', min: '0', max: '0', step: '1', 'aria-label': 'Time' } });
    // Dragging names the time under the thumb; letting go loads it.
    this.slider.addEventListener('input', () => this.describe(this.index()));
    this.slider.addEventListener('change', () => void this.go(this.index()));
    button(bar, 'Later', () => this.step(-1));
    const body = c.createDiv({ cls: 'coffer-rewind-body' });
    const side = body.createDiv({ cls: 'coffer-rewind-side' });
    const find = side.createEl('input', { cls: 'coffer-rewind-find', attr: { type: 'search', placeholder: 'Find a file by name', 'aria-label': 'Find a file by name' } });
    find.addEventListener('input', () => {
      this.filter = find.value.trim();
      this.renderFiles();
    });
    this.filesEl = side.createDiv({ cls: 'coffer-rewind-files' });
    this.readerEl = body.createDiv({ cls: 'coffer-rewind-reader' });
    await this.more();
    if (this.pages.moments.length) await this.go(0);
    else this.describe(0);
  }

  async onClose(): Promise<void> {
    this.asked++;
    this.clearShown();
  }

  /** The slider runs from the earliest loaded time on the left to the newest on the right. */
  private index(): number {
    return this.pages.moments.length - 1 - Number(this.slider.value);
  }

  private async more(): Promise<void> {
    try {
      await this.pages.next();
      this.error = '';
    } catch (e) {
      this.error = `Could not load earlier times: ${historyFailure(e)}`;
    }
    const n = this.pages.moments.length;
    this.slider.max = String(Math.max(0, n - 1));
    this.slider.value = String(Math.max(0, n - 1 - this.at));
    this.slider.disabled = n < 2;
  }

  private async step(by: number): Promise<void> {
    // Later than the newest time loaded: read the history again, for what has synced since this tab opened.
    if (by < 0 && this.at === 0) {
      this.pages.reset();
      await this.more();
      return this.go(0);
    }
    let i = this.at + by;
    if (i >= this.pages.moments.length && this.pages.more) await this.more();
    i = Math.max(0, Math.min(this.pages.moments.length - 1, i));
    if (i !== this.at) await this.go(i);
  }

  private describe(i: number): void {
    const el = this.timeEl;
    el.empty();
    const m = this.pages.moments[i];
    if (!m) {
      el.createDiv({ cls: 'coffer-preview-title', text: this.error ? 'Rewind' : 'Nothing has synced yet, so there is no earlier time to look at.' });
      message(el, this.error);
      return;
    }
    const now = Date.now();
    const day = dayLabel(m.time, now);
    el.createDiv({ cls: 'coffer-preview-title', text: `The vault as it was ${day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : `on ${day}`} at ${timeLabel(m.time, true)}` });
    const where = i === 0 ? 'The newest time' : `${i.toLocaleString()} ${i === 1 ? 'sync' : 'syncs'} back`;
    el.createDiv({ cls: 'coffer-row-sub', text: `${where} · when ${deviceLabel(m.device, this.plugin.settings.deviceName)} synced: ${changesLabel(m)}. Nothing here changes your files until you bring something back.` });
    message(el, this.error);
  }

  /** Shows the vault at the `i`th loaded time, and the file that was open if it was there then. */
  private async go(i: number): Promise<void> {
    const m = this.pages.moments[i];
    const look = this.pages.look;
    if (!m || !look) return;
    const asked = ++this.asked;
    this.at = i;
    this.slider.value = String(this.pages.moments.length - 1 - i);
    this.error = '';
    this.describe(i);
    this.filesEl.addClass('is-loading');
    try {
      // By its number: device clocks disagree, and two moments can share a millisecond, so its time may name another.
      const past = await tableAt(look.repo, look.remote, look.lastSeq, look.cfg, look.now, { seq: m.seq });
      if (asked !== this.asked) return;
      this.past = past;
      this.links = new PastLinks(past.files.keys());
      this.tree = folderTree(past.files.keys());
    } catch (e) {
      if (asked !== this.asked) return;
      this.error = e instanceof TooOldError ? `That is too far back now: the earliest time that can be opened is ${momentLabel(e.earliest.time, Date.now())}.` : `Could not open that time: ${historyFailure(e)}`;
      this.describe(i);
      return;
    } finally {
      if (asked === this.asked) this.filesEl.removeClass('is-loading');
    }
    this.renderFiles();
    if (this.path && this.past?.files.has(this.path)) await this.show(this.path);
    else this.showNothing(this.path ? `“${fileName(this.path)}” was not in the vault at this time.` : 'Choose a file to see it as it was.');
  }

  private renderFiles(): void {
    const el = this.filesEl;
    el.empty();
    const files = this.past?.files;
    if (!files) return;
    if (this.filter) {
      const found = [...files.keys()].filter((p) => matchesQuery(p, this.filter)).sort();
      for (const path of found.slice(0, MAX_FOUND)) this.fileRow(el, path, path);
      if (!found.length) el.createDiv({ cls: 'coffer-hint', text: 'No file of that time has this in its name.' });
      if (found.length > MAX_FOUND) el.createDiv({ cls: 'coffer-hint', text: `…and ${(found.length - MAX_FOUND).toLocaleString()} more. Type more to narrow it.` });
      return;
    }
    this.folder(el, '');
    if (!files.size) el.createDiv({ cls: 'coffer-hint', text: 'The vault was empty at this time.' });
  }

  /** What is directly in `dir`; a folder's own contents are drawn when it is unfolded. */
  private folder(parent: HTMLElement, dir: string): void {
    const d = this.tree.get(dir);
    if (!d) return;
    for (const sub of d.folders) {
      const box = parent.createEl('details', { cls: 'coffer-rewind-folder' });
      box.createEl('summary', { text: fileName(sub) });
      const inside = box.createDiv({ cls: 'coffer-rewind-inside' });
      const fill = () => {
        if (box.open && !inside.hasChildNodes()) this.folder(inside, sub);
        if (box.open) this.unfolded.add(sub);
        else this.unfolded.delete(sub);
      };
      box.addEventListener('toggle', fill);
      if (this.unfolded.has(sub)) {
        box.open = true;
        fill();
      }
    }
    for (const path of d.files) this.fileRow(parent, path, fileName(path));
  }

  private fileRow(parent: HTMLElement, path: string, text: string): void {
    const el = parent.createEl('button', { cls: 'coffer-row coffer-rewind-file', text });
    el.dataset.path = path;
    el.toggleClass('is-selected', path === this.path);
    el.addEventListener('click', () => void this.show(path));
  }

  /** Unfolds the folders `path` is in and marks its row, as when a link led to it. */
  private reveal(path: string): void {
    const parts = path.split('/');
    let folded = false;
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      folded ||= !this.unfolded.has(dir);
      this.unfolded.add(dir);
    }
    if (folded && !this.filter) this.renderFiles();
    for (const el of Array.from(this.filesEl.querySelectorAll<HTMLElement>('.coffer-rewind-file'))) {
      el.toggleClass('is-selected', el.dataset.path === path);
      if (el.dataset.path === path) el.scrollIntoView({ block: 'nearest' });
    }
  }

  private clearShown(): void {
    if (this.shown) this.removeChild(this.shown);
    this.shown = undefined;
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
  }

  private showNothing(text: string): void {
    this.clearShown();
    this.readerEl.empty();
    this.readerEl.createEl('p', { cls: 'coffer-intro', text });
  }

  private pictureUrl(path: string, data: Uint8Array): string {
    const url = URL.createObjectURL(new Blob([data.slice()], { type: PICTURES[ext(path)] }));
    this.urls.push(url);
    return url;
  }

  /** The file at `path` as it was at the time shown: a note rendered, a picture, other text as it is, or what is known of it. */
  private async show(path: string, comparing = false): Promise<void> {
    const entry = this.past?.files.get(path);
    if (!entry) return this.showNothing(`“${fileName(path)}” was not in the vault at this time.`);
    const asked = ++this.asked;
    this.path = path;
    this.comparing = comparing;
    this.reveal(path);
    this.clearShown();
    const c = this.readerEl;
    c.empty();
    const head = c.createDiv({ cls: 'coffer-rewind-head' });
    head.createDiv({ cls: 'coffer-preview-title', text: path });
    head.createDiv({ cls: 'coffer-row-sub', text: `${sizeLabel(entry.size)} · as it was ${momentLabel(this.past!.commit.time, Date.now())}` });
    const actions = buttonRow(head);
    const body = c.createDiv({ cls: 'coffer-rewind-content' });
    const picture = ext(path) in PICTURES;
    if (entry.size > (picture ? MAX_PICTURE_BYTES : MAX_COMPARE_BYTES)) {
      button(actions, 'Bring this version back', () => void this.bringBack(path, entry), 'cta');
      body.createEl('p', { cls: 'coffer-intro', text: 'This file is too large to show here. Bringing it back downloads it.' });
      return;
    }
    body.createEl('p', { cls: 'coffer-intro', text: 'Loading…' });
    let data: Uint8Array;
    let current: Uint8Array | null;
    try {
      data = await this.plugin.getEngine().readVersion(entry);
      current = await this.currentFile(path);
    } catch (e) {
      if (asked !== this.asked) return;
      body.empty();
      message(body, `Could not read this version: ${historyFailure(e)}`);
      return;
    }
    if (asked !== this.asked) return;
    body.empty();
    const pv = previewVersion(data, current);
    // Said of the bytes, so that a picture or any other file that is not text counts too.
    const missing = current === null;
    const same = !!current && sameBytes(current, data);
    if (comparing) {
      button(actions, 'Back to the file', () => void this.show(path));
      button(actions, missing ? 'Bring it back' : 'Replace the current file with this version', () => void this.bringBack(path, entry), 'cta').setDisabled(same);
      if (same) body.createEl('p', { cls: 'coffer-intro', text: 'The file is the same now as it was then.' });
      else if (pv.kind === 'changes') {
        body.createEl('p', { cls: 'coffer-intro', text: 'What bringing this version back would change in the file as it is now: lines marked − go, lines marked + come back.' });
        showDiff(body, pv.lines);
      } else if (pv.kind === 'text') {
        body.createEl('p', { cls: 'coffer-intro', text: pv.why === 'missing' ? 'This file is not in the vault now. Bringing it back puts it where it was.' : 'The file now is too different to compare line by line. This is the version from then:' });
        showWhole(body, pv.text);
      } else {
        const text = missing ? 'This file is not in the vault now. Bringing it back puts it where it was.' : 'This is not text, so the two cannot be compared here. Bringing this version back replaces the file as it is now.';
        body.createEl('p', { cls: 'coffer-intro', text });
      }
      return;
    }
    button(actions, missing ? 'Not in the vault now: bring it back…' : same ? 'The same as now' : 'Compare with now, or bring it back…', () => void this.show(path, true)).setDisabled(same);
    const text = picture ? undefined : asText(data);
    if (picture) body.createEl('img', { cls: 'coffer-rewind-picture', attr: { src: this.pictureUrl(path, data), alt: fileName(path) } });
    else if (text === undefined) body.createEl('p', { cls: 'coffer-intro', text: 'This is not text, so it cannot be shown here.' });
    else if (!isNote(path)) showWhole(body, text);
    else await this.renderNote(body, path, text, asked);
  }

  /** The file at `path` as it is on this device now; null when there is none. */
  private async currentFile(path: string): Promise<Uint8Array | null> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    return new Uint8Array(await adapter.readBinary(path));
  }

  /**
   * A note of that time, rendered as Obsidian renders one. Its links and the files it shows are looked up among the
   * files of that time, never today's: a link opens the past note here, a picture is read from storage as it was.
   */
  private async renderNote(body: HTMLElement, path: string, text: string, asked: number): Promise<void> {
    const shown = (this.shown = this.addChild(new Component()));
    const el = body.createDiv({ cls: 'markdown-rendered coffer-rewind-note' });
    // Rendered apart from any file of today, so nothing in it is resolved against the vault as it is now.
    await MarkdownRenderer.render(this.app, text, el, '', shown);
    if (asked !== this.asked) return;
    for (const a of Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link'))) {
      const to = this.links.resolve(a.getAttribute('data-href') ?? a.getAttribute('href') ?? '', path);
      a.toggleClass('is-unresolved', !to);
      a.removeAttribute('target');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (to) void this.show(to);
        else new Notice('That note was not in the vault at this time.');
      });
    }
    const files = this.past!.files;
    for (const embed of Array.from(el.querySelectorAll<HTMLElement>('.internal-embed'))) {
      const src = embed.getAttribute('src') ?? '';
      const to = this.links.resolve(src, path);
      const entry = to ? files.get(to) : undefined;
      embed.empty();
      embed.removeClass('is-loaded');
      if (!to || !entry) {
        embed.createSpan({ cls: 'coffer-rewind-missing', text: `“${src}” was not in the vault at this time.` });
        continue;
      }
      if (ext(to) in PICTURES && entry.size <= MAX_PICTURE_BYTES) {
        void this.plugin
          .getEngine()
          .readVersion(entry)
          .then((data) => {
            if (asked === this.asked) embed.createEl('img', { attr: { src: this.pictureUrl(to, data), alt: fileName(to) } });
          })
          .catch((e: unknown) => embed.createSpan({ cls: 'coffer-rewind-missing', text: `Could not read “${fileName(to)}”: ${historyFailure(e)}` }));
        continue;
      }
      const link = embed.createEl('a', { cls: 'internal-link', text: `${fileName(to)} (${sizeLabel(entry.size)})` });
      link.addEventListener('click', (e) => {
        e.preventDefault();
        void this.show(to);
      });
    }
  }

  private async bringBack(path: string, entry: Entry): Promise<void> {
    const m = this.past!.commit;
    try {
      await this.plugin.restoreVersion(path, { seq: m.seq, time: m.time, device: m.device, entry });
      if (this.path === path) await this.show(path);
    } catch (e) {
      new Notice(`Could not bring it back: ${historyFailure(e)}`, 10_000);
    }
  }
}
