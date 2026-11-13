// Small building blocks for the plugin's screens, laid out to work at phone width.
import { ButtonComponent, FuzzySuggestModal, Notice, TFile, type App, type TFolder } from 'obsidian';
import { generatePassphrase } from '../core/crypto.ts';
import { errorText } from '../core/text.ts';
import { lookup } from './obsidianfs.ts';

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
  const wrap = parent.createDiv({ cls: 'coffer-field' });
  const id = `coffer-${Math.random().toString(36).slice(2, 8)}`;
  wrap.createEl('label', { text: label, attr: { for: id } });
  const input = opts.multiline ? wrap.createEl('textarea', { attr: { id, rows: 4 } }) : wrap.createEl('input', { attr: { id, type: opts.password ? 'password' : 'text' } });
  input.setAttrs({ autocapitalize: 'off', autocorrect: 'off', autocomplete: opts.password ? 'new-password' : 'off', spellcheck: 'false' });
  input.placeholder = opts.placeholder ?? '';
  input.value = opts.value ?? '';
  input.addEventListener('input', () => onInput(input.value));
  if (opts.hint) wrap.createDiv({ cls: 'coffer-hint', text: opts.hint });
  return input;
}

export interface PassphraseChoice {
  passphrase: string;
  repeat: string;
  /** The generated passphrase on show, until either field is edited away from it. */
  suggested?: string;
}

/**
 * The fields for choosing a new passphrase, and a button that fills both with a generated one. That one is shown in
 * plain text to copy, because nobody could remember it. `value` is kept current and `opts.changed`, when given, told after
 * each change, so a screen that redraws can start from it again. `opts.error` is shown under the fields until they change.
 */
export function passphraseFields(
  parent: HTMLElement,
  value: PassphraseChoice,
  opts: { label?: string; hint?: string; error?: string; changed?: (value: PassphraseChoice) => void } = {},
): void {
  const first = field(parent, opts.label ?? 'Passphrase', { value: value.passphrase, password: true, hint: opts.hint }, (v) => {
    value.passphrase = v;
    edited();
  });
  const second = field(parent, 'Repeat it', { value: value.repeat, password: true }, (v) => {
    value.repeat = v;
    edited();
  });
  button(buttonRow(parent), 'Suggest a passphrase', () => {
    value.suggested = generatePassphrase();
    first.value = value.passphrase = value.suggested;
    second.value = value.repeat = value.suggested;
    edited();
  });
  const shown = parent.createDiv({ cls: 'coffer-suggestion' });
  const problem = parent.createDiv();
  message(problem, opts.error ?? '');
  function edited(): void {
    problem.empty();
    refresh();
  }
  function refresh(): void {
    if (value.suggested !== undefined && (value.passphrase !== value.suggested || value.repeat !== value.suggested)) value.suggested = undefined;
    shown.empty();
    if (value.suggested !== undefined) {
      const text = value.suggested;
      shown.createEl('code', { text });
      button(buttonRow(shown), 'Copy', async () => {
        try {
          await activeWindow.navigator.clipboard.writeText(text);
          new Notice('Passphrase copied.');
        } catch (e) {
          new Notice(`Could not copy it: ${errorText(e)}. Select it and copy it by hand.`, 8000);
        }
      });
      shown.createDiv({ cls: 'coffer-hint', text: 'Save it in your password manager now. Each of your other devices asks for it once, and a lost passphrase cannot be recovered.' });
    }
    opts.changed?.(value);
  }
  refresh();
}

/** A large tappable option with a title and one line of explanation. */
export function choice(parent: HTMLElement, title: string, hint: string, onClick: () => void): HTMLButtonElement {
  const b = parent.createEl('button', { cls: 'coffer-choice' });
  b.createDiv({ cls: 'coffer-choice-title', text: title });
  b.createDiv({ cls: 'coffer-choice-hint', text: hint });
  b.addEventListener('click', onClick);
  return b;
}

export function buttonRow(parent: HTMLElement): HTMLElement {
  return parent.createDiv({ cls: 'coffer-buttons' });
}

export function button(parent: HTMLElement, text: string, onClick: () => unknown, kind: 'cta' | 'warning' | 'plain' = 'plain'): ButtonComponent {
  const b = new ButtonComponent(parent).setButtonText(text).onClick(() => void onClick());
  if (kind === 'cta') b.setCta();
  if (kind === 'warning') b.setWarning();
  return b;
}

/** A link that opens a vault file in a new tab, after `before` (which closes the dialog); nothing when the file is gone. */
export function openLink(parent: HTMLElement, app: App, label: string, path: string, before: () => void): void {
  const file = lookup(app, path);
  if (!(file instanceof TFile)) return;
  const a = parent.createEl('a', { cls: 'coffer-open', text: label, href: '#' });
  a.addEventListener('click', (e) => {
    e.preventDefault();
    before();
    void app.workspace.getLeaf(true).openFile(file);
  });
}

export function message(parent: HTMLElement, text: string, cls = 'coffer-error'): void {
  if (text) parent.createDiv({ cls, text });
}

/** A coloured dot and one line, the same on every screen that shows sync status. Returns the line's text, to update in place. */
export function statusLine(parent: HTMLElement, text: string, tone: string): HTMLElement {
  const line = parent.createDiv({ cls: `coffer-status-line is-${tone}` });
  line.createSpan({ cls: 'coffer-dot' });
  return line.createSpan({ text });
}
