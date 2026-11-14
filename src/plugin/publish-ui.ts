// Publishing the website on screen: what would change, then the upload as it goes. The building and uploading are in src/publish.
import { Modal, Notice, type App } from 'obsidian';
import { errorText } from '../core/text.ts';
import type { RemoteStore } from '../core/types.ts';
import { changesOf, summaryLines, type Prepared } from '../publish/publish.ts';
import type CofferPlugin from './main.ts';
import { siteLink } from './settings.ts';
import { button, buttonRow, message } from './ui.ts';

/** How many names a list shows before it says how many more there are. */
const SHOWN = 30;

/** What the screen is showing. Every change of it goes through `show`. */
type State =
  | { kind: 'looking' }
  | { kind: 'lookFailed'; error: string }
  | { kind: 'preview'; prepared: Prepared; store: RemoteStore }
  | { kind: 'publishing'; progress?: { done: number; total: number } }
  /** A publish started in another window is running: nothing to show of its progress. */
  | { kind: 'busy' }
  | { kind: 'done' }
  | { kind: 'publishFailed'; error: string };

/** Shows what publishing would change, publishes on request, and says how it went. */
export class PublishModal extends Modal {
  private plugin: CofferPlugin;
  private state: State = { kind: 'looking' };
  /** Counts the looks, so the answer to one that was given up on is ignored. */
  private looks = 0;
  private closed = false;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
    this.setTitle('Publish to the website');
    // The publish that kept this window busy has ended: look at the website as it is now.
    this.unsubscribe = this.plugin.onChange(() => {
      if (this.state.kind === 'busy' && !this.plugin.publishing) void this.look();
    });
    if (this.plugin.publishing) this.show({ kind: 'busy' });
    else void this.look();
  }

  onClose(): void {
    this.closed = true;
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private show(state: State): void {
    this.state = state;
    if (!this.closed) this.render();
  }

  private async look(): Promise<void> {
    const look = ++this.looks;
    this.show({ kind: 'looking' });
    try {
      const { prepared, store } = await this.plugin.prepareSite();
      if (look === this.looks) this.show({ kind: 'preview', prepared, store });
    } catch (e) {
      if (look === this.looks) this.show({ kind: 'lookFailed', error: errorText(e) });
    }
  }

  private async publish(prepared: Prepared, store: RemoteStore): Promise<void> {
    // A second click, or another window's, finds the screen already past the preview.
    if (this.state.kind !== 'preview') return;
    this.show({ kind: 'publishing' });
    try {
      await this.plugin.publishSite(prepared, store, (done, total) => this.show({ kind: 'publishing', progress: { done, total } }));
    } catch (e) {
      const error = errorText(e);
      if (this.closed) new Notice(`Publishing the website failed: ${error}`, 10_000);
      else this.show({ kind: 'publishFailed', error });
      return;
    }
    if (this.closed) new Notice('Website published.');
    else this.show({ kind: 'done' });
  }

  private render(): void {
    const c = this.contentEl;
    const s = this.state;
    c.empty();
    switch (s.kind) {
      case 'looking':
        c.createEl('p', { cls: 'coffer-progress', text: 'Looking at what would be published…' });
        break;
      case 'lookFailed':
        message(c, s.error);
        this.buttons(c, true);
        break;
      case 'preview':
        this.preview(c, s.prepared, s.store);
        break;
      case 'publishing':
      case 'busy':
        c.createEl('p', { cls: 'coffer-progress', text: s.kind === 'publishing' && s.progress ? `Uploading… ${s.progress.done.toLocaleString()} of ${s.progress.total.toLocaleString()}` : 'Uploading…' });
        c.createDiv({ cls: 'coffer-hint', text: 'You can close this window; publishing carries on.' });
        this.buttons(c);
        break;
      case 'done':
        c.createEl('p', { text: 'Published.' });
        this.websiteLink(c);
        this.buttons(c);
        break;
      case 'publishFailed':
        message(c, `Publishing did not finish: ${s.error}`);
        c.createEl('p', { text: 'What was uploaded stays; publish again to finish.' });
        this.buttons(c, true);
        break;
    }
  }

  /** What would change, the things worth a look, and the buttons to publish it or leave it. */
  private preview(c: HTMLElement, prepared: Prepared, store: RemoteStore): void {
    const lines = summaryLines(prepared);
    const changes = changesOf(prepared);
    for (const line of lines.slice(0, 2)) c.createEl('p', { text: line });
    if (prepared.planned.plan.first) message(c, 'These pages will be readable by anyone who has the address.', 'coffer-note');
    if (prepared.site.report.whole && changes.newPages.length) message(c, 'The whole vault is published: every note is a page unless its properties say publish: false, or it is kept off the website in settings.', 'coffer-note');

    // A new page's address, which the title does not always say; in the order of the titles.
    const addresses = new Map<string, string[]>();
    for (const { title, key } of changes.newPageKeys) addresses.set(title, [...(addresses.get(title) ?? []), key]);
    const newPages = changes.newPages.map((title) => ({ title, address: addresses.get(title)?.shift() }));
    this.list(c, 'New pages', newPages);
    for (const [heading, names] of [
      ['Changed pages', changes.changedPages],
      ['Removed pages', changes.removedPages],
      ['New files', changes.newFiles],
      ['Changed files', changes.changedFiles],
      ['Removed files', changes.removedFiles],
    ] as const) {
      this.list(c, heading, names.map((title) => ({ title })));
    }
    this.list(c, 'Worth a look', lines.filter((l) => /^(?:Left out|Not linked|Not found):/.test(l)).map((title) => ({ title })));

    if (changes.nothing) {
      this.websiteLink(c);
      this.buttons(c);
    } else {
      const row = buttonRow(c);
      button(row, 'Publish', () => this.publish(prepared, store), 'cta');
      button(row, 'Cancel', () => this.close());
    }
  }

  private list(c: HTMLElement, heading: string, items: { title: string; address?: string }[]): void {
    if (!items.length) return;
    c.createDiv({ cls: 'coffer-section-title', text: heading });
    const list = c.createDiv({ cls: 'coffer-files' });
    for (const { title, address } of items.slice(0, SHOWN)) {
      const text = list.createDiv({ cls: 'coffer-file' }).createSpan({ text: title });
      if (address) text.createSpan({ cls: 'coffer-publish-address', text: address });
    }
    if (items.length > SHOWN) list.createDiv({ cls: 'coffer-hint', text: `and ${(items.length - SHOWN).toLocaleString()} more` });
  }

  /** The link to the website, when settings say where it is. */
  private websiteLink(c: HTMLElement): void {
    const href = siteLink(this.plugin.settings.site);
    if (href) c.createEl('p').createEl('a', { text: 'Open the website', href, attr: { target: '_blank', rel: 'noopener' } });
  }

  /** Close, and before it Try again, which looks at the website afresh. */
  private buttons(c: HTMLElement, retry = false): void {
    const row = buttonRow(c);
    if (retry) button(row, 'Try again', () => this.look());
    button(row, 'Close', () => this.close());
  }
}
