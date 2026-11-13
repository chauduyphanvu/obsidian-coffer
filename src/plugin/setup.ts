// Guided setup: connect storage and choose a passphrase on the first device, or join with a setup link.
import { Modal, Notice, type App } from 'obsidian';
import { MIN_PASSPHRASE } from '../core/crypto.ts';
import type { SyncResult } from '../core/engine.ts';
import { Repo } from '../core/repo.ts';
import { errorText } from '../core/text.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import type CofferPlugin from './main.ts';
import { obsidianHttp } from './obsidianfs.ts';
import { PROVIDERS, codeKind, folderFor, linkProblem, passphraseProblem, remoteSpec, secretName, setupCodeFrom, storageSettings, type Provider, type Settings, type Storage, type StorageForm } from './settings.ts';
import { connectError, summarize } from './status.ts';
import { button, buttonRow, choice, field, message, passphraseFields } from './ui.ts';

type Step = 'start' | 'provider' | 'storage' | 'passphrase' | 'join' | 'syncing' | 'done';

/** What setup stores, the same secrets a setup code fills in; `secretName` makes each name this vault's own. */
export const IDS = { access: 'coffer-access-key', secret: 'coffer-secret-key', password: 'coffer-webdav-password', passphrase: 'coffer-passphrase' };

/** The keys typed into the storage form. Kept apart from settings until they are stored as secrets. */
export interface Keys {
  access: string;
  secret: string;
  password: string;
}

/** The fields `provider` needs, filling in `f` and `k` as they are typed, for the vault's storage or a shared folder's. */
export function storageFields(c: HTMLElement, provider: Provider, f: StorageForm, k: Keys, forShare = false): void {
  const set = (key: keyof StorageForm) => (v: string) => ((f as unknown as Record<string, string>)[key] = v);
  switch (provider) {
    case 'r2':
      field(c, 'Account ID', { value: f.location, placeholder: '0123456789abcdef0123456789abcdef', hint: "In Cloudflare's dashboard on the R2 page. The bucket's S3 API address works too." }, set('location'));
      break;
    case 'b2':
      field(c, 'Endpoint', { value: f.location, placeholder: 's3.us-west-004.backblazeb2.com', hint: "Shown on the bucket's page." }, set('location'));
      break;
    case 'aws':
      field(c, 'Region', { value: f.location, placeholder: 'us-east-1', hint: "Shown next to the bucket's name." }, set('location'));
      break;
    case 's3':
      field(c, 'Endpoint', { value: f.location, placeholder: 'https://s3.example.com' }, set('location'));
      field(c, 'Region', { value: f.region, placeholder: 'us-east-1', hint: 'Leave empty if your provider does not mention one.' }, set('region'));
      break;
    case 'webdav':
      field(c, 'Folder address', { value: f.location, placeholder: 'https://cloud.example.com/remote.php/dav/files/me/Obsidian', hint: `A folder that will hold ${forShare ? 'the shared folder' : 'this vault'}. It is created if missing.` }, set('location'));
      field(c, 'User name', { value: f.user }, set('user'));
      field(c, 'Password', { value: k.password, password: true, hint: 'For Nextcloud, create an app password in its security settings.' }, (v) => (k.password = v));
      break;
  }
  if (provider === 'webdav') return;
  field(c, 'Bucket', { value: f.bucket, placeholder: 'my-notes' }, set('bucket'));
  field(c, provider === 'b2' ? 'Key ID' : 'Access key ID', { value: k.access }, (v) => (k.access = v));
  field(
    c,
    provider === 'b2' ? 'Application key' : 'Secret access key',
    { value: k.secret, password: true, hint: `Use a key that can only reach ${forShare ? 'this folder in the bucket' : 'this bucket'}. It is kept in this device's secure storage.` },
    (v) => (k.secret = v),
  );
  field(c, 'Folder in bucket', { value: f.prefix, hint: forShare ? 'Filled in for you. Everyone who joins uses the same folder.' : 'Lets one bucket hold several vaults. Filled in for you.' }, set('prefix'));
  if (provider === 's3') {
    const row = c.createEl('label', { cls: 'coffer-check' });
    const box = row.createEl('input', { attr: { type: 'checkbox' } });
    box.checked = f.pathStyle;
    box.addEventListener('change', () => (f.pathStyle = box.checked));
    row.appendText(' Path-style addresses (MinIO and most self-hosted servers need this)');
  }
}

/** The storage settings the form describes, or an error saying what is missing. */
export function formStorage(provider: Provider, f: StorageForm, k: Keys): Partial<Settings> {
  const storage = storageSettings(provider, f);
  if (provider === 'webdav' ? !k.password : !k.access.trim() || !k.secret.trim()) throw new Error(provider === 'webdav' ? 'Enter the password.' : 'Enter the keys.');
  return storage;
}

/** The checkbox that makes a device only receive changes. `locked` keeps it on, as when an invite says so. */
export function readOnlyBox(c: HTMLElement, value: boolean, onChange: (v: boolean) => void, locked = false): void {
  const row = c.createEl('label', { cls: 'coffer-check' });
  const box = row.createEl('input', { attr: { type: 'checkbox' } });
  box.checked = value || locked;
  box.disabled = locked;
  box.addEventListener('change', () => onChange(box.checked));
  row.appendText(' Only receive changes');
  c.createDiv({ cls: 'coffer-hint', text: 'This device never writes to storage, so keys that may only read are enough. What you change here stays here.' });
}

/**
 * Checks that `storage` works with keys `k`; true when it already holds synced data. Fails in words the user can act on.
 * With `readOnly` it only reads, and storage that holds nothing yet is refused.
 */
export async function tryStorage(base: Storage, storage: Partial<Storage>, k: Keys, readOnly = false): Promise<boolean> {
  const values: Record<string, string> = { a: k.access.trim(), s: k.secret.trim(), p: k.password };
  const trial: Storage = { ...base, ...storage, accessKeySecret: 'a', secretKeySecret: 's', webdavPasswordSecret: 'p' };
  const store = openRemote(remoteSpec(trial, (n) => values[n] ?? ''), obsidianHttp);
  let exists: boolean;
  try {
    const report = await checkStore(store, readOnly);
    const bad = report.checks.find((x) => !x.ok);
    if (bad) throw new Error(bad.detail ?? bad.name);
    exists = await Repo.exists(store);
  } catch (e) {
    throw new Error(connectError(errorText(e), trial.storageType));
  }
  if (readOnly && !exists) throw new Error('This storage holds no synced vault yet. A device that only receives changes needs a vault set up from another device first.');
  return exists;
}

export class SetupModal extends Modal {
  private plugin: CofferPlugin;
  private step: Step;
  private provider: Provider = 'r2';
  private form: StorageForm;
  private keys = { access: '', secret: '', password: '' };
  private storage: Partial<Settings> = {};
  private exists = false;
  private readOnly = false;
  private passphrase = '';
  private repeat = '';
  private code: string;
  private joined = false;
  private error = '';
  private busy = false;
  private result?: SyncResult;
  /** The generated passphrase on show. */
  private suggested?: string;
  /** The setup link, made as soon as the last step shows, so that copying it happens in the tap: '' while it is being made. */
  private link?: string;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin, start: 'start' | 'new' | 'join', code = '') {
    super(app);
    this.plugin = plugin;
    this.step = start === 'new' ? 'provider' : start;
    this.code = code;
    this.form = { location: '', bucket: '', prefix: folderFor(app.vault.getName()), user: '', region: '', pathStyle: true };
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
    this.unsubscribe = this.plugin.onChange(() => {
      if (this.step === 'syncing') this.render();
    });
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private go(step: Step): void {
    this.step = step;
    this.error = '';
    this.busy = false;
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    const steps: Record<Step, () => void> = {
      start: () => this.startStep(),
      provider: () => this.providerStep(),
      storage: () => this.storageStep(),
      passphrase: () => this.passphraseStep(),
      join: () => this.joinStep(),
      syncing: () => this.syncingStep(),
      done: () => this.doneStep(),
    };
    steps[this.step]();
  }

  private intro(text: string): void {
    this.contentEl.createEl('p', { cls: 'coffer-intro', text });
  }

  private startStep(): void {
    this.setTitle('Set up sync');
    this.intro('Keep this vault in sync across your devices through storage you own. Files are encrypted on this device before they leave it.');
    choice(this.contentEl, 'This is my first device', 'Connect your storage and choose a passphrase.', () => this.go('provider'));
    choice(this.contentEl, 'I already sync another device', 'Paste the setup link from that device.', () => this.go('join'));
  }

  private providerStep(): void {
    this.setTitle('Where should the vault be stored?');
    for (const p of PROVIDERS) {
      choice(this.contentEl, p.name, p.hint, () => {
        this.provider = p.id;
        this.go('storage');
      });
    }
    button(buttonRow(this.contentEl), 'Back', () => this.go('start'));
  }

  private storageStep(): void {
    const c = this.contentEl;
    this.setTitle(PROVIDERS.find((p) => p.id === this.provider)!.name);
    storageFields(c, this.provider, this.form, this.keys);
    readOnlyBox(c, this.readOnly, (v) => (this.readOnly = v));
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('provider'));
    button(row, this.busy ? 'Checking…' : 'Connect', () => this.connect(), 'cta').setDisabled(this.busy);
  }

  private async connect(): Promise<void> {
    try {
      this.storage = formStorage(this.provider, this.form, this.keys);
    } catch (e) {
      this.error = errorText(e);
      this.render();
      return;
    }
    this.busy = true;
    this.error = '';
    this.render();
    try {
      this.exists = await tryStorage(this.plugin.settings, this.storage, this.keys, this.readOnly);
      this.go('passphrase');
    } catch (e) {
      this.busy = false;
      this.error = errorText(e);
      this.render();
    }
  }

  private passphraseStep(): void {
    const c = this.contentEl;
    if (this.exists) {
      this.setTitle('Enter the passphrase');
      this.intro('This storage already holds a synced vault. Enter the passphrase chosen on your first device.');
      field(c, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
      message(c, this.error);
    } else {
      this.setTitle('Choose a passphrase');
      this.intro(
        'It encrypts your files before they leave this device, and you type it once on each of your devices. ' +
          'If it is lost, the synced copy cannot be read, so keep it in a password manager.',
      );
      passphraseFields(c, { passphrase: this.passphrase, repeat: this.repeat, suggested: this.suggested }, { hint: `At least ${MIN_PASSPHRASE} characters.`, error: this.error, changed: (v) => void Object.assign(this, v) });
    }
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('storage'));
    button(row, 'Start syncing', () => this.begin(), 'cta');
  }

  private async begin(): Promise<void> {
    const problem = passphraseProblem(this.passphrase, this.repeat, this.exists);
    if (problem) {
      this.error = problem;
      this.render();
      return;
    }
    const secrets = this.app.secretStorage;
    const k = this.keys;
    const name = (base: string) => secretName(base, this.app.vault.getName());
    if (this.provider === 'webdav') secrets.setSecret(name(IDS.password), k.password);
    else {
      secrets.setSecret(name(IDS.access), k.access.trim());
      secrets.setSecret(name(IDS.secret), k.secret.trim());
    }
    secrets.setSecret(name(IDS.passphrase), this.passphrase);
    Object.assign(this.plugin.settings, this.storage, {
      accessKeySecret: this.provider === 'webdav' ? this.plugin.settings.accessKeySecret : name(IDS.access),
      secretKeySecret: this.provider === 'webdav' ? this.plugin.settings.secretKeySecret : name(IDS.secret),
      webdavPasswordSecret: this.provider === 'webdav' ? name(IDS.password) : this.plugin.settings.webdavPasswordSecret,
      passphraseSecret: name(IDS.passphrase),
      readOnly: this.readOnly,
    });
    await this.plugin.saveSettings();
    await this.firstSync('passphrase');
  }

  private joinStep(): void {
    const c = this.contentEl;
    this.setTitle('Join your synced vault');
    this.intro('On a device that already syncs, open Settings → Coffer and tap "Copy setup link". Paste it here, or open the link on this device.');
    const code = field(c, 'Setup link', { value: this.code, multiline: true, placeholder: 'obsidian://coffer?setup=…' }, (v) => (this.code = v));
    code.addClass('coffer-code');
    const paste = buttonRow(c);
    button(paste, 'Paste', async () => {
      try {
        this.code = await navigator.clipboard.readText();
        code.value = this.code;
      } catch {
        new Notice('Could not read the clipboard. Long-press the box and choose Paste.');
      }
    });
    field(c, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
    readOnlyBox(c, this.readOnly, (v) => (this.readOnly = v));
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('start'));
    button(row, this.busy ? 'Connecting…' : 'Connect', () => this.joinWith(), 'cta').setDisabled(this.busy);
  }

  private async joinWith(): Promise<void> {
    if (!this.code.trim() || !this.passphrase) {
      this.error = 'Paste the setup link and enter the passphrase.';
      this.render();
      return;
    }
    if (codeKind(setupCodeFrom(this.code)) === 'share') {
      this.error = 'This is an invite link to a shared folder, not a setup link. Set up sync here first, then add it in Settings → Coffer → Shared folders.';
      this.render();
      return;
    }
    this.busy = true;
    this.render();
    try {
      await this.plugin.importSetupCode(setupCodeFrom(this.code), this.passphrase, this.readOnly);
    } catch (e) {
      this.busy = false;
      this.error = linkProblem(e, 'setup');
      this.render();
      return;
    }
    this.joined = true;
    await this.firstSync('join');
  }

  private async firstSync(back: Step): Promise<void> {
    this.go('syncing');
    while (this.plugin.running) await new Promise((r) => window.setTimeout(r, 300));
    const out = await this.plugin.sync(true, false, true);
    if (out.problem) {
      this.step = back;
      this.busy = false;
      this.error = `${out.problem.title}. ${out.problem.detail}`;
      this.render();
      return;
    }
    this.result = out.result;
    this.go('done');
  }

  private syncingStep(): void {
    this.setTitle('Syncing…');
    this.contentEl.createEl('p', { cls: 'coffer-progress', text: this.plugin.progress || 'Connecting to the storage…' });
    this.intro('The first sync of a large vault can take a while. You can close this window; syncing carries on.');
  }

  private doneStep(): void {
    const c = this.contentEl;
    this.setTitle('All set');
    this.intro(this.result ? `This vault is in sync: ${summarize(this.result)}.` : 'This vault is in sync.');
    if (!this.joined) {
      this.intro('Next, add your other devices: install Coffer there, choose "I already sync another device", and paste this link. It is encrypted with your passphrase.');
      if (this.link === undefined) {
        this.link = '';
        this.plugin.setupLink().then(
          (link) => (this.link = link),
          (e) => (this.error = `Could not make the link: ${errorText(e)}`),
        ).finally(() => {
          if (this.step === 'done') this.render();
        });
      }
      message(c, this.error);
      button(buttonRow(c), this.link || this.error ? 'Copy setup link' : 'Preparing…', async () => {
        try {
          await navigator.clipboard.writeText(this.link!);
          new Notice('Setup link copied.');
        } catch (e) {
          new Notice(`Could not copy the setup link: ${errorText(e)}`, 8000);
        }
      }).setDisabled(!this.link);
    }
    button(buttonRow(c), 'Done', () => this.close(), 'cta');
  }
}
