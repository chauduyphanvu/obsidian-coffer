import { Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, SuggestModal, TFile, debounce, type App } from 'obsidian';
import { DEFAULT_CONFIG, resolveConfig } from '../core/config.ts';
import { openWithPassphrase, sealWithPassphrase } from '../core/crypto.ts';
import { SafetyError, SyncEngine, type SyncResult, type Version } from '../core/engine.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import { ObsidianFS, PluginState, obsidianHttp } from './obsidianfs.ts';

interface Settings {
  storageType: 's3' | 'webdav';
  webdavUrl: string;
  webdavUser: string;
  webdavPasswordSecret: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  /** Names of entries in Obsidian's secret storage; the values never touch the vault. */
  accessKeySecret: string;
  secretKeySecret: string;
  passphraseSecret: string;
  deviceName: string;
  syncOnStart: boolean;
  intervalMinutes: number;
  changeDelaySeconds: number;
  /** How often to ask the storage whether another device has synced. 0 turns it off. */
  pollSeconds: number;
  /** Expired versions are removed this often. 0 leaves it to the manual command. */
  autoCleanDays: number;
  lastCleanup: number;
  syncConfigDir: boolean;
  exclude: string;
  conflictStrategy: 'merge' | 'copy';
  retentionDays: number;
  maxFileSizeMB: number;
  concurrency: number;
  compression: boolean;
}

const DEFAULTS: Settings = {
  storageType: 's3',
  webdavUrl: '',
  webdavUser: '',
  webdavPasswordSecret: '',
  endpoint: '',
  region: 'auto',
  bucket: '',
  prefix: 'vault',
  pathStyle: true,
  accessKeySecret: '',
  secretKeySecret: '',
  passphraseSecret: '',
  deviceName: '',
  syncOnStart: true,
  intervalMinutes: 5,
  changeDelaySeconds: 5,
  pollSeconds: 30,
  autoCleanDays: 7,
  lastCleanup: 0,
  syncConfigDir: true,
  exclude: '',
  conflictStrategy: DEFAULT_CONFIG.conflictStrategy,
  retentionDays: DEFAULT_CONFIG.retentionDays,
  maxFileSizeMB: Platform.isMobile ? 200 : DEFAULT_CONFIG.maxFileSizeMB,
  concurrency: DEFAULT_CONFIG.concurrency,
  compression: DEFAULT_CONFIG.compression,
};

const summarize = (r: SyncResult) => {
  const parts = [
    r.pushed && `${r.pushed} sent`,
    r.pulled && `${r.pulled} received`,
    r.deletedLocal + r.deletedRemote && `${r.deletedLocal + r.deletedRemote} deleted`,
    r.merged && `${r.merged} merged`,
    r.conflictCopies.length && `${r.conflictCopies.length} conflict copies`,
    r.errors.length && `${r.errors.length} failed`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'up to date';
};

export default class SelfSyncPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  private engine?: SyncEngine;
  private fs?: ObsidianFS;
  private running = false;
  private changedWhileRunning = false;
  private statusEl?: HTMLElement;
  private lastError = '';
  private timer?: number;
  private pollTimer?: number;
  private dirty = false;
  private progressNotice?: Notice;
  private schedule = debounce(() => void this.sync(), 10_000, true);

  async onload(): Promise<void> {
    this.settings = { ...DEFAULTS, ...((await this.loadData()) as Partial<Settings> | null) };
    if (!this.settings.deviceName) {
      this.settings.deviceName = `${Platform.isMobile ? 'mobile' : 'desktop'}-${Math.random().toString(16).slice(2, 6)}`;
      await this.saveData(this.settings);
    }
    this.addSettingTab(new SettingsTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.onClickEvent(() => {
      if (this.lastError) new Notice(this.lastError, 10_000);
      else void this.sync(true);
    });
    this.setStatus(this.configured() ? 'Sync: idle' : 'Sync: not set up');
    this.addRibbonIcon('refresh-cw', 'Sync now', () => void this.sync(true));

    this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true) });
    this.addCommand({ id: 'force-sync', name: 'Sync now, allowing large deletions', callback: () => void this.sync(true, true) });
    this.addCommand({ id: 'check-storage', name: 'Check storage connection', callback: () => void this.checkStorage() });
    this.addCommand({ id: 'clean-up', name: 'Delete expired versions from storage', callback: () => void this.cleanUp() });
    this.addCommand({
      id: 'history',
      name: 'Show version history of the current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.configured()) return false;
        if (!checking) void this.showHistory(file.path);
        return true;
      },
    });

    this.app.workspace.onLayoutReady(() => {
      const changed = () => {
        this.dirty = true;
        if (this.running) this.changedWhileRunning = true;
        else this.schedule();
      };
      for (const name of ['create', 'modify', 'delete', 'rename'] as const) {
        this.registerEvent(this.app.vault.on(name as 'create', changed));
      }
      // Phones suspend the app in the background; catch up the moment it is opened again.
      // Going to the background: send pending edits now, before the system suspends the app.
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible' || this.dirty) {
          this.schedule.cancel();
          void this.sync();
        }
      });
      this.applySchedule();
      if (this.settings.syncOnStart) void this.sync();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engine = undefined;
    this.applySchedule();
    this.setStatus(this.configured() ? 'Sync: idle' : 'Sync: not set up');
  }

  private applySchedule(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer);
    this.timer = this.pollTimer = undefined;
    this.schedule.cancel();
    this.schedule = debounce(() => void this.sync(), Math.max(2, this.settings.changeDelaySeconds) * 1000, true);
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(() => void this.sync(), this.settings.intervalMinutes * 60_000);
      this.registerInterval(this.timer);
    }
    if (this.settings.pollSeconds > 0) {
      this.pollTimer = window.setInterval(() => void this.poll(), Math.max(5, this.settings.pollSeconds) * 1000);
      this.registerInterval(this.pollTimer);
    }
  }

  /** Storage cannot notify devices, so ask it: one tiny request, and a real sync only when something is there. */
  private async poll(): Promise<void> {
    if (this.running || document.visibilityState !== 'visible' || !this.configured()) return;
    try {
      if (await this.getEngine().remoteChanged()) await this.sync();
    } catch {
      // Offline or unreachable; the next full sync reports it.
    }
  }

  private secret(name: string): string {
    return (name && this.app.secretStorage.getSecret(name)) || '';
  }

  configured(): boolean {
    const s = this.settings;
    const storage =
      s.storageType === 'webdav'
        ? s.webdavUrl && s.webdavUser && this.secret(s.webdavPasswordSecret)
        : s.endpoint && s.bucket && this.secret(s.accessKeySecret) && this.secret(s.secretKeySecret);
    return !!(storage && this.secret(s.passphraseSecret));
  }

  private store() {
    const s = this.settings;
    if (s.storageType === 'webdav') {
      return openRemote({ type: 'webdav', url: s.webdavUrl.trim(), username: s.webdavUser, password: this.secret(s.webdavPasswordSecret) }, obsidianHttp);
    }
    return openRemote(
      {
        type: 's3',
        endpoint: s.endpoint.trim(),
        region: s.region.trim() || 'auto',
        bucket: s.bucket.trim(),
        prefix: s.prefix,
        pathStyle: s.pathStyle,
        accessKey: this.secret(s.accessKeySecret),
        secretKey: this.secret(s.secretKeySecret),
      },
      obsidianHttp,
    );
  }

  getEngine(): SyncEngine {
    if (!this.engine) {
      const s = this.settings;
      const dir = this.app.vault.configDir;
      const own = `${dir}/plugins/${this.manifest.id}`;
      this.fs = new ObsidianFS(this.app, s.syncConfigDir);
      this.engine = new SyncEngine({
        fs: this.fs,
        store: this.store(),
        stateStore: new PluginState(this.app, `${own}/state.json`),
        passphrase: this.secret(s.passphraseSecret),
        config: resolveConfig({
          deviceName: s.deviceName,
          exclude: [
            ...DEFAULT_CONFIG.exclude.map((p) => p.replace(/^\.obsidian\//, `${dir}/`)),
            // Device-specific. The plugin's code itself does sync, so an update reaches every device.
            `${own}/state.json`,
            `${own}/data.json`,
            ...s.exclude.split('\n'),
          ],
          conflictStrategy: s.conflictStrategy,
          retentionDays: s.retentionDays,
          maxFileSizeMB: s.maxFileSizeMB,
          concurrency: s.concurrency,
          compression: s.compression,
        }),
        onProgress: (p) => this.showProgress(`${p.phase === 'upload' ? 'Sending' : 'Receiving'} ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, p.total),
      });
    }
    return this.engine;
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
  }

  private showProgress(text: string, total: number): void {
    this.setStatus(text);
    // Phones have no status bar; a long first sync should not look like nothing is happening.
    if (!Platform.isMobile || total < 50) return;
    if (this.progressNotice) this.progressNotice.setMessage(`Sync: ${text}`);
    else this.progressNotice = new Notice(`Sync: ${text}`, 0);
  }

  async sync(manual = false, force = false): Promise<void> {
    if (!this.configured()) {
      if (manual) new Notice('Self Sync is not set up yet. Open its settings.');
      return;
    }
    if (this.running) {
      this.changedWhileRunning = true;
      return;
    }
    this.running = true;
    this.changedWhileRunning = false;
    this.dirty = false;
    this.setStatus('Syncing…');
    try {
      const r = await this.getEngine().sync({ force });
      if (r.pulled || r.deletedLocal) this.fs?.forgetConfigListing();
      this.lastError = r.errors.length ? r.errors.map((e) => `${e.path}: ${e.message}`).join('\n') : '';
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.setStatus(r.errors.length ? `Sync: ${r.errors.length} files failed` : `Synced ${time}`);
      if (manual || r.conflictCopies.length) new Notice(`Sync: ${summarize(r)}`);
      for (const copy of r.conflictCopies) new Notice(`Both versions kept: ${copy}`, 15_000);
      const s = this.settings;
      if (!r.errors.length && s.autoCleanDays > 0 && Date.now() - s.lastCleanup > s.autoCleanDays * 86_400_000) {
        await this.getEngine().gc();
        s.lastCleanup = Date.now();
        await this.saveData(s);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // An automatic sync that keeps failing the same way (offline, say) should not nag.
      if (e instanceof SafetyError) {
        new Notice(
          `Sync paused: it would delete ${e.localDeletes} files here and ${e.remoteDeletes} from storage. ` +
            'If that is what you want, run the command "Sync now, allowing large deletions".',
          0,
        );
      } else if (manual || message !== this.lastError) new Notice(`Sync failed: ${message}`, 10_000);
      this.lastError = message;
      this.setStatus(e instanceof SafetyError ? 'Sync: needs confirmation' : 'Sync failed');
      if (!(e instanceof SafetyError)) this.engine = undefined;
    } finally {
      this.running = false;
      this.progressNotice?.hide();
      this.progressNotice = undefined;
      if (this.changedWhileRunning) this.schedule();
    }
  }

  /** Storage settings and keys, encrypted under the vault passphrase, for pasting into another device. */
  async exportSetupCode(): Promise<string> {
    const s = this.settings;
    const payload = {
      storageType: s.storageType, endpoint: s.endpoint, region: s.region, bucket: s.bucket, prefix: s.prefix, pathStyle: s.pathStyle,
      webdavUrl: s.webdavUrl, webdavUser: s.webdavUser,
      accessKey: this.secret(s.accessKeySecret), secretKey: this.secret(s.secretKeySecret), webdavPassword: this.secret(s.webdavPasswordSecret),
    };
    return `selfsync1.${await sealWithPassphrase(JSON.stringify(payload), this.secret(s.passphraseSecret))}`;
  }

  async importSetupCode(code: string, passphrase: string): Promise<void> {
    const body = code.trim().replace(/^selfsync1\./, '');
    const p = JSON.parse(await openWithPassphrase(body, passphrase)) as Record<string, string | boolean>;
    const s = this.settings;
    const keep = (id: string, value: string | boolean) => {
      if (value) this.app.secretStorage.setSecret(id, String(value));
      return value ? id : '';
    };
    Object.assign(s, {
      storageType: p.storageType === 'webdav' ? 'webdav' : 's3',
      endpoint: p.endpoint, region: p.region, bucket: p.bucket, prefix: p.prefix, pathStyle: p.pathStyle,
      webdavUrl: p.webdavUrl, webdavUser: p.webdavUser,
      accessKeySecret: keep('self-sync-access-key', p.accessKey),
      secretKeySecret: keep('self-sync-secret-key', p.secretKey),
      webdavPasswordSecret: keep('self-sync-webdav-password', p.webdavPassword),
      passphraseSecret: keep('self-sync-passphrase', passphrase),
    });
    await this.saveSettings();
  }

  async changePassphrase(next: string): Promise<void> {
    await this.getEngine().changePassphrase(next);
    const id = this.settings.passphraseSecret;
    this.app.secretStorage.setSecret(id, next);
    this.engine = undefined;
  }

  async checkStorage(): Promise<void> {
    const s = this.settings;
    if (s.storageType === 'webdav' ? !s.webdavUrl : !s.endpoint || !s.bucket) {
      new Notice('Fill in the storage address first.');
      return;
    }
    const report = await checkStore(this.store());
    const bad = report.checks.filter((c) => !c.ok);
    new Notice(
      report.ok ? 'Storage works: all checks passed.' : `Storage problem:\n${bad.map((c) => `${c.name}: ${c.detail}`).join('\n')}`,
      report.ok ? 5000 : 20_000,
    );
  }

  private async cleanUp(): Promise<void> {
    if (!this.configured() || this.running) return;
    this.running = true;
    try {
      const r = await this.getEngine().gc();
      new Notice(`Removed ${r.packsDeleted} storage objects (${(r.bytesFreed / 1e6).toFixed(1)} MB).`);
    } catch (e) {
      new Notice(`Clean-up failed: ${e instanceof Error ? e.message : e}`, 10_000);
    } finally {
      this.running = false;
    }
  }

  private async showHistory(path: string): Promise<void> {
    try {
      const notice = new Notice('Loading version history…', 0);
      const versions = await this.getEngine().history(path.normalize('NFC'));
      notice.hide();
      if (!versions.length) new Notice('No stored versions of this file.');
      else new HistoryModal(this.app, this, path, versions).open();
    } catch (e) {
      new Notice(`Could not load history: ${e instanceof Error ? e.message : e}`, 10_000);
    }
  }

  async restore(path: string, version: Version): Promise<void> {
    if (!version.entry) return;
    const data = await this.getEngine().readVersion(version.entry);
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.vault.modifyBinary(file, buffer);
    else await this.app.vault.createBinary(path, buffer);
    new Notice(`Restored the version from ${new Date(version.time).toLocaleString()}.`);
  }
}

class HistoryModal extends SuggestModal<Version> {
  private plugin: SelfSyncPlugin;
  private path: string;
  private versions: Version[];

  constructor(app: App, plugin: SelfSyncPlugin, path: string, versions: Version[]) {
    super(app);
    this.plugin = plugin;
    this.path = path;
    this.versions = versions;
    this.setPlaceholder('Pick a version to restore (the current one stays in history)');
  }

  getSuggestions(query: string): Version[] {
    const q = query.toLowerCase();
    return this.versions.filter((v) => `${new Date(v.time).toLocaleString()} ${v.device}`.toLowerCase().includes(q));
  }

  renderSuggestion(v: Version, el: HTMLElement): void {
    el.createDiv({ text: new Date(v.time).toLocaleString() });
    el.createEl('small', { text: v.entry ? `${v.device} · ${v.entry.size.toLocaleString()} bytes` : `${v.device} · deleted` });
  }

  onChooseSuggestion(v: Version): void {
    if (!v.entry) new Notice('That entry records a deletion; pick the version before it.');
    else void this.plugin.restore(this.path, v);
  }
}

class SettingsTab extends PluginSettingTab {
  private plugin: SelfSyncPlugin;

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();
    containerEl.empty();

    const text = (name: string, desc: string, key: 'endpoint' | 'region' | 'bucket' | 'prefix' | 'deviceName' | 'webdavUrl' | 'webdavUser', placeholder = '') =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(placeholder).setValue(s[key]).onChange((v) => {
          s[key] = v.trim();
          save();
        }),
      );
    const secret = (name: string, desc: string, key: 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret') =>
      new Setting(containerEl).setName(name).setDesc(desc).addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s[key]).onChange((v) => {
          s[key] = v ?? '';
          save();
        }),
      );
    const number = (name: string, desc: string, key: 'intervalMinutes' | 'changeDelaySeconds' | 'pollSeconds' | 'autoCleanDays' | 'retentionDays' | 'maxFileSizeMB' | 'concurrency', min: number) =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) => {
        t.inputEl.type = 'number';
        t.setValue(String(s[key])).onChange((v) => {
          const n = Number(v);
          if (!Number.isFinite(n) || n < min) return;
          s[key] = n;
          save();
        });
      });
    const toggle = (name: string, desc: string, key: 'pathStyle' | 'syncOnStart' | 'syncConfigDir' | 'compression') =>
      new Setting(containerEl).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange((v) => {
          s[key] = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName('Set up from another device')
      .setDesc('On a device that already syncs, copy its setup code. Here, paste it and type the passphrase: storage address and keys are filled in for you.')
      .addButton((b) =>
        b.setButtonText('Copy setup code').setDisabled(!this.plugin.configured()).onClick(async () => {
          try {
            // Settings can be their own window, and only the focused window may write to the clipboard.
            await activeWindow.navigator.clipboard.writeText(await this.plugin.exportSetupCode());
            new Notice('Setup code copied. It is encrypted with your passphrase.');
          } catch (e) {
            new Notice(`Could not copy the setup code: ${e instanceof Error ? e.message : e}`, 8000);
          }
        }),
      )
      .addButton((b) => b.setButtonText('Use a setup code').setCta().onClick(() => new SetupCodeModal(this.app, this.plugin, () => this.display()).open()));

    new Setting(containerEl).setName('Storage').setHeading();
    new Setting(containerEl)
      .setName('Storage type')
      .addDropdown((d) =>
        d
          .addOption('s3', 'S3-compatible bucket (R2, B2, AWS, MinIO)')
          .addOption('webdav', 'WebDAV (Nextcloud, NAS)')
          .setValue(s.storageType)
          .onChange((v) => {
            s.storageType = v as Settings['storageType'];
            save();
            this.display();
          }),
      );
    if (s.storageType === 'webdav') {
      text('Folder address', 'A folder on the server that will hold this vault. It is created if missing.', 'webdavUrl', 'https://cloud.example.com/remote.php/dav/files/me/obsidian');
      text('User name', '', 'webdavUser');
      secret('Password', 'Stored in Obsidian\'s secret storage on this device, not in the vault.', 'webdavPasswordSecret');
    } else {
      text('Endpoint', 'The S3 API address of your storage provider.', 'endpoint', 'https://<account>.r2.cloudflarestorage.com');
      text('Region', 'Use "auto" for Cloudflare R2.', 'region', 'auto');
      text('Bucket', 'Must already exist.', 'bucket');
      text('Folder in bucket', 'Lets one bucket hold several vaults. Every device syncing this vault must use the same folder.', 'prefix');
      secret('Access key ID', 'Stored in Obsidian\'s secret storage on this device, not in the vault.', 'accessKeySecret');
      secret('Secret access key', 'Stored in Obsidian\'s secret storage on this device, not in the vault.', 'secretKeySecret');
      toggle('Path-style addresses', 'On for R2, Backblaze B2, MinIO and most others. Off for AWS S3 buckets that require bucket-name hostnames.', 'pathStyle');
    }
    new Setting(containerEl)
      .setName('Check connection')
      .setDesc('Writes, reads and deletes a small test object, and verifies the storage can prevent two devices from overwriting each other.')
      .addButton((b) => b.setButtonText('Check').onClick(() => void this.plugin.checkStorage()));

    new Setting(containerEl).setName('Encryption').setHeading();
    secret(
      'Passphrase',
      'Encrypts file contents and names before they leave this device. Use the same passphrase on every device. If it is lost, the remote copy cannot be read.',
      'passphraseSecret',
    );
    new Setting(containerEl)
      .setName('Change passphrase')
      .setDesc('Nothing is re-uploaded. Other devices need the new passphrase the next time they start.')
      .addButton((b) => b.setButtonText('Change').setDisabled(!this.plugin.configured()).onClick(() => new PassphraseModal(this.app, this.plugin).open()));

    new Setting(containerEl).setName('When to sync').setHeading();
    toggle('Sync when Obsidian starts', '', 'syncOnStart');
    number('Sync every (minutes)', '0 turns the timer off.', 'intervalMinutes', 0);
    number('Sync after changes (seconds)', 'How long to wait after the last edit before syncing.', 'changeDelaySeconds', 2);
    number('Check for changes from other devices every (seconds)', 'One very small request each time, only while Obsidian is on screen. 0 turns it off.', 'pollSeconds', 0);

    new Setting(containerEl).setName('What to sync').setHeading();
    toggle('Sync settings, themes and plugins', `Includes the ${this.app.vault.configDir} folder, except workspace layout.`, 'syncConfigDir');
    new Setting(containerEl)
      .setName('Excluded files')
      .setDesc('One pattern per line. * matches within a folder, ** across folders, a trailing / a whole folder.')
      .addTextArea((t) =>
        t.setPlaceholder('Private/\n*.tmp').setValue(s.exclude).onChange((v) => {
          s.exclude = v;
          save();
        }),
      );
    number('Largest file to sync (MB)', '0 means no limit. Large files are held in memory while syncing.', 'maxFileSizeMB', 0);

    new Setting(containerEl).setName('Conflicts and history').setHeading();
    new Setting(containerEl)
      .setName('When a note was edited on two devices')
      .setDesc('Merging combines edits to different parts of a note; overlapping edits and non-text files always keep both versions.')
      .addDropdown((d) =>
        d
          .addOption('merge', 'Merge, keep both if edits overlap')
          .addOption('copy', 'Always keep both versions')
          .setValue(s.conflictStrategy)
          .onChange((v) => {
            s.conflictStrategy = v as Settings['conflictStrategy'];
            save();
          }),
      );
    number('Keep old versions for (days)', 'Every synced version of a file can be restored for this long.', 'retentionDays', 1);
    number('Remove expired versions every (days)', '0 leaves it to the "Delete expired versions from storage" command.', 'autoCleanDays', 0);

    new Setting(containerEl).setName('Advanced').setHeading();
    text('Device name', 'Shown in version history and conflict file names.', 'deviceName');
    number('Parallel transfers', '', 'concurrency', 1);
    toggle('Compress text before encrypting', '', 'compression');
  }
}

class SetupCodeModal extends Modal {
  private plugin: SelfSyncPlugin;
  private done: () => void;

  constructor(app: App, plugin: SelfSyncPlugin, done: () => void) {
    super(app);
    this.plugin = plugin;
    this.done = done;
  }

  onOpen(): void {
    let code = '';
    let passphrase = '';
    this.setTitle('Set up from another device');
    new Setting(this.contentEl).setName('Setup code').addTextArea((t) => t.setPlaceholder('selfsync1.…').onChange((v) => (code = v)));
    new Setting(this.contentEl).setName('Passphrase').addText((t) => {
      t.inputEl.type = 'password';
      t.onChange((v) => (passphrase = v));
    });
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText('Set up and sync').setCta().onClick(async () => {
        try {
          await this.plugin.importSetupCode(code, passphrase);
          this.close();
          this.done();
          void this.plugin.sync(true);
        } catch (e) {
          new Notice(e instanceof Error ? e.message : String(e), 8000);
        }
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class PassphraseModal extends Modal {
  private plugin: SelfSyncPlugin;

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    let first = '';
    let second = '';
    this.setTitle('Change passphrase');
    for (const [name, set] of [['New passphrase', (v: string) => (first = v)], ['Repeat it', (v: string) => (second = v)]] as const) {
      new Setting(this.contentEl).setName(name).addText((t) => {
        t.inputEl.type = 'password';
        t.onChange(set);
      });
    }
    new Setting(this.contentEl).addButton((b) =>
      b.setButtonText('Change passphrase').setCta().onClick(async () => {
        if (!first || first !== second) {
          new Notice('The two entries do not match.');
          return;
        }
        try {
          await this.plugin.changePassphrase(first);
          this.close();
          new Notice('Passphrase changed. Enter the new one on your other devices.');
        } catch (e) {
          new Notice(`Could not change the passphrase: ${e instanceof Error ? e.message : e}`, 10_000);
        }
      }),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
