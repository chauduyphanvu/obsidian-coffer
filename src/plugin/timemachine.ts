// Looking at the past and bringing it back: a file's versions, deleted files, the vault or a folder at an earlier
// time, and a check of what storage holds. Decisions live in restore.ts; this file only shows them.
import { FuzzySuggestModal, Modal, Notice, Platform, TFile, TFolder, type App } from 'obsidian';
import { fileName, vaultKey } from '../core/paths.ts';
import { listVersions } from '../core/retention.ts';
import { TooOldError, listCommits, listDeleted, planRestore, tableAt, type CommitSummary, type DeletedFile, type PastVault } from '../core/timeline.ts';
import { sameContent, type Version } from '../core/types.ts';
import type { VerifyReport } from '../core/verify.ts';
import type SelfSyncPlugin from './main.ts';
import type { Failed, Look, RestoreOutcome } from './main.ts';
import {
  byDay,
  changesLabel,
  countSteps,
  countable,
  describeVerify,
  deviceLabel,
  lineChanges,
  matchesQuery,
  momentLabel,
  previewVersion,
  restoreSteps,
  scopeName,
  sizeLabel,
  stepSummary,
  timeLabels,
  verifyProgress,
  type DiffLine,
  type Preview,
  type Step,
} from './restore.ts';
import { MAX_COMPARE_BYTES, describeFailure, plural } from './status.ts';
import { button, buttonRow, message, openLink, statusLine } from './ui.ts';

/** Rows drawn at most in one list; typing narrows it. */
const MAX_ROWS = 300;
/** Diff lines and characters of whole text drawn at most, so a huge file cannot freeze the screen. */
const MAX_LINES = 3000;
const MAX_CHARS = 200_000;
const PAGE = 30;

const failure = (e: unknown) => {
  const p = describeFailure(e);
  return p.id.startsWith('failed') ? p.detail : `${p.title}. ${p.detail}`;
};
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A row in a list: a title and a line under it, tappable when there is something to do. */
function row(parent: HTMLElement, title: string, sub: string, onClick?: () => void): HTMLElement {
  const el = parent.createEl(onClick ? 'button' : 'div', { cls: 'self-sync-row' });
  el.createDiv({ cls: 'self-sync-row-title', text: title });
  if (sub) el.createDiv({ cls: 'self-sync-row-sub', text: sub });
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** A whole-row checkbox with room for text beside it; returns where the text goes. */
function checkRow(parent: HTMLElement, checked: boolean, onChange: (checked: boolean) => void): HTMLElement {
  const label = parent.createEl('label', { cls: 'self-sync-check-row' });
  const box = label.createEl('input', { attr: { type: 'checkbox' } });
  box.checked = checked;
  box.addEventListener('change', () => onChange(box.checked));
  return label.createDiv({ cls: 'self-sync-check-body' });
}

/** Items under a heading per day, each with its time of day. */
function days<T>(parent: HTMLElement, items: T[], timeOf: (item: T) => number, each: (parent: HTMLElement, item: T, time: string) => void): void {
  const times = timeLabels(items.map(timeOf));
  const at = new Map(items.map((x, i) => [x, times[i]]));
  for (const d of byDay(items, timeOf, Date.now())) {
    parent.createDiv({ cls: 'self-sync-day', text: d.day });
    for (const x of d.items) each(parent, x, at.get(x)!);
  }
}

function showDiff(parent: HTMLElement, lines: DiffLine[]): void {
  const box = parent.createDiv({ cls: 'self-sync-diff' });
  for (const l of lines.slice(0, MAX_LINES)) {
    if (l.kind === 'gap') {
      box.createDiv({ cls: 'self-sync-diff-gap', text: `⋯ ${plural(l.lines, 'line')} the same ⋯` });
      continue;
    }
    const el = box.createDiv({ cls: `self-sync-diff-line is-${l.kind}` });
    el.createSpan({ cls: 'self-sync-diff-mark', text: l.kind === 'added' ? '+' : l.kind === 'removed' ? '−' : '' });
    el.createSpan({ cls: 'self-sync-diff-text', text: l.text });
  }
  if (lines.length > MAX_LINES) parent.createDiv({ cls: 'self-sync-hint', text: `Only the first ${MAX_LINES.toLocaleString()} lines are shown. “Whole text” shows all of this version.` });
}

function showWhole(parent: HTMLElement, text: string): void {
  parent.createDiv({ cls: 'self-sync-whole', text: text.slice(0, MAX_CHARS) });
  if (text.length > MAX_CHARS) parent.createDiv({ cls: 'self-sync-hint', text: 'Only the beginning of this version is shown.' });
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
  private plugin: SelfSyncPlugin;
  private path: string;
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

  constructor(app: App, plugin: SelfSyncPlugin, path: string) {
    super(app);
    this.plugin = plugin;
    this.path = path;
    this.name = fileName(path);
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal', 'self-sync-past', 'self-sync-wide');
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
    this.contentEl.createEl('p', { cls: 'self-sync-intro', text: 'Loading versions…' });
    try {
      const look = await this.plugin.look();
      const key = vaultKey(this.path);
      this.versions = await listVersions(look.repo, look.lastSeq, key, look.cfg, look.now);
      const synced = look.remote.get(key);
      const newest = this.versions.find((v) => v.entry);
      if (synced && newest && sameContent(newest.entry!, synced)) this.now = newest;
      const file = this.app.vault.getAbstractFileByPath(this.path);
      this.current = !(file instanceof TFile) ? null : file.stat.size <= MAX_COMPARE_BYTES ? new Uint8Array(await this.app.vault.readBinary(file)) : undefined;
    } catch (e) {
      this.error = `Could not load the versions: ${failure(e)}`;
    }
    if (!this.closed) this.render();
  }

  /** A version's bytes, downloaded once while the dialog is open; only the last few are kept. */
  private read(v: Version): Promise<Uint8Array> {
    let p = this.bytes.get(v.seq);
    if (!p) {
      p = this.plugin.getEngine().readVersion(v.entry!);
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
      else c.createEl('p', { cls: 'self-sync-intro', text: `No versions of “${this.name}” are stored. A file shows up here once it has synced.` });
      button(buttonRow(c), 'Close', () => this.close());
      return;
    }
    this.panes = c.createDiv({ cls: 'self-sync-panes' });
    this.renderList(this.panes.createDiv({ cls: 'self-sync-pane self-sync-pane-list' }));
    this.previewEl = this.panes.createDiv({ cls: 'self-sync-pane self-sync-pane-preview' });
    this.renderPreview();
  }

  private renderList(parent: HTMLElement): void {
    const me = this.plugin.settings.deviceName;
    parent.createEl('p', {
      cls: 'self-sync-intro',
      text: `Versions from the last ${plural(this.plugin.settings.retentionDays, 'day')}, newest first. Pick one to see it before restoring.`,
    });
    const list = parent.createDiv({ cls: 'self-sync-list' });
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
        row(el, time, `Deleted on ${deviceLabel(v.device, me)}`).addClass('is-deleted');
        return;
      }
      const r = row(el, time, '', () => this.pick(v));
      this.rows.set(v.seq, r);
      if (v === this.now) r.querySelector('.self-sync-row-title')!.createSpan({ cls: 'self-sync-tag', text: 'Now' });
      const sub = r.createDiv({ cls: 'self-sync-row-sub' });
      sub.createSpan({ text: `${deviceLabel(v.device, me)} · ${sizeLabel(v.entry.size)}` });
      const counts = sub.createSpan({ cls: 'self-sync-counts' });
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
      if (this.picked === v) this.error = `Could not download this version: ${failure(e)}`;
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
      p.createDiv({ cls: 'self-sync-hint', text: 'Pick a version to see it here.' });
      return;
    }
    const me = this.plugin.settings.deviceName;
    button(p, '‹ All versions', () => this.unpick()).buttonEl.addClass('self-sync-back');
    p.createDiv({ cls: 'self-sync-preview-title', text: `The version from ${momentLabel(v.time, Date.now())}` });
    p.createDiv({ cls: 'self-sync-row-sub', text: `Saved by ${deviceLabel(v.device, me)} · ${sizeLabel(v.entry!.size)}` });
    const pv = this.preview;
    if (!pv) {
      if (this.error) message(p, this.error);
      else p.createEl('p', { cls: 'self-sync-intro', text: 'Downloading this version…' });
      return;
    }
    if (pv.kind === 'changes') {
      p.createEl('p', {
        cls: 'self-sync-intro',
        text: `Restoring it would add ${plural(pv.added, 'line')} to the file as it is now and remove ${pv.removed.toLocaleString()}.`,
      });
      const pick = p.createDiv({ cls: 'self-sync-pick' });
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
        p.createDiv({ cls: 'self-sync-hint', text: '+ marks a line restoring adds, − a line it removes.' });
        showDiff(p, pv.lines);
      }
    } else if (pv.kind === 'same') {
      p.createEl('p', { cls: 'self-sync-intro', text: 'This version is the same as the file is now.' });
    } else if (pv.kind === 'text') {
      p.createEl('p', {
        cls: 'self-sync-intro',
        text: pv.why === 'missing' ? `There is no “${this.name}” now. Restoring brings it back with this text:` : "This version can't be compared line by line with the file as it is now. Here is all of it:",
      });
      showWhole(p, pv.text);
    } else {
      p.createEl('p', { cls: 'self-sync-intro', text: pv.why === 'binary' ? "This kind of file can't be shown here." : 'This version is too large to show here.' });
    }

    message(p, this.error);
    p.createDiv({
      cls: 'self-sync-hint',
      text: this.current === null ? `Restoring brings “${this.name}” back as it was then.` : `Restoring replaces “${this.name}” with this version. What it holds now stays in its version history.`,
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
      this.error = `Could not restore: ${failure(e)}`;
      this.renderPreview();
    }
  }
}

/** Files deleted within the time versions are kept, newest first, to bring back one or several at once. */
export class DeletedModal extends Modal {
  private plugin: SelfSyncPlugin;
  private files: DeletedFile[] = [];
  private picked = new Set<DeletedFile>();
  private query = '';
  private error = '';
  private busy = false;
  private loaded = false;
  private listEl?: HTMLElement;
  private footEl?: HTMLElement;

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal', 'self-sync-past');
    this.setTitle('Restore deleted files');
    this.contentEl.createEl('p', { cls: 'self-sync-intro', text: 'Looking for deleted files…' });
    void this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async load(): Promise<void> {
    try {
      const look = await this.plugin.look();
      const kept = this.plugin.keptOut();
      this.files = (await listDeleted(look.repo, look.lastSeq, look.cfg, look.now)).filter((d) => !kept(d.path));
    } catch (e) {
      this.error = `Could not look for deleted files: ${failure(e)}`;
    }
    this.loaded = true;
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (!this.files.length) {
      if (this.error) message(c, this.error);
      else if (this.loaded) {
        c.createEl('p', { cls: 'self-sync-intro', text: `No deleted files can be brought back. Files deleted in the last ${plural(this.plugin.settings.retentionDays, 'day')} show up here.` });
      }
      button(buttonRow(c), 'Close', () => this.close());
      return;
    }
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: `${plural(this.files.length, 'file')} deleted in the last ${plural(this.plugin.settings.retentionDays, 'day')} can be brought back, newest first.`,
    });
    const search = c.createEl('input', {
      cls: 'self-sync-search',
      attr: { type: 'search', placeholder: 'Filter by name or folder', 'aria-label': 'Filter by name or folder', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' },
    });
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
      this.renderFoot();
    });
    this.listEl = c.createDiv();
    this.footEl = c.createDiv({ cls: 'self-sync-foot' });
    this.renderList();
    this.renderFoot();
  }

  private renderList(): void {
    const l = this.listEl!;
    l.empty();
    const me = this.plugin.settings.deviceName;
    const shown = this.files.filter((f) => matchesQuery(f.path, this.query)).slice(0, MAX_ROWS);
    if (!shown.length) {
      l.createDiv({ cls: 'self-sync-hint', text: 'No deleted file matches.' });
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
    }).createDiv({ cls: 'self-sync-row-title', text: shown.length === 1 ? 'Select the one shown' : `Select all ${shown.length.toLocaleString()} shown` });
    const list = l.createDiv({ cls: 'self-sync-list' });
    days(list, shown, (f) => f.time, (el, f, time) => {
      const body = checkRow(el, this.picked.has(f), (on) => {
        if (on) this.picked.add(f);
        else this.picked.delete(f);
        this.renderFoot();
      });
      body.createDiv({ cls: 'self-sync-row-title', text: fileName(f.path) });
      const folder = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
      body.createDiv({ cls: 'self-sync-row-sub', text: `${folder ? `in ${folder} · ` : ''}deleted at ${time} on ${deviceLabel(f.device, me)}` });
    });
    const matching = this.files.filter((f) => matchesQuery(f.path, this.query)).length;
    if (matching > shown.length) l.createDiv({ cls: 'self-sync-hint', text: `Showing the newest ${shown.length.toLocaleString()} of ${matching.toLocaleString()}. Type to narrow the list.` });
  }

  private renderFoot(): void {
    const f = this.footEl!;
    f.empty();
    message(f, this.error);
    const n = this.picked.size;
    f.createDiv({ cls: 'self-sync-hint', text: 'Files come back where they were. If something has that name now, the file comes back beside it with “(restored)” in its name.' });
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
      this.done(await this.plugin.restoreDeleted(this.files.filter((f) => this.picked.has(f))));
    } catch (e) {
      this.busy = false;
      this.error = `Could not restore: ${failure(e)}`;
      this.renderFoot();
    }
  }

  private done({ placed, failed }: { placed: { path: string; to: string }[]; failed: Failed[] }): void {
    const c = this.contentEl;
    c.empty();
    if (placed.length) {
      statusLine(c, `${plural(placed.length, 'file')} brought back`, failed.length ? 'warning' : 'ok');
      c.createDiv({ cls: 'self-sync-sub', text: 'The next sync sends them to your other devices.' });
      const list = c.createDiv({ cls: 'self-sync-files' });
      for (const p of placed) {
        const r = list.createDiv({ cls: 'self-sync-file' });
        r.createSpan({ text: p.to === p.path ? p.path : `${p.path} came back as “${fileName(p.to)}”, as something has its name now` });
        openLink(r, this.app, 'Open', p.to, () => this.close());
      }
    }
    if (failed.length) message(c, `${placed.length ? 'These could not be brought back' : 'Nothing could be brought back'}:\n${failed.map((x) => `${x.path}: ${x.message}`).join('\n')}`);
    button(buttonRow(c), 'Close', () => this.close(), 'cta');
  }
}

class FolderSuggest extends FuzzySuggestModal<TFolder> {
  private skip: (path: string) => boolean;
  private chosen: (folder: TFolder) => void;

  constructor(app: App, skip: (path: string) => boolean, chosen: (folder: TFolder) => void) {
    super(app);
    this.skip = skip;
    this.chosen = chosen;
    this.setPlaceholder('Choose the folder to restore');
  }

  getItems(): TFolder[] {
    return this.app.vault.getAllFolders(false).filter((f) => !this.skip(`${f.path}/`));
  }

  getItemText(folder: TFolder): string {
    return folder.path;
  }

  onChooseItem(folder: TFolder): void {
    this.chosen(folder);
  }
}

const KIND: [Step['kind'], string][] = [['add', 'Brought back'], ['change', 'Changed'], ['remove', 'Removed']];

/**
 * The whole vault or one folder back to how it was at an earlier time: pick the time and the scope, see exactly what
 * would change, confirm, then watch it happen.
 */
export class RestoreEarlierModal extends Modal {
  private plugin: SelfSyncPlugin;
  private folder: string;
  private step: 'choose' | 'review' | 'working' | 'done' = 'choose';
  private look?: Look;
  private moments: CommitSummary[] = [];
  private more = true;
  private loading = false;
  private error = '';
  private note = '';
  /** The moment being worked out, so a slower answer for one tapped earlier is dropped. */
  private asked?: CommitSummary;
  private past?: PastVault;
  private steps: Step[] = [];
  private left = 0;
  private outcome?: RestoreOutcome;
  private closed = false;

  constructor(app: App, plugin: SelfSyncPlugin, folder: string) {
    super(app);
    this.plugin = plugin;
    this.folder = folder;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal', 'self-sync-past');
    this.setTitle('Restore to an earlier time');
    void this.loadMore();
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
  }

  private async loadMore(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.error = '';
    this.render();
    try {
      this.look ??= await this.plugin.look();
      const l = this.look;
      const page = await listCommits(l.repo, l.lastSeq, l.cfg, l.now, { limit: PAGE, before: this.moments.at(-1)?.time });
      const seen = new Set(this.moments.map((m) => m.seq));
      const fresh = page.filter((m) => !seen.has(m.seq));
      this.moments.push(...fresh);
      this.more = page.length === PAGE && fresh.length > 0;
    } catch (e) {
      this.error = `Could not load earlier times: ${failure(e)}`;
    }
    this.loading = false;
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
    c.createDiv({ cls: 'self-sync-pick-label', text: 'What to restore' });
    const pick = c.createDiv({ cls: 'self-sync-pick' });
    const option = (text: string, on: boolean, run: () => void) => {
      const b = button(pick, text, run);
      b.buttonEl.toggleClass('is-selected', on);
      b.buttonEl.setAttr('aria-pressed', String(on));
    };
    option('The whole vault', !this.folder, () => {
      this.folder = '';
      this.render();
    });
    option('One folder', !!this.folder, () => this.chooseFolder());
    if (this.folder) {
      const f = c.createDiv({ cls: 'self-sync-file' });
      f.createSpan({ text: this.folder });
      button(f, 'Change', () => this.chooseFolder());
    }

    c.createDiv({ cls: 'self-sync-pick-label', text: 'Bring it back to how it was' });
    c.createDiv({ cls: 'self-sync-hint', text: 'Each time is when a device synced. The numbers say what that sync changed across the vault.' });
    const me = this.plugin.settings.deviceName;
    const list = c.createDiv({ cls: 'self-sync-list' });
    days(list, this.moments, (m) => m.time, (el, m, time) => {
      row(el, time, `${deviceLabel(m.device, me)} · ${changesLabel(m)}`, () => void this.review(m));
    });
    message(c, this.error);
    if (this.loading) c.createDiv({ cls: 'self-sync-hint', text: 'Loading…' });
    else if (!this.moments.length && !this.error) c.createEl('p', { cls: 'self-sync-intro', text: 'Nothing has synced yet, so there is no earlier time to go back to.' });
    const r = buttonRow(c);
    button(r, 'Cancel', () => this.close());
    if (this.more && !this.loading && this.moments.length) button(r, 'Show earlier times', () => this.loadMore());
  }

  private chooseFolder(): void {
    new FolderSuggest(this.app, this.plugin.keptOut(), (f) => {
      this.folder = f.path;
      this.render();
    }).open();
  }

  private async review(m: CommitSummary): Promise<void> {
    const asked = (this.asked = m);
    this.step = 'review';
    this.past = undefined;
    this.error = this.note = '';
    this.render();
    try {
      const look = (this.look = await this.plugin.look());
      const past = await tableAt(look.repo, look.remote, look.lastSeq, look.cfg, look.now, m.time);
      const { steps, left } = restoreSteps(planRestore(look.remote, past.files, this.folder), look.remote, this.plugin.keptOut());
      if (this.asked !== asked) return;
      this.past = past;
      this.steps = steps;
      this.left = left;
    } catch (e) {
      if (this.asked !== asked) return;
      this.error =
        e instanceof TooOldError
          ? `That is too far back: the earliest time that can be restored is ${momentLabel(e.earliest.time, Date.now())}.`
          : `Could not work out what would change: ${failure(e)}`;
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
      if (this.error) {
        message(c, this.error);
        button(buttonRow(c), 'Back', () => this.back());
      } else c.createEl('p', { cls: 'self-sync-intro', text: 'Working out what would change…' });
      return;
    }
    const me = this.plugin.settings.deviceName;
    c.createDiv({ cls: 'self-sync-preview-title', text: `${capital(scopeName(this.folder))} as it was ${momentLabel(past.commit.time, Date.now())}` });
    c.createDiv({ cls: 'self-sync-row-sub', text: `When ${deviceLabel(past.commit.device, me)} synced.` });
    message(c, this.note, 'self-sync-note');
    message(c, this.error);
    const counts = countSteps(this.steps);
    c.createEl('p', { cls: 'self-sync-summary', text: stepSummary(counts) });
    for (const [kind, label] of KIND) {
      const paths = this.steps.filter((s) => s.kind === kind).map((s) => s.path);
      if (!paths.length) continue;
      const d = c.createEl('details', { cls: 'self-sync-plan' });
      d.createEl('summary', { text: `${label} (${paths.length.toLocaleString()})` });
      const list = d.createDiv({ cls: 'self-sync-files' });
      for (const path of paths.slice(0, MAX_ROWS)) list.createDiv({ cls: 'self-sync-file', text: path });
      if (paths.length > MAX_ROWS) list.createDiv({ cls: 'self-sync-hint', text: `…and ${(paths.length - MAX_ROWS).toLocaleString()} more` });
    }
    if (this.left) c.createDiv({ cls: 'self-sync-hint', text: `${plural(this.left, 'file')} excluded from sync on this device ${this.left === 1 ? 'stays as it is' : 'stay as they are'}.` });
    if (!this.steps.length) {
      button(buttonRow(c), 'Back', () => this.back());
      return;
    }

    const what = c.createEl('ul', { cls: 'self-sync-what' });
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
      const out = await this.plugin.restoreTo(past.files, this.folder, this.steps);
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
      this.error = `Nothing was restored: ${failure(e)}`;
    } finally {
      unsubscribe();
    }
    if (!this.closed) this.render();
    else if (this.outcome) new Notice(`${capital(scopeName(this.folder))} is restored. ${stepSummary(countSteps(this.outcome.done), true)}`, 10_000);
    else new Notice(this.error || this.note, 10_000);
  }

  private renderWorking(c: HTMLElement): void {
    statusLine(c, this.plugin.progress || 'Restoring…', 'busy');
    c.createDiv({ cls: 'self-sync-sub', text: 'Keep Obsidian open until this finishes. Closing this window does not stop it.' });
  }

  private renderDone(c: HTMLElement): void {
    const out = this.outcome!;
    statusLine(c, out.failed.length ? `Restored, except ${plural(out.failed.length, 'file')}` : 'Restored', out.failed.length ? 'warning' : 'ok');
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: `${capital(scopeName(this.folder))} is back to how it was ${momentLabel(this.past!.commit.time, Date.now())}. ${stepSummary(countSteps(out.done), true)}`,
    });
    if (out.failed.length) message(c, `These files could not be restored:\n${out.failed.map((f) => `${f.path}: ${f.message}`).join('\n')}`);
    const p = out.sent?.problem;
    if (p) message(c, `It is not sent to your other devices yet. ${p.title}. ${p.detail}`);
    else c.createDiv({ cls: 'self-sync-hint', text: 'Sent to storage. Your other devices get it when they next sync.' });
    if (out.othersPause) {
      message(
        c,
        'Your other devices will pause before removing these files, as they do whenever many files go at once. Choose “Delete them everywhere” there to finish; “Keep all files” would bring the removed files back.',
        'self-sync-note',
      );
    }
    button(buttonRow(c), 'Close', () => this.close(), 'cta');
  }
}

/** Checks what storage holds, quickly or by downloading everything, and says what it found in plain words. */
export class VerifyModal extends Modal {
  private plugin: SelfSyncPlugin;
  private deep = false;
  private running = false;
  private report?: VerifyReport;
  private error = '';
  /** What the current files take, for saying how much the thorough check downloads. */
  private stored?: number;
  private progressEl?: HTMLElement;
  private closed = false;

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal', 'self-sync-past');
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
      this.report = await this.plugin.getEngine().verify({ deep, onProgress: (p) => this.progressEl?.setText(verifyProgress(p)) });
      if (!deep && this.stored === undefined) {
        const look = await this.plugin.look();
        this.stored = [...look.remote.values()].reduce((n, e) => n + e.size, 0);
      }
    } catch (e) {
      if (!this.report) this.error = `The check could not finish: ${failure(e)}`;
    }
    this.running = false;
    if (!this.closed) this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: this.deep
        ? 'Downloads everything stored for your files as they are now and checks that it decrypts to what was saved. Nothing is changed.'
        : 'Reads the sync history and checks that the stored data for every file is there. Nothing is changed.',
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
    c.createDiv({ cls: 'self-sync-sub', text: d.detail });
    for (const f of d.findings) {
      const card = c.createDiv({ cls: 'self-sync-problem is-critical' });
      card.createDiv({ cls: 'self-sync-problem-title', text: f.title });
      card.createDiv({ cls: 'self-sync-problem-detail', text: f.detail });
      if (f.files.length) {
        const list = card.createDiv({ cls: 'self-sync-files' });
        for (const path of f.files.slice(0, 20)) list.createDiv({ cls: 'self-sync-file', text: path });
        if (f.files.length > 20) list.createDiv({ cls: 'self-sync-hint', text: `…and ${(f.files.length - 20).toLocaleString()} more` });
      }
      const more = card.createEl('details', { cls: 'self-sync-plan' });
      more.createEl('summary', { text: 'Technical details' });
      more.createDiv({ cls: 'self-sync-problem-detail', text: f.messages.join('\n') });
    }
    if (!r.deep) {
      c.createDiv({ cls: 'self-sync-pick-label', text: 'Thorough check' });
      c.createDiv({
        cls: 'self-sync-hint',
        text: `Also downloads everything stored for your files${this.stored === undefined ? '' : ` (about ${sizeLabel(this.stored)})`} and checks that it decrypts to what was saved. This can take a long time, and on a phone it may use mobile data.`,
      });
    }
    const row = buttonRow(c);
    button(row, 'Close', () => this.close(), d.ok ? 'cta' : 'plain');
    if (!r.deep) button(row, 'Run the thorough check', () => this.run(true));
  }
}
