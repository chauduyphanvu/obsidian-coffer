// The Branches screen: the vault's lines of history, and what a device can do with them.
import { Modal, Notice, type App } from 'obsidian';
import { listDevices } from '../core/devices.ts';
import type { BranchList, MergeDraft } from '../core/engine.ts';
import { BRANCHES_SINCE, MAIN_NAME, branchNameProblem, takeRows, type Branch } from '../core/lines.ts';
import { errorText, plural } from '../core/text.ts';
import type CofferPlugin from './main.ts';
import type { LineOutcome } from './main.ts';
import { momentLabel } from './restore.ts';
import { button, buttonRow, field, message } from './ui.ts';

/** How many files a merge's review lists by name before it only counts the rest. */
const LISTED = 60;

/** What a merge would do, as lines for its review: one per file, most telling first. */
export function mergeLines(d: MergeDraft): { kind: string; path: string }[] {
  return [
    ...d.copies.map((c) => ({ kind: 'Keep both', path: `${c.of}, theirs as ${c.path}` })),
    ...d.merged.map((m) => ({ kind: 'Combine', path: m.path })),
    ...takeRows(d.take).map((r) => ({ kind: { move: 'Move', add: 'Add', take: 'Take theirs', remove: 'Remove' }[r.kind], path: r.to ? `${r.path} → ${r.to}` : r.path })),
    ...d.kept.map((path) => ({ kind: 'Keep ours', path })),
  ];
}

/** "3 files taken, 1 combined": what a merge would change, or did. */
export function mergeSummary(c: { taken: number; removed: number; merged: number; copies: number; moved?: number }): string {
  const parts = [
    c.taken && `${plural(c.taken, 'file')} taken`,
    c.moved && `${c.moved.toLocaleString()} moved`,
    c.merged && `${c.merged.toLocaleString()} combined`,
    c.removed && `${c.removed.toLocaleString()} removed`,
    c.copies && `${c.copies.toLocaleString()} kept as ${c.copies === 1 ? 'a copy' : 'copies'}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'Nothing to bring in';
}

/** The answer to a branch found closed: this device goes to the main line, and says how that went. */
export async function switchToMain(plugin: CofferPlugin): Promise<void> {
  try {
    const out = await plugin.switchBranch();
    if (out.problem) new Notice(`${out.problem.title}. ${out.problem.detail}`, 10000);
    else new Notice('This device is on the main line now.');
  } catch (e) {
    new Notice(`Could not switch: ${errorText(e)}`, 10000);
  }
}

export class BranchesModal extends Modal {
  private plugin: CofferPlugin;
  private busy = false;
  private name = '';

  constructor(app: App, plugin: CofferPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
    void this.list();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** Runs one thing, with every button off meanwhile, and shows what it throws. Resolves to undefined when it failed. */
  private async run<T>(what: string, task: () => Promise<LineOutcome<T>>): Promise<LineOutcome<T> | undefined> {
    if (this.busy) return undefined;
    this.busy = true;
    const c = this.contentEl;
    c.empty();
    message(c, what, 'coffer-hint');
    try {
      const out = await task();
      if (!out.problem) return out;
      this.fail(`${out.problem.title}. ${out.problem.detail}`);
    } catch (e) {
      this.fail(errorText(e));
    } finally {
      this.busy = false;
    }
    return undefined;
  }

  private fail(text: string): void {
    const c = this.contentEl;
    c.empty();
    message(c, text);
    button(buttonRow(c), 'Back', () => this.list());
  }

  /** How the sync after a change went, as a notice: its problem, or `done`. */
  private after(out: LineOutcome<unknown>, done: string): void {
    const p = out.sent?.problem;
    new Notice(p ? `${done} The sync after it did not finish: ${p.title}.` : done, p ? 10000 : 5000);
  }

  private async list(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    this.setTitle('Branches');
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'A branch is a second line of this vault’s history. A device on it has the branch’s files and syncs with the other devices on it, while the rest carry on as before. ' +
        'Merging brings the changes across; closing a branch drops it.',
    });
    if (!this.plugin.configured()) return void message(c, 'Set up sync first.', 'coffer-hint');
    const loading = c.createDiv({ cls: 'coffer-hint', text: 'Loading…' });
    let l: BranchList;
    let where = new Map<string, string[]>();
    try {
      const engine = this.plugin.getEngine();
      l = await engine.branches();
      if (l.upgraded) {
        const devices = await engine.view().then(listDevices, () => []);
        where = new Map();
        for (const d of devices) if (!d.isSelf) where.set(d.line ?? '', [...(where.get(d.line ?? '') ?? []), d.name]);
      }
    } catch (e) {
      loading.remove();
      // A branch found closed stops every read of it: the way out is still offered.
      message(c, errorText(e));
      button(buttonRow(c), 'Switch to the main line', () => this.switchTo(undefined), 'cta');
      return;
    }
    loading.remove();
    if (!l.upgraded) return this.offerUpgrade(c);

    const open = l.branches.filter((b) => !b.closed);
    const here = l.branches.find((b) => b.id === l.current);
    const now = Date.now();
    const others = (id: string) => {
      const names = where.get(id) ?? [];
      return names.length ? `Also here: ${names.join(', ')}` : '';
    };
    const rows = c.createDiv({ cls: 'coffer-devices coffer-branches' });
    const row = (title: string, current: boolean, meta: string[]) => {
      const el = rows.createDiv({ cls: 'coffer-device' });
      const text = el.createDiv({ cls: 'coffer-device-text' });
      const name = text.createDiv({ cls: 'coffer-device-name', text: title });
      if (current) name.createSpan({ cls: 'coffer-device-tag', text: 'This device is here' });
      for (const m of meta.filter(Boolean)) text.createDiv({ cls: 'coffer-device-meta', text: m });
      return el.createDiv({ cls: 'coffer-branch-actions' });
    };
    const main = row('Main line', !l.current, ['The vault’s own line, which every device is on until it switches.', others('')]);
    if (l.current) button(main, 'Switch', () => this.switchTo(undefined));
    for (const b of open) {
      const current = b.id === l.current;
      const actions = row(b.name, current, [`Started ${momentLabel(b.created, now)} by ${b.by}`, others(b.id)]);
      if (!current) button(actions, 'Switch', () => this.switchTo(b));
      if (current) button(actions, 'Bring in the main line…', () => this.review(b), 'cta');
      else if (!l.current) button(actions, 'Merge into the main line…', () => this.review(b), 'cta');
      if (!current) button(actions, 'Close…', () => this.confirmClose(b, where.get(b.id) ?? []));
    }
    if (l.current && (!here || here.closed)) message(c, `The branch this device is on${here ? `, “${here.name}”,` : ''} was closed. Switch to the main line to carry on: what this device has not sent goes along.`);

    if (l.current) return void message(c, 'A new branch starts from the main line: switch to it first.', 'coffer-hint');
    this.startForm(c, l.branches, false);
  }

  private startForm(c: HTMLElement, existing: Branch[], upgrade: boolean): void {
    const problem = c.createDiv({ cls: 'coffer-error' });
    const input = field(c, 'New branch', { value: this.name, placeholder: 'A name, like “Reorganise projects”', hint: 'It starts as the vault is now and puts this device on it. No file changes; other devices stay where they are until they switch.' }, (v) => {
      this.name = v;
      problem.setText('');
    });
    const start = () => {
      const p = branchNameProblem(this.name, existing);
      if (p) return void problem.setText(p);
      return upgrade ? this.confirmUpgrade() : this.start(false);
    };
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void start();
    });
    button(buttonRow(c), upgrade ? 'Start a branch…' : 'Start the branch', start, 'cta');
  }

  private offerUpgrade(c: HTMLElement): void {
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `This vault has no branches yet. The first one upgrades the vault, once, so that every device knows to keep a branch’s data. After that, versions of Coffer before ${BRANCHES_SINCE} can no longer open it.`,
    });
    this.startForm(c, [], true);
  }

  private async confirmUpgrade(): Promise<void> {
    const c = this.contentEl;
    c.empty();
    this.setTitle('Upgrade this vault for branches?');
    message(c, 'Checking the other devices…', 'coffer-hint');
    let old: { name: string; version: string }[];
    try {
      old = await this.plugin.getEngine().upgradeBlockers();
    } catch (e) {
      return this.fail(errorText(e));
    }
    c.empty();
    if (old.length) {
      c.createEl('p', { cls: 'coffer-intro', text: `Not yet. ${old.length === 1 ? 'Another device runs' : 'Other devices run'} a version of Coffer from before branches, which could no longer open the vault afterwards:` });
      const list = c.createEl('ul');
      for (const d of old) list.createEl('li', { text: `${d.name} (v${d.version})` });
      c.createEl('p', { cls: 'coffer-intro', text: `Update Coffer there to ${BRANCHES_SINCE} or later and sync once. A device that is gone for good can be forgotten under Devices in the settings.` });
      button(buttonRow(c), 'Back', () => this.list());
      return;
    }
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        `Every device that syncs this vault runs a version with branches. Upgrading cannot be undone: from then on a version of Coffer before ${BRANCHES_SINCE} refuses to open this vault and asks to be updated. ` +
        'Nothing else changes, and your files stay as they are. A backup of the storage first is never a bad idea.',
    });
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.list());
    button(row, `Upgrade and start “${this.name.trim()}”`, () => this.start(true), 'warning');
  }

  private async start(upgrade: boolean): Promise<void> {
    const out = await this.run('Starting the branch…', () => this.plugin.startBranch(this.name, upgrade));
    if (!out?.value) return;
    new Notice(`This device is on the branch “${out.value.name}” now.`);
    this.name = '';
    await this.list();
  }

  private async switchTo(to: Branch | undefined): Promise<void> {
    const out = await this.run('Switching…', () => this.plugin.switchBranch(to));
    if (!out?.value) return;
    const { changed } = out.value;
    this.after(out, `This device is on ${to ? `the branch “${to.name}”` : 'the main line'} now${changed ? `; ${plural(changed, 'file')} ${changed === 1 ? 'differs' : 'differ'}.` : '.'}`);
    await this.list();
  }

  /** The merge between `b` and the main line, worked out and shown before anything changes. */
  private async review(b: Branch): Promise<void> {
    const out = await this.run('Syncing, then working out the merge…', () => this.plugin.mergeDraft(b));
    const d = out?.value;
    if (!d) return;
    const c = this.contentEl;
    c.empty();
    const from = d.from === MAIN_NAME ? 'the main line' : `“${d.from}”`;
    const into = d.into ? `“${b.name}”` : 'the main line';
    this.setTitle(`Merge ${from} into ${into}`);
    const lines = mergeLines(d);
    const changes = d.take.length + d.merged.length + d.copies.length;
    const rows = takeRows(d.take);
    const count = (kind: string) => rows.filter((r) => r.kind === kind).length;
    c.createEl('p', {
      cls: 'coffer-intro',
      text: changes
        ? `${mergeSummary({ taken: count('add') + count('take'), moved: count('move'), removed: count('remove'), merged: d.merged.length, copies: d.copies.length })}. What only ${from} changed is taken as it is, notes changed on both lines are combined, and where that cannot be done both versions are kept. This line’s own changes stay.`
        : `${into[0].toUpperCase()}${into.slice(1)} already has everything ${from} changed.`,
    });
    if (lines.length) {
      const list = c.createDiv({ cls: 'coffer-merge-list' });
      for (const l of lines.slice(0, LISTED)) {
        const el = list.createDiv({ cls: 'coffer-merge-row' });
        el.createSpan({ cls: 'coffer-merge-kind', text: l.kind });
        el.createSpan({ cls: 'coffer-merge-path', text: l.path });
      }
      if (lines.length > LISTED) message(c, `And ${plural(lines.length - LISTED, 'more file')}.`, 'coffer-hint');
    }
    message(c, 'A merge is one change in the history, so Undo can take it back out. The branch stays open and can be merged again.', 'coffer-hint');
    const row = buttonRow(c);
    button(row, changes ? 'Cancel' : 'Back', () => this.list());
    if (changes) button(row, 'Merge', () => this.merge(d, b), 'cta');
  }

  private async merge(d: MergeDraft, b: Branch): Promise<void> {
    const out = await this.run('Merging…', () => this.plugin.mergeBranch(d));
    const res = out?.value;
    if (!res) return;
    const done = `Merged: ${mergeSummary({ taken: res.taken, removed: res.removed, merged: res.merged, copies: res.copies.length }).toLowerCase()}.`;
    if (res.skipped.length) {
      const c = this.contentEl;
      c.empty();
      message(c, `${done} ${plural(res.skipped.length, 'file')} changed here while the merge was worked out and ${res.skipped.length === 1 ? 'was' : 'were'} left as ${res.skipped.length === 1 ? 'it is' : 'they are'}: ${res.skipped.slice(0, 10).join(', ')}. Merge again to take ${res.skipped.length === 1 ? 'it' : 'them'}.`, 'coffer-hint');
      const row = buttonRow(c);
      button(row, 'Back', () => this.list());
      button(row, 'Merge again…', () => this.review(b), 'cta');
      return;
    }
    this.after(out, done);
    await this.list();
  }

  private confirmClose(b: Branch, on: string[]): void {
    const c = this.contentEl;
    c.empty();
    this.setTitle(`Close “${b.name}”?`);
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'The branch takes no more changes. What it holds that was never merged into the main line can no longer be reached, and its data is removed from storage 30 days from now. Merge first if you want to keep it.' +
        (on.length ? ` ${on.join(', ')} ${on.length === 1 ? 'is' : 'are'} still on it and will be asked to switch to the main line at the next sync.` : ''),
    });
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.list());
    button(row, 'Close the branch', async () => {
      const out = await this.run('Closing the branch…', () => this.plugin.closeBranch(b));
      if (!out?.value) return;
      new Notice(`Closed the branch “${b.name}”.`);
      await this.list();
    }, 'warning');
  }
}
