import { Notice, Platform, Plugin, TFile, debounce } from 'obsidian';
import { SafetyError, SyncEngine, type SyncResult } from '../core/engine.ts';
import { vaultKey } from '../core/paths.ts';
import type { Version } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import { ObsidianFS, PluginState, obsidianHttp } from './obsidianfs.ts';
import {
  cleanupDue,
  decodeSetupCode,
  defaultSettings,
  encodeSetupCode,
  hasStorageAddress,
  isConfigured,
  remoteSpec,
  statePath,
  syncConfig,
  type Settings,
} from './settings.ts';
import { HistoryModal, SettingsTab } from './views.ts';

const DEFAULTS = defaultSettings(Platform.isMobile);

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
    return isConfigured(this.settings, (name) => this.secret(name));
  }

  private store() {
    return openRemote(remoteSpec(this.settings, (name) => this.secret(name)), obsidianHttp);
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
        stateStore: new PluginState(this.app, statePath(own)),
        passphrase: this.secret(s.passphraseSecret),
        config: syncConfig(s, dir, own),
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
      if (!r.errors.length && cleanupDue(s, Date.now())) {
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

  exportSetupCode(): Promise<string> {
    return encodeSetupCode(this.settings, (name) => this.secret(name));
  }

  async importSetupCode(code: string, passphrase: string): Promise<void> {
    const { settings, secrets } = await decodeSetupCode(code, passphrase);
    for (const [id, value] of secrets) this.app.secretStorage.setSecret(id, value);
    Object.assign(this.settings, settings);
    await this.saveSettings();
  }

  async changePassphrase(next: string): Promise<void> {
    await this.getEngine().changePassphrase(next);
    const id = this.settings.passphraseSecret;
    this.app.secretStorage.setSecret(id, next);
    this.engine = undefined;
  }

  async checkStorage(): Promise<void> {
    if (!hasStorageAddress(this.settings)) {
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
      const versions = await this.getEngine().history(vaultKey(path));
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
