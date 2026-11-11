import { Notice, Platform, Plugin, TFile, debounce, setIcon } from 'obsidian';
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
  secretName,
  setupLink,
  statePath,
  syncConfig,
  type Settings,
} from './settings.ts';
import { SetupModal } from './setup.ts';
import { describeFailure, plural, resultProblems, staleProblem, summarize, type Problem } from './status.ts';
import { HistoryModal, ProblemsModal, SettingsTab } from './views.ts';

const DEFAULTS = defaultSettings(Platform.isMobile);

/** What a sync run ended with, for screens that show it inline. */
export interface SyncOutcome {
  result?: SyncResult;
  problem?: Problem;
}

export default class SelfSyncPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  /** "Receiving 40 of 249" while a sync moves files, otherwise empty. */
  progress = '';
  running = false;
  private engine?: SyncEngine;
  private fs?: ObsidianFS;
  private changedWhileRunning = false;
  private statusEl?: HTMLElement;
  private ribbonEl?: HTMLElement;
  /** Why the last sync stopped; cleared by the next one that finishes. */
  private failure?: Problem;
  /** What the last finished sync left to look at: failed, conflicting or oversized files. */
  private found: Problem[] = [];
  /** Problems already announced, so a sync that finds the same ones stays quiet. */
  private alerted = new Set<string>();
  private alertNotice?: { notice: Notice; ids: string[] };
  private listeners = new Set<() => void>();
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
    this.statusEl.addClass('self-sync-status', 'mod-clickable');
    this.statusEl.onClickEvent(() => this.openStatus());
    this.ribbonEl = this.addRibbonIcon('refresh-cw', 'Sync now', () => (this.problems().length ? this.openStatus() : void this.sync(true)));
    this.registerObsidianProtocolHandler('self-sync', (params) => {
      if (params.setup) new SetupModal(this.app, this, 'join', params.setup).open();
    });

    this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true) });
    this.addCommand({ id: 'status', name: 'Show sync status and problems', callback: () => this.openStatus() });
    this.addCommand({ id: 'setup', name: 'Set up sync', callback: () => new SetupModal(this.app, this, 'start').open() });
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
      this.updateStatus();
      if (!this.configured()) {
        const n = new Notice(this.fragment('Self Sync is not set up yet', 'Tap to set up encrypted sync for this vault.'), 15_000);
        n.containerEl.addEventListener('click', () => new SetupModal(this.app, this, 'start').open());
      } else if (this.settings.syncOnStart) void this.sync();
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engine = undefined;
    this.applySchedule();
    this.updateStatus();
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

  secret(name: string): string {
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

  /** Called whenever the status, progress or problem list changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private showProgress(text: string, total: number): void {
    this.progress = text;
    this.updateStatus();
    // Phones have no status bar; a long first sync should not look like nothing is happening.
    // A screen that shows progress itself (setup, settings) is listening and makes this unnecessary.
    if (!Platform.isMobile || total < 50 || this.listeners.size) return;
    if (this.progressNotice) this.progressNotice.setMessage(`Sync: ${text}`);
    else this.progressNotice = new Notice(`Sync: ${text}`, 0);
  }

  /** Everything the user should know about, worst first. */
  problems(): Problem[] {
    const out: Problem[] = [];
    // A temporary failure (offline) only counts once it has gone on for a day.
    if (this.failure && this.failure.id !== 'offline') out.push(this.failure);
    if (this.failure) {
      const stale = staleProblem(this.settings.lastSuccess, Date.now());
      if (stale) out.push(stale);
    }
    out.push(...this.found);
    return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  }

  /** One line for the status bar and the settings screen. */
  statusLine(): { text: string; tone: 'ok' | 'busy' | 'warning' | 'critical' | 'off' } {
    if (!this.configured()) return { text: 'Not set up', tone: 'off' };
    if (this.running) return { text: this.progress || 'Syncing…', tone: 'busy' };
    const problems = this.problems();
    const critical = problems.filter((p) => p.severity === 'critical');
    if (critical.length) return { text: critical.length === 1 ? critical[0].title : `${plural(critical.length, 'problem')} need attention`, tone: 'critical' };
    const last = this.settings.lastSuccess;
    const when = last ? `Synced ${new Date(last).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not synced yet';
    if (problems.length) return { text: `${when} · ${plural(problems.length, 'thing', 'things')} to review`, tone: 'warning' };
    if (this.failure?.id === 'offline') return { text: `${when} · offline`, tone: 'ok' };
    return { text: when, tone: 'ok' };
  }

  private updateStatus(): void {
    const { text, tone } = this.statusLine();
    if (this.statusEl) {
      this.statusEl.setText(tone === 'critical' ? `⚠ ${text}` : `Sync: ${text}`);
      this.statusEl.toggleClass('is-critical', tone === 'critical');
      this.statusEl.toggleClass('is-warning', tone === 'warning');
    }
    if (this.ribbonEl) {
      setIcon(this.ribbonEl, tone === 'critical' || tone === 'warning' ? 'alert-triangle' : 'refresh-cw');
      this.ribbonEl.setAttribute('aria-label', tone === 'critical' || tone === 'warning' ? `Sync: ${text}` : 'Sync now');
      this.ribbonEl.toggleClass('self-sync-alert', tone === 'critical');
    }
    for (const l of this.listeners) l();
  }

  fragment(title: string, detail: string): DocumentFragment {
    return createFragment((f) => {
      f.createDiv({ cls: 'self-sync-notice-title', text: title });
      if (detail) f.createDiv({ cls: 'self-sync-notice-detail', text: detail });
    });
  }

  /**
   * Announces new problems in one notice: a critical one stays until tapped, warnings fade but stay
   * on the status. The notice goes away by itself once its problems are gone. Tapping opens the details.
   */
  private report(): void {
    const problems = this.problems();
    const ids = new Set(problems.map((p) => p.id));
    for (const id of [...this.alerted]) if (!ids.has(id)) this.alerted.delete(id);
    if (this.alertNotice && !this.alertNotice.ids.some((id) => ids.has(id))) {
      this.alertNotice.notice.hide();
      this.alertNotice = undefined;
    }
    const fresh = problems.filter((p) => !this.alerted.has(p.id));
    if (fresh.length) {
      for (const p of fresh) this.alerted.add(p.id);
      this.alertNotice?.notice.hide();
      const critical = fresh.some((p) => p.severity === 'critical');
      const [title, detail] =
        fresh.length === 1
          ? [fresh[0].title, `${fresh[0].detail.split(/(?<=\.)\s|\n/)[0]} Tap for details.`]
          : [critical ? 'Sync needs your attention' : `${fresh.length} things to review`, `${fresh.map((p) => p.title).join('\n')}\nTap for details.`];
      const notice = new Notice(this.fragment(title, detail), critical ? 0 : 30_000);
      notice.containerEl.addClass('self-sync-notice', critical ? 'is-critical' : 'is-warning');
      notice.containerEl.addEventListener('click', () => this.openStatus());
      this.alertNotice = { notice, ids: fresh.map((p) => p.id) };
    }
    this.updateStatus();
  }

  openStatus(): void {
    new ProblemsModal(this.app, this).open();
  }

  /** Conflict copies stay on the list until the user deletes or renames them. */
  private pruneConflictCopies(): void {
    this.settings.conflictCopies = this.settings.conflictCopies.filter((p) => this.app.vault.getAbstractFileByPath(p));
  }

  async sync(manual = false, force = false, inline = false): Promise<SyncOutcome> {
    if (!this.configured()) {
      if (manual && !inline) new SetupModal(this.app, this, 'start').open();
      return {};
    }
    if (this.running) {
      this.changedWhileRunning = true;
      return {};
    }
    this.running = true;
    this.changedWhileRunning = false;
    this.dirty = false;
    this.updateStatus();
    // Settings changes fire no vault event; asked to sync, look at them now rather than at a listing up to 5 minutes old.
    if (manual) this.fs?.forgetConfigListing();
    try {
      const r = await this.getEngine().sync({ force });
      if (r.pulled || r.deletedLocal) this.fs?.forgetConfigListing();
      const s = this.settings;
      this.failure = undefined;
      s.lastSuccess = Date.now();
      s.conflictCopies = [...new Set([...s.conflictCopies, ...r.conflictCopies])];
      this.pruneConflictCopies();
      this.found = resultProblems(r, s.conflictCopies, s.maxFileSizeMB);
      if (manual && !inline) new Notice(`Sync: ${summarize(r)}`);
      if (!r.errors.length && cleanupDue(s, Date.now())) {
        await this.getEngine().gc();
        s.lastCleanup = Date.now();
      }
      await this.saveData(s);
      return { result: r };
    } catch (e) {
      this.failure = describeFailure(e);
      if (!(e instanceof SafetyError)) this.engine = undefined;
      if (manual && !inline && this.failure.id === 'offline') new Notice(this.fragment(this.failure.title, this.failure.detail), 10_000);
      return { problem: this.failure };
    } finally {
      this.running = false;
      this.progress = '';
      this.progressNotice?.hide();
      this.progressNotice = undefined;
      this.report();
      if (this.changedWhileRunning) this.schedule();
    }
  }

  /** The safe answer to a paused mass delete: copy every file back to the side that lost it. */
  async keepAllFiles(): Promise<void> {
    const kept = await this.getEngine().keepAllFiles();
    new Notice(`Keeping all files: ${plural(kept, 'file')} will be copied back.`);
    await this.sync(true);
  }

  async setupLink(): Promise<string> {
    return setupLink(await encodeSetupCode(this.settings, (name) => this.secret(name)));
  }

  async importSetupCode(code: string, passphrase: string): Promise<void> {
    const { settings, secrets } = await decodeSetupCode(code, passphrase, this.app.vault.getName());
    for (const [id, value] of secrets) this.app.secretStorage.setSecret(id, value);
    Object.assign(this.settings, settings);
    await this.saveSettings();
  }

  /**
   * Stores a secret and points the setting at it. A setting still on the bare name `base`, which older versions shared
   * between every vault on a phone, moves to this vault's own name, so fixing one vault cannot break another.
   */
  async setSecret(key: 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret', base: string, value: string): Promise<void> {
    const current = this.settings[key];
    const name = current && current !== base ? current : secretName(base, this.app.vault.getName());
    this.app.secretStorage.setSecret(name, value);
    this.settings[key] = name;
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
    const bad = report.checks.find((c) => !c.ok);
    if (!bad) new Notice('Storage works: all checks passed.', 5000);
    else {
      const p = describeFailure(new Error(bad.detail ?? bad.name));
      new Notice(this.fragment(p.id.startsWith('failed') ? `Storage check failed: ${bad.name}` : p.title, p.detail), 20_000);
    }
  }

  private async cleanUp(): Promise<void> {
    if (!this.configured() || this.running) return;
    this.running = true;
    try {
      const r = await this.getEngine().gc();
      new Notice(`Removed ${plural(r.packsDeleted, 'storage object')} (${(r.bytesFreed / 1e6).toFixed(1)} MB).`);
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
