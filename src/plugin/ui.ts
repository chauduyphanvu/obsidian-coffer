// Small building blocks for the plugin's screens, laid out to work at phone width.
import { ButtonComponent, FuzzySuggestModal, TFile, type App, type TFolder } from 'obsidian';

/** Picks one of the vault's folders, leaving out those `skip` refuses (given as "path/"). */
export class FolderSuggest extends FuzzySuggestModal<TFolder> {
  private skip: (path: string) => boolean;
  private chosen: (folder: TFolder) => void;

  constructor(app: App, placeholder: string, skip: (path: string) => boolean, chosen: (folder: TFolder) => void) {
    super(app);
    this.skip = skip;
    this.chosen = chosen;
    this.setPlaceholder(placeholder);
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

export interface FieldOptions {
  value?: string;
  placeholder?: string;
  hint?: string;
  password?: boolean;
  multiline?: boolean;
}

/** A label above a full-width input. Keys and addresses must not be auto-corrected or capitalized. */
export function field(parent: HTMLElement, label: string, opts: FieldOptions, onInput: (value: string) => void): HTMLInputElement | HTMLTextAreaElement {
  const wrap = parent.createDiv({ cls: 'self-sync-field' });
  const id = `self-sync-${Math.random().toString(36).slice(2, 8)}`;
  wrap.createEl('label', { text: label, attr: { for: id } });
  const input = opts.multiline ? wrap.createEl('textarea', { attr: { id, rows: 4 } }) : wrap.createEl('input', { attr: { id, type: opts.password ? 'password' : 'text' } });
  input.setAttrs({ autocapitalize: 'off', autocorrect: 'off', autocomplete: opts.password ? 'new-password' : 'off', spellcheck: 'false' });
  input.placeholder = opts.placeholder ?? '';
  input.value = opts.value ?? '';
  input.addEventListener('input', () => onInput(input.value));
  if (opts.hint) wrap.createDiv({ cls: 'self-sync-hint', text: opts.hint });
  return input;
}

/** A large tappable option with a title and one line of explanation. */
export function choice(parent: HTMLElement, title: string, hint: string, onClick: () => void): HTMLButtonElement {
  const b = parent.createEl('button', { cls: 'self-sync-choice' });
  b.createDiv({ cls: 'self-sync-choice-title', text: title });
  b.createDiv({ cls: 'self-sync-choice-hint', text: hint });
  b.addEventListener('click', onClick);
  return b;
}

export function buttonRow(parent: HTMLElement): HTMLElement {
  return parent.createDiv({ cls: 'self-sync-buttons' });
}

export function button(parent: HTMLElement, text: string, onClick: () => unknown, kind: 'cta' | 'warning' | 'plain' = 'plain'): ButtonComponent {
  const b = new ButtonComponent(parent).setButtonText(text).onClick(() => void onClick());
  if (kind === 'cta') b.setCta();
  if (kind === 'warning') b.setWarning();
  return b;
}

/** A link that opens a vault file in a new tab, after `before` (which closes the dialog); nothing when the file is gone. */
export function openLink(parent: HTMLElement, app: App, label: string, path: string, before: () => void): void {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const a = parent.createEl('a', { cls: 'self-sync-open', text: label, href: '#' });
  a.addEventListener('click', (e) => {
    e.preventDefault();
    before();
    void app.workspace.getLeaf(true).openFile(file);
  });
}

export function message(parent: HTMLElement, text: string, cls = 'self-sync-error'): void {
  if (text) parent.createDiv({ cls, text });
}

/** A coloured dot and one line, the same on every screen that shows sync status. Returns the line's text, to update in place. */
export function statusLine(parent: HTMLElement, text: string, tone: string): HTMLElement {
  const line = parent.createDiv({ cls: `self-sync-status-line is-${tone}` });
  line.createSpan({ cls: 'self-sync-dot' });
  return line.createSpan({ text });
}
