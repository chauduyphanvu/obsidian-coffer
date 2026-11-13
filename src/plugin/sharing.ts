// Shared folders on screen: the list in settings, adding one (sharing a folder or joining with an invite link),
// copying an invite link, stopping, and choosing the vault or a shared folder for commands that work on one.
import { Modal, Notice, SuggestModal, TFile, TFolder, Vault, type App } from 'obsidian';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { MIN_PASSPHRASE, WrongPassphraseError } from '../core/crypto.ts';
import { Repo } from '../core/repo.ts';
import { errorText } from '../core/text.ts';
import { openRemote } from '../stores/open.ts';
import type CofferPlugin from './main.ts';
import { lookup, obsidianHttp } from './obsidianfs.ts';
import {
  PROVIDERS,
  besideVault,
  codeKind,
  decodeInvite,
  describeStorage,
  folderFor,
  folderProblem,
  linkProblem,
  normalFolder,
  passphraseProblem,
  remoteSpec,
  sameKeys,
  setupCodeFrom,
  shareSecretName,
  shareWith,
  storageProblem,
  type Provider,
  type Share,
  type Storage,
  type StorageForm,
} from './settings.ts';
import { mountHint, newShareId, rejoinNote } from './shares.ts';
import { IDS, formStorage, readOnlyBox, storageFields, tryStorage, type Keys } from './setup.ts';
import { summarize, type Problem } from './status.ts';
import { FolderSuggest, button, buttonRow, choice, field, message, passphraseFields } from './ui.ts';

/** Files in the vault folder `path`, at any depth; undefined when there is no such folder. */
function filesIn(app: App, path: string): number | undefined {
  const folder = path ? lookup(app, path) : null;
  if (!(folder instanceof TFolder)) return undefined;
  let n = 0;
  Vault.recurseChildren(folder, (f) => {
    if (f instanceof TFile) n++;
  });
  return n;
}

/** Fills `box` with the shared folders. Returns a function that redraws it, for when the status changes. */
export function renderShares(box: HTMLElement, plugin: CofferPlugin): () => void {
  box.addClass('coffer-shares');
  let shown: string | undefined;
  const draw = () => {
    const shares = plugin.settings.shares;
    // Redrawn only when something shown changes, not on every progress step, so a button is not replaced while tapped.
    const now = JSON.stringify(shares.map((s) => [s.id, s.folder, s.missing, s.readOnly, plugin.shareStatus(s), describeStorage(s)]));
    if (now === shown) return;
    shown = now;
    box.empty();
    if (!shares.length) {
      message(
        box,
        'Share a folder with another person, or keep one folder on different storage. Each shared folder has its own storage and passphrase, and nothing else in this vault can be seen through it.',
        'coffer-hint',
      );
    }
    for (const share of shares) shareRow(box, plugin, share);
    button(buttonRow(box), 'Add a shared folder', () => new ShareModal(plugin.app, plugin, 'start').open(), shares.length ? 'plain' : 'cta');
  };
  draw();
  return draw;
}

function shareRow(box: HTMLElement, plugin: CofferPlugin, share: Share): void {
  const { text, tone } = plugin.shareStatus(share);
  const el = box.createDiv({ cls: `coffer-share is-${tone}` });
  const body = el.createDiv({ cls: 'coffer-share-text' });
  body.createDiv({ cls: 'coffer-share-name', text: share.folder });
  const status = body.createDiv({ cls: 'coffer-share-status' });
  status.createSpan({ cls: 'coffer-share-dot' });
  status.createSpan({ text });
  body.createDiv({ cls: 'coffer-share-meta', text: share.readOnly ? `${describeStorage(share)} · Only receives` : describeStorage(share) });
  const only = body.createEl('label', { cls: 'coffer-check' });
  const check = only.createEl('input', { attr: { type: 'checkbox' } });
  check.checked = share.readOnly;
  check.addEventListener('change', () => {
    share.readOnly = check.checked;
    void plugin.saveSettings();
  });
  only.appendText(' Only receive changes');
  const actions = el.createDiv({ cls: 'coffer-share-actions' });
  if (share.missing) button(actions, 'Download again', () => downloadAgain(plugin, share), 'cta');
  else button(actions, 'Copy invite link', () => new InviteModal(plugin.app, plugin, share).open());
  button(actions, 'Stop sharing', () => new StopSharingModal(plugin.app, plugin, share).open());
}

/** Brings a missing shared folder back, saying how it went. */
export async function downloadAgain(plugin: CofferPlugin, share: Share): Promise<void> {
  try {
    const out = await plugin.downloadAgain(share);
    if (out.problem) new Notice(plugin.fragment(`“${share.folder}”: ${out.problem.title}`, out.problem.detail), 15_000);
    else new Notice(`“${share.folder}” is back: ${out.result ? summarize(out.result) : 'syncing'}.`);
  } catch (e) {
    new Notice(`Could not download “${share.folder}” again: ${errorText(e)}`, 10_000);
  }
}

/** Opens `then` for the vault, or first asks which, when the vault has shared folders that sync here. Only places `fits` count. */
export function pickTarget(plugin: CofferPlugin, title: string, then: (share?: Share) => void, fits: (share?: Share) => boolean = () => true): void {
  const targets = plugin.targets().filter(fits);
  if (targets.length === 1) then(targets[0]);
  else new TargetSuggest(plugin.app, title, targets.map((share) => ({ share })), then).open();
}

class TargetSuggest extends SuggestModal<{ share?: Share }> {
  private targets: { share?: Share }[];
  private chosen: (share?: Share) => void;

  constructor(app: App, title: string, targets: { share?: Share }[], chosen: (share?: Share) => void) {
    super(app);
    this.targets = targets;
    this.chosen = chosen;
    this.setPlaceholder(`${title}…`);
  }

  getSuggestions(query: string): { share?: Share }[] {
    const q = query.trim().toLowerCase();
    return this.targets.filter((t) => !q || (t.share ? t.share.folder : 'this vault').toLowerCase().includes(q));
  }

  renderSuggestion(t: { share?: Share }, el: HTMLElement): void {
    el.createDiv({ text: t.share ? `Shared folder “${t.share.folder}”` : 'This vault' });
    el.createDiv({ cls: 'coffer-hint', text: t.share ? describeStorage(t.share) : 'Everything except its shared folders' });
  }

  onChooseSuggestion(t: { share?: Share }): void {
    this.chosen(t.share);
  }
}

/** The invite link for one shared folder, with what to tell the person it goes to. */
class InviteModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private link = '';
  private error = '';
  /** The form for an invite that only reads is showing, with the read-only keys typed into it so far and the link made from them. */
  private reading = false;
  private keys = { access: '', secret: '', password: '', user: '' };
  private readLink = '';

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.setTitle(`Invite to “${this.share.folder}”`);
    this.render();
    // Made before the tap, so the copy happens in the tap itself, as phones require.
    this.plugin.inviteLink(this.share).then(
      (link) => (this.link = link),
      (e) => (this.error = `Could not make the link: ${errorText(e)}`),
    ).finally(() => this.render());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    if (this.reading) return this.readingForm(c);
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'Send this link to whoever should share this folder; they choose "Join with an invite link" in Coffer settings. ' +
        'They also need the passphrase. Tell it to them another way, not in the same message: the link is encrypted with it.',
    });
    inviteWarning(c, this.plugin, this.share);
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Close', () => this.close());
    button(row, this.link || this.error ? 'Copy invite link' : 'Preparing…', async () => {
      try {
        await activeWindow.navigator.clipboard.writeText(this.link);
        new Notice('Invite link copied. Send the passphrase separately.');
        this.close();
      } catch (e) {
        this.error = `Could not copy the link: ${errorText(e)}`;
        this.render();
      }
    }, 'cta').setDisabled(!this.link);
    choice(c, 'For someone who may only read', 'They receive this folder and can not change it. You make a key that can only read, and the link carries that one.', () => {
      this.error = '';
      this.reading = true;
      this.render();
    });
  }

  /** Read-only keys for the invite. The link is made on one tap and copied on the next, as phones only copy inside a tap. */
  private readingForm(c: HTMLElement): void {
    const share = this.share;
    const dav = share.storageType === 'webdav';
    const k = this.keys;
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'Make a key in your storage provider that can only read this folder, and enter it here. The link carries that key and turns on Only receive changes for whoever opens it. ' +
        'They need the passphrase too: tell it to them another way.',
    });
    c.createEl('p', {
      cls: 'coffer-hint',
      text: dav
        ? 'WebDAV passwords usually can not be limited to reading. Their Coffer will not write, but nothing stops another program that has the password.'
        : 'Cloudflare R2, Backblaze B2 and Amazon S3 can limit a key to reading. Without that limit the key could still change what is stored.',
    });
    let make!: ReturnType<typeof button>;
    const edited = (set: (v: string) => void) => (v: string) => {
      set(v);
      this.readLink = '';
      make.setButtonText('Make the link');
    };
    if (dav) {
      field(c, 'User name', { value: k.user }, edited((v) => (k.user = v)));
      field(c, 'Password', { value: k.password, password: true }, edited((v) => (k.password = v)));
    } else {
      field(c, 'Read-only access key ID', { value: k.access }, edited((v) => (k.access = v)));
      field(c, 'Read-only secret access key', { value: k.secret, password: true }, edited((v) => (k.secret = v)));
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => {
      this.reading = false;
      this.error = '';
      this.render();
    });
    make = button(row, this.readLink ? 'Copy read-only invite link' : 'Make the link', async () => {
      if (this.readLink) {
        try {
          await activeWindow.navigator.clipboard.writeText(this.readLink);
          new Notice('Invite link copied. Send the passphrase separately.');
          this.close();
        } catch (e) {
          this.error = `Could not copy the link: ${errorText(e)}`;
          this.render();
        }
        return;
      }
      const own = (n: string) => this.plugin.secret(n);
      const sameAsOwn = dav ? k.user.trim() === share.webdavUser.trim() && k.password === own(share.webdavPasswordSecret) : k.access.trim() === own(share.accessKeySecret);
      this.error = (dav ? !k.user.trim() || !k.password : !k.access.trim() || !k.secret.trim())
        ? 'Enter the read-only keys.'
        : sameAsOwn
          ? 'That is the key this device writes with. Make another one that can only read.'
          : '';
      if (!this.error) {
        try {
          this.readLink = await this.plugin.readOnlyInviteLink(share, { ...k, access: k.access.trim(), secret: k.secret.trim(), user: k.user.trim() });
        } catch (e) {
          this.error = `Could not make the link: ${errorText(e)}`;
        }
      }
      this.render();
    }, 'cta');
  }
}

/** Shown wherever an invite link is made for a shared folder that holds this vault's own storage keys. */
function inviteWarning(c: HTMLElement, plugin: CofferPlugin, share: Share): void {
  if (!sameKeys(share, plugin.settings, (n) => plugin.secret(n))) return;
  message(
    c,
    'This shared folder uses the same storage and keys as this vault, and the link carries those keys. Whoever gets it can not read the rest of your vault, ' +
      'which is encrypted with a different passphrase, but they could delete or overwrite it in storage. That is fine for your own devices. ' +
      'To share with another person, stop sharing this folder and share it again on storage whose keys reach only the shared folder.',
    'coffer-note',
  );
}

class StopSharingModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    const c = this.contentEl;
    const s = this.share;
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.setTitle(`Stop sharing “${s.folder}” on this device?`);
    if (!s.missing) c.createEl('p', { cls: 'coffer-intro', text: `The files stay in “${s.folder}” and from now on sync with the rest of this vault, to your own storage.` });
    const note = rejoinNote(s);
    if (note) c.createEl('p', { cls: 'coffer-intro', text: note });
    c.createEl('p', {
      cls: 'coffer-intro',
      text: 'Nothing is deleted from the shared storage, and the others who share this folder are not affected. To join again later, you need the invite link and the passphrase.',
    });
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    button(row, 'Stop sharing', async () => {
      this.close();
      try {
        await this.plugin.stopSharing(s);
        new Notice(`Stopped sharing “${s.folder}” on this device.`);
      } catch (e) {
        new Notice(`Could not stop sharing “${s.folder}”: ${errorText(e)}`, 10_000);
      }
    }, 'warning');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Asks before stopping a shared folder, from anywhere that offers it. */
export function confirmStopSharing(plugin: CofferPlugin, share: Share): void {
  new StopSharingModal(plugin.app, plugin, share).open();
}

type Step = 'start' | 'folder' | 'where' | 'provider' | 'storage' | 'passphrase' | 'join' | 'mount' | 'syncing' | 'done';

/**
 * Adding a shared folder, written for phones like the setup wizard: share one of this vault's folders (pick it,
 * pick where it is stored, choose its passphrase), or join one with an invite link and pick where it goes here.
 */
export class ShareModal extends Modal {
  private plugin: CofferPlugin;
  private step: Step;
  private joining: boolean;
  private folder = '';
  private sameStorage = false;
  private readOnly = false;
  private provider: Provider = 'r2';
  private form: StorageForm = { location: '', bucket: '', prefix: '', user: '', region: '', pathStyle: true };
  private keys: Keys = { access: '', secret: '', password: '' };
  private storage?: Storage;
  private exists = false;
  private passphrase = '';
  private repeat = '';
  /** The generated passphrase on show. */
  private suggested?: string;
  /** Redraws what the folder field says about the folder, when something it depends on changes. */
  private showFolder?: () => void;
  private code: string;
  private invite?: { storage: Partial<Storage>; secrets: [string, string][] };
  private id = newShareId();
  private share?: Share;
  private outcome?: { summary?: string; problem?: Problem };
  private error = '';
  private busy = false;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin, start: 'start' | 'join', code = '') {
    super(app);
    this.plugin = plugin;
    this.step = start;
    this.joining = start === 'join';
    this.code = code;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
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

  private fail(error: string): void {
    this.error = error;
    this.busy = false;
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    if (!this.plugin.configured()) return this.notSetUp();
    const steps: Record<Step, () => void> = {
      start: () => this.startStep(),
      folder: () => this.folderStep(),
      where: () => this.whereStep(),
      provider: () => this.providerStep(),
      storage: () => this.storageStep(),
      passphrase: () => this.passphraseStep(),
      join: () => this.joinStep(),
      mount: () => this.mountStep(),
      syncing: () => this.syncingStep(),
      done: () => this.doneStep(),
    };
    steps[this.step]();
  }

  private intro(text: string): void {
    this.contentEl.createEl('p', { cls: 'coffer-intro', text });
  }

  private notSetUp(): void {
    this.setTitle('Set up sync first');
    this.intro('A shared folder lives inside a synced vault. Set up sync for this vault, then add the shared folder in Settings → Coffer → Shared folders.');
    button(buttonRow(this.contentEl), 'Close', () => this.close(), 'cta');
  }

  private startStep(): void {
    this.setTitle('Add a shared folder');
    this.intro('A shared folder syncs with storage of its own, under a passphrase of its own. Nothing else in this vault can be seen through it.');
    choice(this.contentEl, 'Share a folder', 'Choose a folder of this vault and where to store it. You get an invite link for the others.', () => {
      this.joining = false;
      this.go('folder');
    });
    choice(this.contentEl, 'Join with an invite link', 'Someone shared a folder with you, or you shared one from another device.', () => {
      this.joining = true;
      this.go('join');
    });
  }

  /**
   * The folder field with a Choose button, then the error or what picking that folder would mean. Typing only redraws
   * that line: redrawing the field would close the keyboard on a phone.
   */
  private folderField(): void {
    const c = this.contentEl;
    const info = createDiv();
    const show = () => {
      info.empty();
      if (this.error) return message(info, this.error);
      const folder = normalFolder(this.folder);
      if (!folder) return;
      const problem = this.problem(folder);
      if (problem) return message(info, problem, 'coffer-hint');
      const n = filesIn(this.app, folder);
      const text =
        n === undefined
          ? `A new folder “${folder}” is made.`
          : !n
            ? `“${folder}” is empty.`
            : this.joining
              ? mountHint(folder, n, this.readOnly)
              : `Its ${n === 1 ? 'file is' : `${n.toLocaleString()} files are`} sent to the shared storage, where everyone who joins can see ${n === 1 ? 'it' : 'them'}. ` +
                'Your other devices keep their copy in this vault until you add the shared folder there too.';
      message(info, text, 'coffer-note');
    };
    const input = field(c, 'Folder', { value: this.folder, placeholder: 'Shared', hint: 'An existing folder, or a new one to make.' }, (v) => {
      this.folder = v;
      this.error = '';
      show();
    });
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void (this.step === 'folder' ? this.chooseFolder() : this.join());
    });
    button(buttonRow(c), 'Choose a folder…', () =>
      new FolderSuggest(this.app, 'Choose the folder', (path) => !!this.problem(path.slice(0, -1)), (f) => {
        this.folder = f.path;
        this.error = '';
        this.render();
      }).open(),
    );
    c.appendChild(info);
    this.showFolder = show;
    show();
  }

  private problem(folder: string): string {
    const plugin = this.plugin;
    return folderProblem(plugin.settings, folder, this.app.vault.configDir, `${this.app.vault.configDir}/plugins/${plugin.manifest.id}`);
  }

  private chooseFolder(): void {
    const folder = normalFolder(this.folder);
    const problem = folder ? this.problem(folder) : 'Choose a folder, or type the name of a new one.';
    if (problem) return this.fail(problem);
    this.folder = folder;
    this.go('where');
  }

  private folderStep(): void {
    this.setTitle('Which folder?');
    this.intro('Everything in it syncs with the shared storage. The rest of this vault stays as it is.');
    this.folderField();
    const row = buttonRow(this.contentEl);
    button(row, 'Back', () => this.go('start'));
    button(row, 'Next', () => this.chooseFolder(), 'cta');
  }

  private whereStep(): void {
    const vault = this.plugin.settings;
    this.setTitle('Where should it be stored?');
    choice(this.contentEl, 'Same storage as this vault', `${describeStorage(vault)}, in a separate location. Easiest for keeping a folder on your own devices.`, () => void this.useVaultStorage()).disabled = this.busy;
    choice(this.contentEl, 'Different storage', 'To share with another person, use storage whose keys reach only this folder.', () => {
      this.sameStorage = false;
      this.go('provider');
    }).disabled = this.busy;
    if (this.busy) this.contentEl.createEl('p', { cls: 'coffer-progress', text: 'Checking the storage…' });
    message(this.contentEl, this.error);
    button(buttonRow(this.contentEl), 'Back', () => this.go('folder')).setDisabled(this.busy);
  }

  private async useVaultStorage(): Promise<void> {
    const vault = this.plugin.settings;
    const secret = (n: string) => this.plugin.secret(n);
    this.sameStorage = true;
    this.storage = besideVault(vault, this.folder.split('/').pop()!, newShareId().slice(0, 6));
    this.keys = { access: secret(vault.accessKeySecret), secret: secret(vault.secretKeySecret), password: secret(vault.webdavPasswordSecret) };
    this.busy = true;
    this.error = '';
    this.render();
    try {
      this.exists = await tryStorage(this.storage, {}, this.keys);
      this.go('passphrase');
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  private providerStep(): void {
    this.setTitle('Where should the shared folder be stored?');
    for (const p of PROVIDERS) {
      choice(this.contentEl, p.name, p.hint, () => {
        this.provider = p.id;
        this.form.prefix ||= `shared-${folderFor(this.folder.split('/').pop()!)}`;
        this.go('storage');
      });
    }
    button(buttonRow(this.contentEl), 'Back', () => this.go('where'));
  }

  private storageStep(): void {
    const c = this.contentEl;
    this.setTitle(PROVIDERS.find((p) => p.id === this.provider)!.name);
    storageFields(c, this.provider, this.form, this.keys, true);
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('provider')).setDisabled(this.busy);
    button(row, this.busy ? 'Checking…' : 'Connect', () => this.connect(), 'cta').setDisabled(this.busy);
  }

  private async connect(): Promise<void> {
    let storage: Storage;
    try {
      storage = shareWith({ ...formStorage(this.provider, this.form, this.keys), id: this.id, folder: this.folder });
      const taken = storageProblem(this.plugin.settings, storage, this.id);
      if (taken) throw new Error(taken);
    } catch (e) {
      return this.fail(errorText(e));
    }
    this.busy = true;
    this.error = '';
    this.render();
    try {
      this.exists = await tryStorage(storage, {}, this.keys);
      this.storage = storage;
      this.go('passphrase');
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  private passphraseStep(): void {
    const c = this.contentEl;
    if (this.exists) {
      this.setTitle('Enter the passphrase');
      this.intro('This location already holds a shared folder. Enter the passphrase it was shared with.');
      field(c, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
      message(c, this.error);
    } else {
      this.setTitle('Choose a passphrase');
      this.intro(
        'It encrypts the shared files before they leave this device. Everyone who joins needs it, so use a different one from this vault\'s. ' +
          'If it is lost, the shared copy cannot be read, so keep it in a password manager.',
      );
      passphraseFields(c, { passphrase: this.passphrase, repeat: this.repeat, suggested: this.suggested }, { hint: `At least ${MIN_PASSPHRASE} characters.`, error: this.error, changed: (v) => void Object.assign(this, v) });
    }
    const row = buttonRow(c);
    button(row, 'Back', () => this.go(this.sameStorage ? 'where' : 'storage')).setDisabled(this.busy);
    button(row, this.busy ? 'Checking…' : 'Share this folder', () => this.create(), 'cta').setDisabled(this.busy);
  }

  private async create(): Promise<void> {
    const problem = passphraseProblem(this.passphrase, this.repeat, this.exists);
    if (problem) return this.fail(problem);
    const k = this.keys;
    const dav = this.storage!.storageType === 'webdav';
    const name = (base: string) => shareSecretName(base, this.app.vault.getName(), this.id);
    const share = shareWith({
      ...this.storage!,
      id: this.id,
      folder: this.folder,
      accessKeySecret: dav ? '' : name(IDS.access),
      secretKeySecret: dav ? '' : name(IDS.secret),
      webdavPasswordSecret: dav ? name(IDS.password) : '',
      passphraseSecret: name(IDS.passphrase),
    });
    const secrets: [string, string][] = dav ? [[name(IDS.password), k.password]] : [[name(IDS.access), k.access.trim()], [name(IDS.secret), k.secret.trim()]];
    secrets.push([name(IDS.passphrase), this.passphrase]);
    this.busy = true;
    this.error = '';
    this.render();
    if (this.exists) {
      // Joining storage that already holds a shared folder: a wrong passphrase is said here, not after adding it.
      try {
        const values = new Map(secrets);
        await Repo.open(openRemote(remoteSpec(share, (n) => values.get(n) ?? ''), obsidianHttp), this.passphrase, { kdfIterations: DEFAULT_CONFIG.kdfIterations, chunk: DEFAULT_CONFIG.chunk });
      } catch (e) {
        return this.fail(e instanceof WrongPassphraseError ? 'That is not the passphrase of the shared folder stored there.' : `Could not open the shared folder there: ${errorText(e)}`);
      }
    }
    await this.add(share, secrets);
  }

  private joinStep(): void {
    const c = this.contentEl;
    this.setTitle('Join a shared folder');
    this.intro('Paste the invite link you were sent, or open it on this device. Then enter the shared folder\'s passphrase, which should reach you separately.');
    const code = field(c, 'Invite link', { value: this.code, multiline: true, placeholder: 'obsidian://coffer?share=…' }, (v) => (this.code = v));
    code.addClass('coffer-code');
    button(buttonRow(c), 'Paste', async () => {
      try {
        this.code = await navigator.clipboard.readText();
        code.value = this.code;
      } catch {
        new Notice('Could not read the clipboard. Long-press the box and choose Paste.');
      }
    });
    field(c, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('start')).setDisabled(this.busy);
    button(row, this.busy ? 'Opening…' : 'Next', () => this.openInvite(), 'cta').setDisabled(this.busy);
  }

  private async openInvite(): Promise<void> {
    if (!this.code.trim() || !this.passphrase) return this.fail('Paste the invite link and enter the passphrase.');
    const code = setupCodeFrom(this.code);
    const kind = codeKind(code);
    if (kind !== 'share') {
      return this.fail(kind === 'vault' ? 'This is a setup link for a whole vault, not an invite to a shared folder. It goes in "Set up sync" on a new device.' : 'That is not an invite link. Copy it again.');
    }
    this.busy = true;
    this.error = '';
    this.render();
    let invite: Awaited<ReturnType<typeof decodeInvite>>;
    try {
      invite = await decodeInvite(code, this.passphrase, this.app.vault.getName(), this.id);
    } catch (e) {
      return this.fail(linkProblem(e, 'invite'));
    }
    const taken = storageProblem(this.plugin.settings, shareWith({ ...invite.storage, id: this.id, folder: invite.folder }), this.id);
    if (taken) return this.fail(taken);
    this.invite = invite;
    this.readOnly = this.readOnly || !!invite.storage.readOnly;
    this.folder ||= invite.folder;
    this.go('mount');
  }

  private mountStep(): void {
    this.setTitle('Where should it go in this vault?');
    this.intro('The shared files go in this folder. It does not need to have the same name as on the other devices.');
    this.folderField();
    readOnlyBox(
      this.contentEl,
      this.readOnly,
      (v) => {
        this.readOnly = v;
        this.showFolder?.();
      },
      !!this.invite?.storage.readOnly,
    );
    const row = buttonRow(this.contentEl);
    button(row, 'Back', () => this.go('join')).setDisabled(this.busy);
    button(row, this.busy ? 'Joining…' : 'Join', () => this.join(), 'cta').setDisabled(this.busy);
  }

  private async join(): Promise<void> {
    const folder = normalFolder(this.folder);
    const problem = folder ? this.problem(folder) : 'Choose a folder, or type the name of a new one.';
    if (problem) return this.fail(problem);
    this.folder = folder;
    await this.add(shareWith({ ...this.invite!.storage, id: this.id, folder, readOnly: this.readOnly }), this.invite!.secrets);
  }

  private async add(share: Share, secrets: [string, string][]): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await this.plugin.addShare(share, secrets);
    } catch (e) {
      return this.fail(errorText(e));
    }
    this.share = share;
    this.go('syncing');
    while (this.plugin.running) await sleep(300);
    const out = (await this.plugin.sync(true, false, true)).shares?.get(share.id);
    this.outcome = { summary: out?.result && summarize(out.result), problem: out?.problem };
    this.go('done');
  }

  private syncingStep(): void {
    this.setTitle('Syncing…');
    this.contentEl.createEl('p', { cls: 'coffer-progress', text: this.plugin.progress || 'Connecting to the storage…' });
    this.intro('The first sync of a large folder can take a while. You can close this window; syncing carries on.');
  }

  private doneStep(): void {
    const c = this.contentEl;
    const share = this.share!;
    const p = this.outcome?.problem;
    this.setTitle(p ? 'Added, not synced yet' : 'All set');
    if (p) message(c, `${p.title}. ${p.detail}`);
    else this.intro(`“${share.folder}” is shared${this.outcome?.summary ? `: ${this.outcome.summary}` : ''}.`);
    if (!this.joining) {
      this.intro('Next, send an invite link to whoever should share it, and tell them the passphrase another way. On your own devices, use the same link in Settings → Coffer → Shared folders.');
      inviteWarning(c, this.plugin, share);
      button(buttonRow(c), 'Copy invite link', () => new InviteModal(this.app, this.plugin, share).open());
    }
    button(buttonRow(c), 'Done', () => this.close(), 'cta');
  }
}
