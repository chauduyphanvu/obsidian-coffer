// Looking at the past and bringing it back: a file's versions, deleted files, the vault or a folder at an earlier
// time, and a check of what storage holds. Decisions live in restore.ts; this file only shows them.
import { Modal, Notice, Platform, TFile, type App } from 'obsidian';
import { fileName, vaultKey } from '../core/paths.ts';
import type { RepairReport } from '../core/repair.ts';
import { listVersions } from '../core/retention.ts';
import { plural } from '../core/text.ts';
import { TooOldError, listActivity, listCommits, listDeleted, planRestore, tableAt, type CommitSummary, type DeletedFile, type PastVault } from '../core/timeline.ts';
import { sameContent, type Version } from '../core/types.ts';
import type { VerifyReport } from '../core/verify.ts';
import { ActivityPages, activityRows, savedBy, type ActivityRow, type Self } from './activity.ts';
import type CofferPlugin from './main.ts';
import type { Failed, Look, RestoreOutcome } from './main.ts';
import { folderShares, labelOf, type Share } from './settings.ts';
import { vaultPath } from './shares.ts';
import {
  MomentPages,
  byDay,
  canRepair,
  changesLabel,
  countSteps,
  countable,
  describeRepair,
  describeVerify,
  deviceLabel,
  historyFailure,
  leftNote,
  lineChanges,
  matchesQuery,
  momentLabel,
  previewVersion,
  repeatsDay,
  restoreSteps,
  scopeName,
  sentNote,
  sizeLabel,
  stepSummary,
  timeLabels,
  verifyProgress,
  type DiffLine,
  type Preview,
  type Step,
} from './restore.ts';
import { MAX_COMPARE_BYTES } from './status.ts';
import { FolderSuggest, button, buttonRow, message, openLink, statusLine } from './ui.ts';

/** Rows drawn at most in one list; typing narrows it. */
const MAX_ROWS = 300;
/** Diff lines and characters of whole text drawn at most, so a huge file cannot freeze the screen. */
const MAX_LINES = 3000;
const MAX_CHARS = 200_000;
const PAGE = 30;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Which synced place a screen is about, once the vault has shared folders: each has a history of its own. */
function placeLine(parent: HTMLElement, plugin: CofferPlugin, share: Share | undefined): void {
  const text = share ? (share.property ? `Shared notes “${share.property}”` : `Shared folder “${share.folder}”`) : folderShares(plugin.settings.shares).length ? 'This vault, without its shared folders' : '';
  if (text) parent.createDiv({ cls: 'coffer-place', text });
}

/** A row in a list: a title and a line under it, tappable when there is something to do. */
function row(parent: HTMLElement, title: string, sub: string, onClick?: () => void): HTMLElement {
  const el = parent.createEl(onClick ? 'button' : 'div', { cls: 'coffer-row' });
  el.createDiv({ cls: 'coffer-row-title', text: title });
  if (sub) el.createDiv({ cls: 'coffer-row-sub', text: sub });
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** A whole-row checkbox with room for text beside it; returns where the text goes. */
function checkRow(parent: HTMLElement, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const label = parent.createEl('label', { cls: 'coffer-check-row' });
  const box = label.createEl('input', { attr: { type: 'checkbox' } });
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  return label.createDiv({ cls: 'coffer-check-body' });
}

/** Items under a heading per day, each with its time of day. */
function days<T>(parent: HTMLElement, items: T[], timeOf: (item: T) => number, each: (parent: HTMLElement, item: T, time: string) => void): void {
  const times = timeLabels(items.map(timeOf));
  const at = new Map(items.map((x, i) => [x, times[i]]));
  const groups = byDay(items, timeOf, Date.now());
  if (repeatsDay(groups)) parent.createDiv({ cls: 'coffer-hint', text: "Your devices' clocks disagree, so a day can come up more than once: the list keeps the order things were synced in." });
  for (const d of groups) {
    parent.createDiv({ cls: 'coffer-day', text: d.day });
    for (const x of d.items) each(parent, x, at.get(x)!);
  }
}

export function showDiff(parent: HTMLElement, lines: DiffLine[]): void {
  const box = parent.createDiv({ cls: 'coffer-diff' });
  for (const l of lines.slice(0, MAX_LINES)) {
    if (l.kind === 'gap') {
      box.createDiv({ cls: 'coffer-diff-gap', text: `⋯ ${plural(l.lines, 'line')} the same ⋯` });
      continue;
    }
    const el = box.createDiv({ cls: `coffer-diff-line is-${l.kind}` });
    el.createSpan({ cls: 'coffer-diff-mark', text: l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : '' });
    el.createSpan({ cls: 'coffer-diff-text', text: l.text });
  }
  if (lines.length > MAX_LINES) parent.createDiv({ cls: 'coffer-hint', text: `Only the first ${MAX_LINES.toLocaleString()} lines are shown. “Whole text” shows all of this version.` });
}

export function showWhole(parent: HTMLElement, text: string): void {
  parent.createDiv({ cls: 'coffer-whole', text: text.slice(0, MAX_CHARS) });
  if (text.length > MAX_CHARS) parent.createDiv({ cls: 'coffer-hint', text: 'Only the beginning of this version is shown.' });
}

function showCounts(el: HTMLElement, c: { added: number; removed: number }): void {
  el.empty();
  if (!c.added && !c.removed) {
    el.setText('same text');
    return;
  }
  el.setAttr('aria-label', `${plural(c.added, 'line')} added, ${c.removed.toLocaleString()} removed`);
  el.createSpan({ cls: 'is-added', text: `+${c.added.toLocaleString()}` });
  el.createSpan({ cls: 'is-removed', text: `−${c.removed.toLocaleString()}` });
}

/** The paths a finding is about, the first few of them. */
function fileList(parent: HTMLElement, files: string[]): void {
  if (!files.length) return;
  const list = parent.createDiv({ cls: 'coffer-files' });
  for (const path of files.slice(0, 20)) list.createDiv({ cls: 'coffer-file', text: path });
  if (files.length > 20) list.createDiv({ cls: 'coffer-hint', text: `…and ${(files.length - 20).toLocaleString()} more` });
}

/** Runs jobs two at a time, newest first, so the rows just scrolled to come before ones scrolled past. */
class Lane {
  private jobs: (() => Promise<void>)[] = [];
  private active = 0;
  private stopped = false;

  add(job: () => Promise<void>): void {
    this.jobs.push(job);
    this.next();
  }

  stop(): void {
    this.stopped = true;
    this.jobs = [];
  }

  private next(): void {
    while (!this.stopped && this.active < 2 && this.jobs.length) {
      const job = this.jobs.pop()!;
      this.active++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.next();
        });
    }
  }
}

/** One file's versions, newest first. Picking one shows it, and what restoring it would change, before anything is written. */
export class VersionsModal extends Modal {
  private plugin: CofferPlugin;
  private path: string;
  /** The engine whose history the file is in, and its path there. */
  private place: { share?: Share; path: string };
  private name: string;
  private versions: Version[] = [];
  /** The newest version that matches the synced file, so the list can say which one the file is now. */
  private now?: Version;
  /** The file as it is: its bytes, null when there is none, undefined when too large to compare. */
  private current: Uint8Array | null | undefined = null;
  private picked?: Version;
  private preview?: Preview;
  private whole = false;
  private error = '';
  private busy = false;
  private closed = false;
  private bytes = new Map<number, Promise<Uint8Array>>();
  private rows = new Map<number, HTMLElement>();
  private lane = new Lane();
  private observer?: IntersectionObserver;
  private panes?: HTMLElement;
  private previewEl?: HTMLElement;
  /** Where the list was scrolled when a version was picked, to return there on a phone. */
  private scrolled = 0;
  /** The change to show first, as Activity opens it: the version commit `seq` made, or for a deletion, the one before. */
  private first?: { seq: number; deleted: boolean };
  /** Who this device is in the history, for naming who saved each version (`savedBy`). */
  private self?: Self;

  constructor(app: App, plugin: CofferPlugin, path: string, first?: { seq: number; deleted: boolean }) {
    super(app);
    this.plugin = plugin;
    this.path = path;
    this.place = plugin.placeOf(path);
    this.name = fileName(path);
    this.first = first;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past', 'coffer-wide');
    this.setTitle(this.name);
    void this.load();
  }

  onClose(): void {
    this.closed = true;
    this.lane.stop();
    this.observer?.disconnect();
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    this.contentEl.createEl('p', { cls: 'coffer-intro', text: 'Loading versions…' });
    try {
      const look = await this.plugin.look(this.place.share);
      const key = vaultKey(this.place.path);
      this.self = this.place.share ? this.plugin.selfIn(this.place.share, look.members) : undefined;
      this.versions = await listVersions(look.repo, look.lastSeq, key, look.cfg, look.now);
      const synced = look.remote.get(key);
      const newest = this.versions.find((v) => v.entry);
      if (synced && newest && sameContent(newest.entry!, synced)) this.now = newest;
      const file = this.app.vault.getAbstractFileByPath(this.path);
      this.current = !(file instanceof TFile) ? null : file.stat.size <= MAX_COMPARE_BYTES ? new Uint8Array(await this.app.vault.readBinary(file)) : undefined;
    } catch (e) {
      this.error = `Could not load the versions: ${historyFailure(e)}`;
    }
    if (this.closed) return;
    this.render();
    const f = this.first;
    // A version thinned out of history is not offered: then the list is shown as it is.
    const shown = f && this.versions.find((v) => v.entry && (f.deleted ? v.seq < f.seq : v.seq === f.seq));
    if (shown) this.pick(shown);
  }

  /** A version's bytes, downloaded once while the dialog is open; only the last few are kept. */
  private read(v: Version): Promise<Uint8Array> {
    let p = this.bytes.get(v.seq);
    if (!p) {
      p = this.plugin.getEngine(this.place.share).readVersion(v.entry!);
      this.bytes.set(v.seq, p);
      p.catch(() => this.bytes.delete(v.seq));
      if (this.bytes.size > 24) this.bytes.delete(this.bytes.keys().next().value!);
    }
    return p;
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.versions.length) {
      if (this.error) message(c, this.error);
      else c.createEl('p', { cls: 'coffer-intro', text: `No versions of “${this.name}” are stored. A file shows up here once it has synced.` });
      button(buttonRow(c), 'Close', () => this.close());
      return;
    }
    this.panes = c.createDiv({ cls: 'coffer-panes' });
    this.renderList(this.panes.createDiv({ cls: 'coffer-pane coffer-pane-list' }));
    this.previewEl = this.panes.createDiv({ cls: 'coffer-pane coffer-pane-preview' });
    this.renderPreview();
  }

  private renderList(parent: HTMLElement): void {
    const me = this.plugin.settings.deviceName;
    if (this.place.share) placeLine(parent, this.plugin, this.place.share);
    parent.createEl('p', {
      cls: 'coffer-intro',
      text: `Versions from the last ${plural(this.plugin.settings.retentionDays, 'day')}, newest first. Pick one to see it before restoring.`,
    });
    const list = parent.createDiv({ cls: 'coffer-list' });
    const jobs = new Map<Element, () => void>();
    this.observer = new IntersectionObserver((seen) => {
      for (const e of seen) {
        if (!e.isIntersecting) continue;
        this.observer?.unobserve(e.target);
        jobs.get(e.target)?.();
      }
    });
    days(list, this.versions, (v) => v.time, (el, v, time) => {
      if (!v.entry) {
        row(el, time, v.signer ? `Deleted by ${this.by(v)}` : `Deleted on ${deviceLabel(v.device, me)}`).addClass('is-deleted');
        return;
      }
      const r = row(el, time, '', () => this.pick(v));
      this.rows.set(v.seq, r);
      if (v === this.now) r.querySelector('.coffer-row-title')!.createSpan({ cls: 'coffer-tag', text: 'Now' });
      const sub = r.createDiv({ cls: 'coffer-row-sub' });
      sub.createSpan({ text: `${this.by(v)} · ${sizeLabel(v.entry.size)}` });
      const counts = sub.createSpan({ cls: 'coffer-counts' });
      jobs.set(r, () => this.count(v, counts));
      this.observer!.observe(r);
    });
  }

  /** Lines added and removed since the version before, for a row that has come on screen. */
  private count(v: Version, el: HTMLElement): void {
    const before = this.versions.slice(this.versions.indexOf(v) + 1).find((x) => x.entry);
    if (!before || !countable(this.path, v.entry!.size) || !countable(this.path, before.entry!.size)) return;
    this.lane.add(async () => {
      const c = lineChanges(await this.read(before), await this.read(v));
      if (c && !this.closed) showCounts(el, c);
    });
  }

  private pick(v: Version): void {
    if (this.picked !== v) {
      this.picked = v;
      this.preview = undefined;
      this.whole = false;
      this.error = '';
      void this.loadPreview(v);
    }
    for (const [seq, r] of this.rows) {
      r.toggleClass('is-selected', seq === v.seq);
      r.setAttr('aria-current', seq === v.seq ? 'true' : null);
    }
    this.scrolled = this.modalEl.scrollTop;
    this.panes?.addClass('is-picked');
    this.renderPreview();
    if (Platform.isPhone) this.modalEl.scrollTop = 0;
  }

  /** Who saved `v`: in a shared folder with members, the member, as Activity names them; elsewhere the device. */
  private by(v: Version): string {
    return savedBy(v, this.self ?? { device: this.plugin.settings.deviceName, changes: [] });
  }

  /** On a phone the preview takes the whole screen; this goes back to the list where it was. */
  private unpick(): void {
    this.panes?.removeClass('is-picked');
    this.modalEl.scrollTop = this.scrolled;
  }

  private async loadPreview(v: Version): Promise<void> {
    let preview: Preview | undefined;
    try {
      preview = previewVersion(v.entry!.size <= MAX_COMPARE_BYTES ? await this.read(v) : undefined, this.current);
    } catch (e) {
      if (this.picked === v) this.error = `Could not download this version: ${historyFailure(e)}`;
    }
    if (this.picked !== v || this.closed) return;
    this.preview = preview;
    this.renderPreview();
  }

  private renderPreview(): void {
    const p = this.previewEl;
    const v = this.picked;
    if (!p) return;
    p.empty();
    if (!v) {
      p.createDiv({ cls: 'coffer-hint', text: 'Pick a version to see it here.' });
      return;
    }
    button(p, '‹ All versions', () => this.unpick()).buttonEl.addClass('coffer-back');
    p.createDiv({ cls: 'coffer-preview-title', text: `The version from ${momentLabel(v.time, Date.now())}` });
    p.createDiv({ cls: 'coffer-row-sub', text: `Saved by ${this.by(v)} · ${sizeLabel(v.entry!.size)}` });
    const pv = this.preview;
    if (!pv) {
      if (this.error) message(p, this.error);
      else p.createEl('p', { cls: 'coffer-intro', text: 'Downloading this version…' });
      return;
    }
    if (pv.kind === 'changes') {
      p.createEl('p', {
        cls: 'coffer-intro',
        text: `Restoring it would add ${plural(pv.added, 'line')} to the file as it is now and remove ${pv.removed.toLocaleString()}.`,
      });
      const pick = p.createDiv({ cls: 'coffer-pick' });
      for (const [whole, text] of [[false, 'Changes'], [true, 'Whole text']] as const) {
        const b = button(pick, text, () => {
          this.whole = whole;
          this.renderPreview();
        });
        b.buttonEl.toggleClass('is-selected', this.whole === whole);
        b.buttonEl.setAttr('aria-pressed', String(this.whole === whole));
      }
      if (this.whole) showWhole(p, pv.text);
      else {
        p.createDiv({ cls: 'coffer-hint', text: '+ marks a line restoring adds, − a line it removes.' });
        showDiff(p, pv.lines);
      }
    } else if (pv.kind === 'same') {
      p.createEl('p', { cls: 'coffer-intro', text: 'This version is the same as the file is now.' });
    } else if (pv.kind === 'text') {
      p.createEl('p', {
        cls: 'coffer-intro',
        text: pv.why === 'missing' ? `There is no “${this.name}” now. Restoring brings it back with this text:` : "This version can't be compared line by line with the file as it is now. Here is all of it:",
      });
      showWhole(p, pv.text);
    } else {
      p.createEl('p', { cls: 'coffer-intro', text: pv.why === 'binary' ? "This kind of file can't be shown here." : 'This version is too large to show here.' });
    }

    message(p, this.error);
    p.createDiv({
      cls: 'coffer-hint',
      text:
        (this.current === null ? `Restoring brings “${this.name}” back as it was then.` : `Restoring replaces “${this.name}” with this version. What it holds now stays in its version history.`) +
        (this.plugin.receivesOnly(this.place.share) ? ` ${sentNote(1, true)}` : ''),
    });
    const r = buttonRow(p);
    button(r, 'Close', () => this.close());
    button(r, this.busy ? 'Restoring…' : 'Restore this version', () => this.restore(v), 'cta').setDisabled(this.busy || pv.kind === 'same');
  }

  private async restore(v: Version): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.renderPreview();
    try {
      await this.plugin.restoreVersion(this.path, v);
      this.close();
    } catch (e) {
      this.busy = false;
      this.error = `Could not restore: ${historyFailure(e)}`;
      this.renderPreview();
    }
  }
}

/** Files deleted within the time versions are kept, newest first, to bring back one or several at once. */
export class DeletedModal extends Modal {
  private plugin: CofferPlugin;
  private share?: Share;
  private files: DeletedFile[] = [];
  private picked = new Set<DeletedFile>();
  private query = '';
  private error = '';
  private busy = false;
  private loaded = false;
  private listEl?: HTMLElement;
  private footEl?: HTMLElement;

  constructor(app: App, plugin: CofferPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past');
    this.setTitle('Restore deleted files');
    this.contentEl.createEl('p', { cls: 'coffer-intro', text: 'Looking for deleted files…' });
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      const look = await this.plugin.look(this.share);
      const kept = await this.plugin.keptOutFiles(this.share);
      this.files = (await listDeleted(look.repo, look.lastSeq, look.cfg, look.now)).filter((d) => !kept(d.path));
    } catch (e) {
      this.error = `Could not look for deleted files: ${historyFailure(e)}`;
    }
    this.loaded = true;
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    placeLine(c, this.plugin, this.share);
    if (!this.files.length) {
      if (this.error) message(c, this.error);
      else if (this.loaded) {
        c.createEl('p', { cls: 'coffer-intro', text: `No deleted files can be brought back. Files deleted in the last ${plural(this.plugin.settings.retentionDays, 'day')} show up here.` });
      }
      button(buttonRow(c), 'Close', () => this.close());
      return;
    }
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `${plural(this.files.length, 'file')} deleted in the last ${plural(this.plugin.settings.retentionDays, 'day')} can be brought back, newest first.`,
    });
    const search = c.createEl('input', {
      cls: 'coffer-search',
      attr: { type: 'search', placeholder: 'Filter by name or folder', 'aria-label': 'Filter by name or folder', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
      this.renderFoot();
    });
    this.listEl = c.createDiv();
    this.footEl = c.createDiv({ cls: 'coffer-foot' });
    this.renderList();
    this.renderFoot();
  }

  private renderList(): void {
    const l = this.listEl!;
    l.empty();
    const me = this.plugin.settings.deviceName;
    const shown = this.files.filter((f) => matchesQuery(f.path, this.query)).slice(0, MAX_ROWS);
    if (!shown.length) {
      l.createDiv({ cls: 'coffer-hint', text: 'No deleted file matches.' });
      return;
    }
    const all = shown.every((f) => this.picked.has(f));
    checkRow(l, all, (on) => {
      for (const f of shown) {
        if (on) this.picked.add(f);
        else this.picked.delete(f);
      }
      this.renderList();
      this.renderFoot();
    }).createDiv({ cls: 'coffer-row-title', text: shown.length === 1 ? 'Select the one shown' : `Select all ${shown.length.toLocaleString()} shown` });
    const list = l.createDiv({ cls: 'coffer-list' });
    days(list, shown, (f) => f.time, (el, f, time) => {
      const body = checkRow(el, this.picked.has(f), (on) => {
        if (on) this.picked.add(f);
        else this.picked.delete(f);
        this.renderFoot();
      });
      body.createDiv({ cls: 'coffer-row-title', text: fileName(f.path) });
      const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      body.createDiv({ cls: 'coffer-row-sub', text: `${folder ? `in ${folder} · ` : ''}deleted at ${time} on ${deviceLabel(f.device, me)}` });
    });
    const matching = this.files.filter((f) => matchesQuery(f.path, this.query)).length;
    if (matching > shown.length) l.createDiv({ cls: 'coffer-hint', text: `Showing the newest ${shown.length.toLocaleString()} of ${matching.toLocaleString()}. Type to narrow the list.` });
  }

  private renderFoot(): void {
    const f = this.footEl!;
    f.empty();
    message(f, this.error);
    const n = this.picked.size;
    f.createDiv({ cls: 'coffer-hint', text: 'Files come back where they were. If something has that name now, the file comes back beside it with “(restored)” in its name.' });
    const r = buttonRow(f);
    button(r, 'Cancel', () => this.close());
    button(r, this.busy ? 'Restoring…' : n ? `Restore ${plural(n, 'file')}` : 'Restore', () => this.restore(), 'cta').setDisabled(!n || this.busy);
  }

  private async restore(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.renderFoot();
    try {
      this.done(await this.plugin.restoreDeleted(this.files.filter((f) => this.picked.has(f)), this.share));
    } catch (e) {
      this.busy = false;
      this.error = `Could not restore: ${historyFailure(e)}`;
      this.renderFoot();
    }
  }

  private done({ placed, failed }: { placed: { path: string; to: string }[]; failed: Failed[] }): void {
    const c = this.contentEl;
    c.empty();
    if (placed.length) {
      statusLine(c, `${plural(placed.length, 'file')} brought back`, failed.length ? 'warning' : 'ok');
      c.createDiv({ cls: 'coffer-sub', text: sentNote(placed.length, this.plugin.receivesOnly(this.share)) });
      const list = c.createDiv({ cls: 'coffer-files' });
      for (const p of placed) {
        const r = list.createDiv({ cls: 'coffer-file' });
        r.createSpan({ text: p.to === p.path ? p.path : `${p.path} came back as “${fileName(p.to)}”, as something has its name now` });
        openLink(r, this.app, 'Open', this.share ? `${this.share.folder}/${p.to}` : p.to, () => this.close());
      }
    }
    if (failed.length) message(c, `${placed.length ? 'These could not be brought back' : 'Nothing could be brought back'}:\n${failed.map((x) => `${x.path}: ${x.message}`).join('\n')}`);
    button(buttonRow(c), 'Close', () => this.close(), 'cta');
  }
}

const KIND: [Step['kind'], string][] = [['add', 'Brought back'], ['change', 'Changed'], ['remove', 'Removed']];

/**
 * The whole vault or one folder back to how it was at an earlier time: pick the time and the scope, see exactly what
 * would change, confirm, then watch it happen.
 */
export class RestoreEarlierModal extends Modal {
  private plugin: CofferPlugin;
  /** The shared folder whose history this works on, or none for the vault's. */
  private share?: Share;
  /** Inside the vault or the shared folder; '' for all of it. */
  private folder: string;
  private step: 'choose' | 'review' | 'working' | 'done' = 'choose';
  /** The times of the vault's or the shared folder's history; reset when that changes. */
  private pages: MomentPages<Look>;
  private error = '';
  private note = '';
  /** Why the time tapped last could not be worked out, shown over the list loaded again after it. */
  private gone = '';
  /** The moment being worked out, so a slower answer for one tapped earlier is dropped. */
  private asked?: CommitSummary;
  private past?: PastVault;
  private steps: Step[] = [];
  private left = 0;
  private outcome?: RestoreOutcome;
  private closed = false;

  /** `folder` is a vault path ('' for the whole vault); a folder in a shared folder is restored from that one's history. */
  constructor(app: App, plugin: CofferPlugin, folder: string) {
    super(app);
    this.plugin = plugin;
    const place = folder ? plugin.placeOf(folder) : { path: '' };
    this.share = place.share;
    this.folder = place.path;
    this.pages = new MomentPages(
      () => plugin.look(this.share),
      (l, beforeSeq) => listCommits(l.repo, l.lastSeq, l.cfg, l.now, { limit: PAGE, beforeSeq }),
      PAGE,
    );
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past');
    this.setTitle('Restore to an earlier time');
    void this.loadMore();
  }

  /** “Notes”, the shared folder “Work”, or the whole vault: what is being restored, inside a sentence. */
  private scopeText(): string {
    const s = this.share;
    return s ? (this.folder ? `“${s.folder}/${this.folder}”` : `the shared folder “${s.folder}”`) : scopeName(this.folder);
  }

  /** Restores from the vault's history, or from a shared folder's, which has times of its own. */
  private target(share: Share | undefined, folder: string): void {
    const moved = share?.id !== this.share?.id;
    this.share = share;
    this.folder = folder;
    this.gone = '';
    if (!moved) return this.render();
    this.pages.reset();
    void this.loadMore();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async loadMore(): Promise<void> {
    if (this.pages.loading) return;
    const loading = this.pages.next();
    this.error = '';
    this.render();
    try {
      // Dropped: the place changed meanwhile, and its own load draws the list.
      if (!(await loading)) return;
    } catch (e) {
      this.error = `Could not load earlier times: ${historyFailure(e)}`;
    }
    if (this.step === 'choose') this.render();
  }

  private render(): void {
    if (this.closed) return;
    const c = this.contentEl;
    c.empty();
    if (this.step === 'choose') this.renderChoose(c);
    else if (this.step === 'review') this.renderReview(c);
    else if (this.step === 'working') this.renderWorking(c);
    else this.renderDone(c);
  }

  private renderChoose(c: HTMLElement): void {
    c.createDiv({ cls: 'coffer-pick-label', text: 'What to restore' });
    const pick = c.createDiv({ cls: 'coffer-pick' });
    const option = (text: string, on: boolean, run: () => void) => {
      const b = button(pick, text, run);
      b.buttonEl.toggleClass('is-selected', on);
      b.buttonEl.setAttr('aria-pressed', String(on));
    };
    const whole = !this.share && !this.folder;
    option('The whole vault', whole, () => this.target(undefined, ''));
    option('One folder', !whole, () => this.chooseFolder());
    if (!whole) {
      const f = c.createDiv({ cls: 'coffer-file' });
      f.createSpan({ text: this.share && !this.folder ? `${this.share.folder} (shared folder)` : this.share ? `${this.share.folder}/${this.folder}` : this.folder });
      button(f, 'Change', () => this.chooseFolder());
    }
    if (whole && folderShares(this.plugin.settings.shares).length) {
      c.createDiv({ cls: 'coffer-hint', text: 'Shared folders are not part of it: each has a history of its own. To restore one, choose it under “One folder”.' });
    }

    c.createDiv({ cls: 'coffer-pick-label', text: 'Bring it back to how it was' });
    c.createDiv({ cls: 'coffer-hint', text: `Each time is when a device synced. The numbers say what that sync changed across ${this.share ? 'the shared folder' : 'the vault'}.` });
    message(c, this.gone);
    const me = this.plugin.settings.deviceName;
    const { moments, loading, more } = this.pages;
    const list = c.createDiv({ cls: 'coffer-list' });
    days(list, moments, (m) => m.time, (el, m, time) => {
      row(el, time, `${deviceLabel(m.device, me)} · ${changesLabel(m)}`, () => void this.review(m));
    });
    message(c, this.error);
    if (loading) c.createDiv({ cls: 'coffer-hint', text: 'Loading…' });
    else if (!moments.length && !this.error) c.createEl('p', { cls: 'coffer-intro', text: 'Nothing has synced yet, so there is no earlier time to go back to.' });
    const r = buttonRow(c);
    button(r, 'Cancel', () => this.close());
    if (more && !loading && moments.length) button(r, 'Show earlier times', () => this.loadMore());
  }

  private chooseFolder(): void {
    const plugin = this.plugin;
    const vaultKept = plugin.keptOut();
    const skip = (path: string) => {
      const { share, path: inside } = plugin.placeOf(path.slice(0, -1));
      if (!share) return vaultKept(path);
      return !plugin.targets().includes(share) || (!!inside && plugin.keptOut(share)(`${inside}/`));
    };
    new FolderSuggest(this.app, 'Choose the folder to restore', skip, (f) => {
      const { share, path } = plugin.placeOf(f.path);
      this.target(share, path);
    }).open();
  }

  private async review(m: CommitSummary): Promise<void> {
    const asked = (this.asked = m);
    const { share, folder } = this;
    this.step = 'review';
    this.past = undefined;
    this.error = this.note = this.gone = '';
    this.render();
    try {
      const kept = await this.plugin.keptOutFiles(share);
      const look = await this.plugin.look(share);
      // By its number: device clocks disagree, and two moments can share a millisecond, so its time may name another.
      const past = await tableAt(look.repo, look.remote, look.lastSeq, look.cfg, look.now, { seq: m.seq });
      const { steps, left } = restoreSteps(planRestore(look.remote, past.files, folder), look.remote, kept);
      if (this.asked !== asked) return;
      this.past = past;
      this.steps = steps;
      this.left = left;
    } catch (e) {
      if (this.asked !== asked) return;
      // The time may no longer be kept since the list was made: say why over the list as it is now.
      this.asked = undefined;
      this.step = 'choose';
      this.gone =
        e instanceof TooOldError
          ? `That is too far back now: the earliest time that can be restored is ${momentLabel(e.earliest.time, Date.now())}.`
          : `Could not work out what would change: ${historyFailure(e)}`;
      this.pages.reset();
      void this.loadMore();
      return;
    }
    this.render();
  }

  private back(): void {
    this.asked = undefined;
    this.step = 'choose';
    this.error = this.note = '';
    this.render();
  }

  private renderReview(c: HTMLElement): void {
    const past = this.past;
    if (!past) {
      c.createEl('p', { cls: 'coffer-intro', text: 'Working out what would change…' });
      return;
    }
    const me = this.plugin.settings.deviceName;
    c.createDiv({ cls: 'coffer-preview-title', text: `${capital(this.scopeText())} as it was ${momentLabel(past.commit.time, Date.now())}` });
    c.createDiv({ cls: 'coffer-row-sub', text: `When ${deviceLabel(past.commit.device, me)} synced.` });
    message(c, this.note, 'coffer-note');
    message(c, this.error);
    const counts = countSteps(this.steps);
    c.createEl('p', { cls: 'coffer-summary', text: stepSummary(counts) });
    for (const [kind, label] of KIND) {
      const paths = this.steps.filter((s) => s.kind === kind).map((s) => s.path);
      if (!paths.length) continue;
      const d = c.createEl('details', { cls: 'coffer-plan' });
      d.createEl('summary', { text: `${label} (${paths.length.toLocaleString()})` });
      const list = d.createDiv({ cls: 'coffer-files' });
      for (const path of paths.slice(0, MAX_ROWS)) list.createDiv({ cls: 'coffer-file', text: path });
      if (paths.length > MAX_ROWS) list.createDiv({ cls: 'coffer-hint', text: `…and ${(paths.length - MAX_ROWS).toLocaleString()} more` });
    }
    if (this.left) c.createDiv({ cls: 'coffer-hint', text: leftNote(this.left) });
    if (!this.steps.length) {
      button(buttonRow(c), 'Back', () => this.back());
      return;
    }

    const what = c.createEl('ul', { cls: 'coffer-what' });
    what.createEl('li', { text: 'Changes on this device sync first, so nothing unsaved is lost.' });
    if (counts.remove) what.createEl('li', { text: 'Removed files go where your “Deleted files” setting sends them.' });
    what.createEl('li', { text: 'What each file holds now stays in its version history, so this can be undone.' });
    what.createEl('li', { text: 'Your other devices get the result when they next sync.' });
    const confirm = buttonRow(c);
    button(confirm, 'Back', () => this.back());
    button(confirm, `Restore ${plural(this.steps.length, 'file')}`, () => this.apply(), counts.remove ? 'warning' : 'cta');
  }

  private async apply(): Promise<void> {
    const past = this.past!;
    this.step = 'working';
    this.error = this.note = '';
    this.render();
    const unsubscribe = this.plugin.onChange(() => this.step === 'working' && this.render());
    try {
      const out = await this.plugin.restoreTo(past.files, this.folder, this.steps, this.share);
      if (out.changed) {
        this.steps = out.changed;
        this.step = 'review';
        this.note = 'Something changed since this list was made. Check it again, then restore.';
      } else if (out.problem) {
        this.step = 'review';
        this.error = `Nothing was restored. ${out.problem.title}. ${out.problem.detail}`;
      } else {
        this.outcome = out;
        this.step = 'done';
      }
    } catch (e) {
      this.step = 'review';
      this.error = `Nothing was restored: ${historyFailure(e)}`;
    } finally {
      unsubscribe();
    }
    if (!this.closed) this.render();
    else if (this.outcome) new Notice(`${capital(this.scopeText())} is restored. ${stepSummary(countSteps(this.outcome.done), true)}`, 10_000);
    else new Notice(this.error || this.note, 10_000);
  }

  private renderWorking(c: HTMLElement): void {
    statusLine(c, this.plugin.progress || 'Restoring…', 'busy');
    c.createDiv({ cls: 'coffer-sub', text: 'Keep Obsidian open until this finishes. Closing this window does not stop it.' });
  }

  private renderDone(c: HTMLElement): void {
    const out = this.outcome!;
    statusLine(c, out.failed.length ? `Restored, except ${plural(out.failed.length, 'file')}` : 'Restored', out.failed.length ? 'warning' : 'ok');
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `${capital(this.scopeText())} is back to how it was ${momentLabel(this.past!.commit.time, Date.now())}. ${stepSummary(countSteps(out.done), true)}`,
    });
    if (out.failed.length) message(c, `These files could not be restored:\n${out.failed.map((f) => `${f.path}: ${f.message}`).join('\n')}`);
    const p = out.sent?.problem;
    if (p) message(c, `It is not sent to your other devices yet. ${p.title}. ${p.detail}`);
    else c.createDiv({ cls: 'coffer-hint', text: 'Sent to storage. Your other devices get it when they next sync.' });
    if (out.olderPause) {
      message(
        c,
        'Your other devices remove these files too when they next sync. One with an older version of Coffer, or one that has been away for many syncs, may pause first, as it does whenever many files go at once: choose “Delete them everywhere” there to finish. “Keep all files” would bring the removed files back.',
        'coffer-note',
      );
    }
    button(buttonRow(c), 'Close', () => this.close(), 'cta');
  }
}

/** Files listed under one change at most; the rest are counted. */
const MAX_FILES = 20;
const KIND_LABEL = { added: 'added', changed: 'changed', deleted: 'deleted' } as const;

/**
 * Who changed what in a shared folder, newest first, grouped by change: by member name (in a folder shared with a
 * passphrase, by device), with the files each change added, changed and deleted, and who joined or was removed.
 * Tapping a file shows its versions, the one that change made picked.
 */
export class ActivityModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private pages: ActivityPages<Look>;
  private error = '';
  private closed = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
    this.pages = new ActivityPages(
      () => plugin.look(share),
      (l, beforeSeq) => listActivity(l.repo, l.lastSeq, l.cfg, { limit: PAGE, beforeSeq }),
    );
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past');
    this.setTitle(`Activity in “${labelOf(this.share)}”`);
    void this.loadMore();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async loadMore(): Promise<void> {
    const loading = this.pages.next();
    this.error = '';
    this.render();
    try {
      await loading;
    } catch (e) {
      this.error = `Could not load the changes: ${historyFailure(e)}`;
    }
    this.render();
  }

  private render(): void {
    if (this.closed) return;
    const c = this.contentEl;
    c.empty();
    const { items, look, loading, more } = this.pages;
    c.createEl('p', { cls: 'coffer-intro', text: `Changes to ${this.share.property ? `the notes shared in “${this.share.property}”` : 'this shared folder'}, newest first. Tap a file to see its versions.` });
    const rows = look ? activityRows(items, this.plugin.selfIn(this.share, look.members)) : [];
    const list = c.createDiv({ cls: 'coffer-list' });
    days(list, rows, (r) => r.time, (el, r, time) => this.row(el, r, time));
    message(c, this.error);
    if (loading) c.createDiv({ cls: 'coffer-hint', text: 'Loading…' });
    else if (!rows.length && !this.error && !more) c.createEl('p', { cls: 'coffer-intro', text: 'Nothing has changed in this folder yet.' });
    const r = buttonRow(c);
    button(r, 'Close', () => this.close());
    if (more && !loading) button(r, items.length || !this.error ? 'Show earlier changes' : 'Try again', () => this.loadMore());
  }

  private row(parent: HTMLElement, r: ActivityRow, time: string): void {
    if (!r.who) {
      row(parent, r.text, time).addClass('coffer-activity-event');
      return;
    }
    const box = parent.createDiv({ cls: 'coffer-activity' });
    row(box, r.who, `${time} · ${r.text}`);
    const files = box.createDiv({ cls: 'coffer-activity-files' });
    for (const f of r.files.slice(0, MAX_FILES)) {
      // Notes shared by a property keep their versions in the vault's history, which counts its changes apart.
      const pick = this.share.property ? undefined : { seq: r.seq, deleted: f.kind === 'deleted' };
      const el = row(files, f.path, '', () => new VersionsModal(this.app, this.plugin, vaultPath(this.share, f.path), pick).open());
      el.querySelector('.coffer-row-title')!.createSpan({ cls: 'coffer-tag', text: KIND_LABEL[f.kind] });
      if (f.kind === 'deleted') el.addClass('is-deleted');
    }
    if (r.files.length > MAX_FILES) files.createDiv({ cls: 'coffer-hint', text: `…and ${(r.files.length - MAX_FILES).toLocaleString()} more` });
  }
}

/** Checks what storage holds, quickly or by downloading everything, and says what it found in plain words. */
export class VerifyModal extends Modal {
  private plugin: CofferPlugin;
  private share?: Share;
  private deep = false;
  private running = false;
  private report?: VerifyReport;
  private error = '';
  /** What the current files take, for saying how much the thorough check downloads. */
  private stored?: number;
  private progressEl?: HTMLElement;
  private closed = false;

  constructor(app: App, plugin: CofferPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past');
    this.setTitle('Check synced data');
    void this.run(false);
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async run(deep: boolean): Promise<void> {
    if (this.running) return;
    this.deep = deep;
    this.running = true;
    this.report = undefined;
    this.error = '';
    this.render();
    try {
      this.report = await this.plugin.getEngine(this.share).verify({ deep, onProgress: (p) => this.progressEl?.setText(verifyProgress(p)) });
      if (!deep && this.stored === undefined) {
        const look = await this.plugin.look(this.share);
        this.stored = [...look.remote.values()].reduce((n, e) => n + e.size, 0);
      }
    } catch (e) {
      if (!this.report) this.error = `The check could not finish: ${historyFailure(e)}`;
    }
    this.running = false;
    if (!this.closed) this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    placeLine(c, this.plugin, this.share);
    c.createEl('p', {
      cls: 'coffer-intro',
      text: this.deep
        ? 'Downloads everything stored for your files as they are now and checks that it decrypts to what was saved. Nothing is changed.'
        : 'Reads the sync history and checks that the stored data for every file, and for the earlier versions you can restore, is there. Nothing is changed.',
    });
    if (this.running) {
      this.progressEl = statusLine(c, 'Starting…', 'busy');
      return;
    }
    const r = this.report;
    if (!r) {
      message(c, this.error);
      const row = buttonRow(c);
      button(row, 'Close', () => this.close());
      button(row, 'Try again', () => this.run(this.deep), 'cta');
      return;
    }
    const d = describeVerify(r);
    statusLine(c, d.title, d.ok ? 'ok' : 'critical');
    c.createDiv({ cls: 'coffer-sub', text: d.detail });
    for (const f of d.findings) {
      const card = c.createDiv({ cls: `coffer-problem${f.tone === 'critical' ? ' is-critical' : ''}` });
      card.createDiv({ cls: 'coffer-problem-title', text: f.title });
      card.createDiv({ cls: 'coffer-problem-detail', text: f.detail });
      fileList(card, f.files);
      const more = card.createEl('details', { cls: 'coffer-plan' });
      more.createEl('summary', { text: 'Technical details' });
      more.createDiv({ cls: 'coffer-problem-detail', text: f.messages.join('\n') });
    }
    if (!r.deep) {
      c.createDiv({ cls: 'coffer-pick-label', text: 'Thorough check' });
      c.createDiv({
        cls: 'coffer-hint',
        text: `Also downloads everything stored for your files${this.stored === undefined ? '' : ` (about ${sizeLabel(this.stored)})`} and checks that it decrypts to what was saved. This can take a long time, and on a phone it may use mobile data.`,
      });
    }
    const repairable = canRepair(r) && !this.plugin.receivesOnly(this.share);
    if (repairable) {
      c.createDiv({ cls: 'coffer-pick-label', text: 'Repair' });
      c.createDiv({
        cls: 'coffer-hint',
        text: 'If this device has the files affected, their missing or damaged data can be stored again from them. Nothing on this device is changed.',
      });
    }
    const row = buttonRow(c);
    button(row, 'Close', () => this.close(), d.ok || repairable ? 'plain' : 'cta');
    if (!r.deep) button(row, 'Run the thorough check', () => this.run(true));
    if (repairable) {
      button(row, 'Repair from this device', () => {
        this.close();
        new RepairModal(this.app, this.plugin, this.share, r.deep).open();
      }, 'cta');
    }
  }
}

/** Stores again, from this device's files, the data storage lost, and says what that came to. It starts when it opens. */
export class RepairModal extends Modal {
  private plugin: CofferPlugin;
  private share?: Share;
  private deep: boolean;
  private report?: RepairReport;
  private error = '';
  private progressEl?: HTMLElement;
  private closed = false;

  constructor(app: App, plugin: CofferPlugin, share: Share | undefined, deep: boolean) {
    super(app);
    this.plugin = plugin;
    this.share = share;
    this.deep = deep;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-past');
    this.setTitle('Repair synced data');
    void this.run();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async run(): Promise<void> {
    this.report = undefined;
    this.error = '';
    this.render(true);
    try {
      this.report = await this.plugin.repair(this.share, this.deep, (p) => this.progressEl?.setText(verifyProgress(p)));
    } catch (e) {
      this.error = `The repair could not finish: ${historyFailure(e)}`;
    }
    if (!this.closed) this.render(false);
  }

  private render(running: boolean): void {
    const c = this.contentEl;
    c.empty();
    placeLine(c, this.plugin, this.share);
    c.createEl('p', {
      cls: 'coffer-intro',
      text: 'Looks for stored data that is missing or damaged, and stores it again from the files on this device. Nothing on this device is changed.',
    });
    if (running) {
      this.progressEl = statusLine(c, this.deep ? 'Checking the stored data…' : 'Looking for damage…', 'busy');
      return;
    }
    const r = this.report;
    if (!r) {
      message(c, this.error);
      const row = buttonRow(c);
      button(row, 'Close', () => this.close());
      button(row, 'Try again', () => this.run(), 'cta');
      return;
    }
    const d = describeRepair(r, this.deep);
    statusLine(c, d.title, d.ok ? 'ok' : 'critical');
    if (d.detail) c.createDiv({ cls: 'coffer-sub', text: d.detail });
    for (const g of d.groups) {
      const fixed = g.tone === 'ok';
      const card = fixed ? c.createDiv() : c.createDiv({ cls: `coffer-problem${g.tone === 'critical' ? ' is-critical' : ''}` });
      card.createDiv({ cls: fixed ? 'coffer-pick-label' : 'coffer-problem-title', text: g.title });
      card.createDiv({ cls: fixed ? 'coffer-hint' : 'coffer-problem-detail', text: g.detail });
      fileList(card, g.files);
    }
    button(buttonRow(c), 'Close', () => this.close(), 'cta');
  }
}
