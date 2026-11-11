import { Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, SuggestModal, TFile, debounce, type App } from 'obsidian';
import { DEFAULT_CONFIG, resolveConfig } from '../core/config.ts';
import { SafetyError, SyncEngine, type SyncResult, type Version } from '../core/engine.ts';
import { checkStore } from '../stores/doctor.ts';
import { withRetry } from '../stores/retry.ts';
import { S3Store } from '../stores/s3.ts';
import { ObsidianFS, PluginState, obsidianHttp } from './obsidianfs.ts';

interface Settings {
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
  syncConfigDir: boolean;
  exclude: string;
  conflictStrategy: 'merge' | 'copy';
  retentionDays: number;
  maxFileSizeMB: number;
  concurrency: number;
  compression: boolean;
}

const DEFAULTS: Settings = {
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
  changeDelaySeconds: 10,
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
        if (this.running) this.changedWhileRunning = true;
        else this.schedule();
      };
      for (const name of ['create', 'modify', 'delete', 'rename'] as const) {
        this.registerEvent(this.app.vault.on(name as 'create', changed));
      }
      // Phones suspend the app in the background; catch up the moment it is opened again.
      this.registerDomEvent(document, 'visibilitychange', () => {
        if (document.visibilityState === 'visible') void this.sync();
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
    this.timer = undefined;
    this.schedule = debounce(() => void this.sync(), Math.max(2, this.settings.changeDelaySeconds) * 1000, true);
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(() => void this.sync(), this.settings.intervalMinutes * 60_000);
      this.registerInterval(this.timer);
    }
  }

  private secret(name: string): string {
    return (name && this.app.secretStorage.getSecret(name)) || '';
  }

  private configured(): boolean {
    const s = this.settings;
    return !!(s.endpoint && s.bucket && this.secret(s.accessKeySecret) && this.secret(s.secretKeySecret) && this.secret(s.passphraseSecret));
  }

  private store() {
    const s = this.settings;
    return withRetry(
      new S3Store(
        {
          endpoint: s.endpoint.trim(),
          region: s.region.trim() || 'auto',
          bucket: s.bucket.trim(),
          prefix: s.prefix,
          pathStyle: s.pathStyle,
          accessKey: this.secret(s.accessKeySecret),
          secretKey: this.secret(s.secretKeySecret),
        },
        obsidianHttp,
      ),
    );
  }

  private getEngine(): SyncEngine {
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
            // This plugin's own folder holds device-specific state and settings.
            `${own}/**`,
            ...s.exclude.split('\n'),
          ],
          conflictStrategy: s.conflictStrategy,
          retentionDays: s.retentionDays,
          maxFileSizeMB: s.maxFileSizeMB,
          concurrency: s.concurrency,
          compression: s.compression,
        }),
      });
    }
    return this.engine;
  }

  private setStatus(text: string): void {
    this.statusEl?.setText(text);
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
    this.setStatus('Syncing…');
    try {
      const r = await this.getEngine().sync({ force });
      if (r.pulled || r.deletedLocal) this.fs?.forgetConfigListing();
      this.lastError = r.errors.length ? r.errors.map((e) => `${e.path}: ${e.message}`).join('\n') : '';
      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.setStatus(r.errors.length ? `Sync: ${r.errors.length} files failed` : `Synced ${time}`);
      if (manual || r.conflictCopies.length) new Notice(`Sync: ${summarize(r)}`);
      for (const copy of r.conflictCopies) new Notice(`Both versions kept: ${copy}`, 15_000);
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
      if (this.changedWhileRunning) this.schedule();
    }
  }

  async checkStorage(): Promise<void> {
    if (!this.settings.endpoint || !this.settings.bucket) {
      new Notice('Fill in the endpoint and bucket first.');
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

    const text = (name: string, desc: string, key: 'endpoint' | 'region' | 'bucket' | 'prefix' | 'deviceName', placeholder = '') =>
      new Setting(containerEl).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(placeholder).setValue(s[key]).onChange((v) => {
          s[key] = v.trim();
          save();
        }),
      );
    const secret = (name: string, desc: string, key: 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret') =>
      new Setting(containerEl).setName(name).setDesc(desc).addComponent((el) =>
        new SecretComponent(this.app, el).setValue(s[key]).onChange((v) => {
          s[key] = v ?? '';
          save();
        }),
      );
    const number = (name: string, desc: string, key: 'intervalMinutes' | 'changeDelaySeconds' | 'retentionDays' | 'maxFileSizeMB' | 'concurrency', min: number) =>
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

    new Setting(containerEl).setName('Storage').setHeading();
    text('Endpoint', 'The S3 API address of your storage provider.', 'endpoint', 'https://<account>.r2.cloudflarestorage.com');
    text('Region', 'Use "auto" for Cloudflare R2.', 'region', 'auto');
    text('Bucket', 'Must already exist.', 'bucket');
    text('Folder in bucket', 'Lets one bucket hold several vaults. Every device syncing this vault must use the same folder.', 'prefix');
    secret('Access key ID', 'Stored in Obsidian\'s secret storage on this device, not in the vault.', 'accessKeySecret');
    secret('Secret access key', 'Stored in Obsidian\'s secret storage on this device, not in the vault.', 'secretKeySecret');
    toggle('Path-style addresses', 'On for R2, Backblaze B2, MinIO and most others. Off for AWS S3 buckets that require bucket-name hostnames.', 'pathStyle');
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

    new Setting(containerEl).setName('When to sync').setHeading();
    toggle('Sync when Obsidian starts', '', 'syncOnStart');
    number('Sync every (minutes)', '0 turns the timer off.', 'intervalMinutes', 0);
    number('Sync after changes (seconds)', 'How long to wait after the last edit before syncing.', 'changeDelaySeconds', 2);

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
    number('Keep old versions for (days)', 'Older versions are removed by the "Delete expired versions from storage" command.', 'retentionDays', 1);

    new Setting(containerEl).setName('Advanced').setHeading();
    text('Device name', 'Shown in version history and conflict file names.', 'deviceName');
    number('Parallel transfers', '', 'concurrency', 1);
    toggle('Compress text before encrypting', '', 'compression');
  }
}
