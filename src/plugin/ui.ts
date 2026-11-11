// Small building blocks for the plugin's screens, laid out to work at phone width.
import { ButtonComponent } from 'obsidian';

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

export function message(parent: HTMLElement, text: string, cls = 'self-sync-error'): void {
  if (text) parent.createDiv({ cls, text });
}

/** A coloured dot and one line, the same on every screen that shows sync status. */
export function statusLine(parent: HTMLElement, text: string, tone: string): void {
  const line = parent.createDiv({ cls: `self-sync-status-line is-${tone}` });
  line.createSpan({ cls: 'self-sync-dot' });
  line.createSpan({ text });
}
