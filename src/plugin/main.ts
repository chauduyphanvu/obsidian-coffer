import { Notice, Platform, Plugin, TFile, TFolder, debounce, setIcon } from 'obsidian';
import { pool } from '../core/bytes.ts';
import { compileExcludes, type SyncConfig } from '../core/config.ts';
import { heartbeatDue, writeHeartbeat } from '../core/devices.ts';
import { SafetyError, SyncEngine, type SyncResult } from '../core/engine.ts';
import { fileName, vaultKey } from '../core/paths.ts';
import type { Repo } from '../core/repo.ts';
import { planRestore, type DeletedFile } from '../core/timeline.ts';
import type { Entry, Version } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import { ObsidianFS, PluginState, obsidianHttp } from './obsidianfs.ts';
import { nextPollDelay } from './polling.ts';
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
import { resolveFirstConflict } from './resolve.ts';
import { deleteLimitCrossed, goneOnlyByRestore, keepOut, momentLabel, placeRestored, restoreSteps, sameSteps, type Step } from './restore.ts';
import { describeFailure, plural, resultProblems, staleProblem, summarize, withConflicts, type Problem } from './status.ts';
import { DeletedModal, RestoreEarlierModal, VerifyModal, VersionsModal } from './timemachine.ts';
import { ProblemsModal, SettingsTab } from './views.ts';

const DEFAULTS = defaultSettings(Platform.isMobile);

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What a sync run ended with, for screens that show it inline. */
export interface SyncOutcome {
  result?: SyncResult;
  problem?: Problem;
}

/** What the screens that look at the past read: the repo, and the file table as copied while no sync could change it. */
export interface Look {
  repo: Repo;
  remote: Map<string, Entry>;
  lastSeq: number;
  cfg: SyncConfig;
  now: number;
}

export interface Failed {
  path: string;
  message: string;
}

/** How a restore to an earlier time went. */
export interface RestoreOutcome {
  /** The sync before it failed, so nothing was changed. */
  problem?: Problem;
  /** The plan as it stands now, when it is no longer the one confirmed; nothing was changed. */
  changed?: Step[];
  done: Step[];
  failed: Failed[];
  /** The sync that sent the result. */
  sent?: SyncOutcome;
  /** Other devices will pause before deleting what this removed, as they do whenever many files go at once. */
  othersPause?: boolean;
}

export default class SelfSyncPlugin extends Plugin {
  settings: Settings = DEFAULTS;
  /** "Receiving 40 of 249" while a sync moves files, otherwise empty. */
  progress = '';
  running = false;
  private engine?: SyncEngine;
  private fs?: ObsidianFS;
  private changedWhileRunning = false;
  private lastHeartbeat = 0;
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
  private pollDue = 0;
  private polling = false;
  /** When something last suggested another device may be involved; see nextPollDelay. */
  private lastActivity = Date.now();
  private dirty = false;
  /** Files a restore removed and no sync has yet deleted from storage; see `syncEngine`. */
  private restored?: Set<string>;
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
    this.addCommand({ id: 'resolve-conflict', name: 'Resolve a file changed on two devices', callback: () => resolveFirstConflict(this) });
    this.addCommand({
      id: 'history',
      name: 'Show version history of the current file',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !this.configured()) return false;
        if (!checking) new VersionsModal(this.app, this, file.path).open();
        return true;
      },
    });
    const whenConfigured = (open: () => void) => (checking: boolean) => {
      if (!this.configured()) return false;
      if (!checking) open();
      return true;
    };
    this.addCommand({ id: 'restore-deleted', name: 'Restore deleted files', checkCallback: whenConfigured(() => new DeletedModal(this.app, this).open()) });
    this.addCommand({
      id: 'restore-earlier',
      name: 'Restore the vault or a folder to an earlier time',
      checkCallback: whenConfigured(() => new RestoreEarlierModal(this.app, this, '').open()),
    });
    this.addCommand({ id: 'verify', name: 'Check synced data for damage', checkCallback: whenConfigured(() => new VerifyModal(this.app, this).open()) });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder) || !this.configured() || this.keptOut()(`${file.path}/`)) return;
        menu.addItem((item) =>
          item
            .setTitle('Restore this folder to an earlier time')
            .setIcon('history')
            .onClick(() => new RestoreEarlierModal(this.app, this, file.isRoot() ? '' : file.path).open()),
        );
      }),
    );

    this.register(() => this.stopPoll());
    this.app.workspace.onLayoutReady(() => {
      const changed = () => {
        this.noteActivity();
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
        if (document.visibilityState === 'visible') this.noteActivity();
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
    this.stopPoll();
    this.timer = undefined;
    this.schedule.cancel();
    this.schedule = debounce(() => void this.sync(), Math.max(2, this.settings.changeDelaySeconds) * 1000, true);
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(() => void this.sync(), this.settings.intervalMinutes * 60_000);
      this.registerInterval(this.timer);
    }
    this.armPoll();
  }

  private stopPoll(): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Keeps one poll timer. A pending one is only ever pulled sooner, so a burst of edits cannot keep postponing it. */
  private armPoll(): void {
    const delay = nextPollDelay(this.settings.pollSeconds, this.lastActivity, Date.now());
    if (delay === undefined) return;
    const due = Date.now() + delay;
    if (this.pollTimer !== undefined && this.pollDue <= due) return;
    window.clearTimeout(this.pollTimer);
    this.pollDue = due;
    this.pollTimer = window.setTimeout(() => {
      this.pollTimer = undefined;
      this.armPoll();
      void this.poll();
    }, delay);
  }

  private noteActivity(): void {
    this.lastActivity = Date.now();
    if (this.pollTimer !== undefined) this.armPoll();
  }

  /** Storage cannot notify devices, so ask it: one tiny request, and a real sync only when something is there. */
  private async poll(): Promise<void> {
    if (this.polling || this.running || document.visibilityState !== 'visible' || !this.configured()) return;
    this.polling = true;
    try {
      if (await this.getEngine().remoteChanged()) {
        this.noteActivity();
        await this.sync();
      }
    } catch {
      // Offline or unreachable; the next full sync reports it.
    } finally {
      this.polling = false;
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

  private pluginDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  getEngine(): SyncEngine {
    if (!this.engine) {
      const s = this.settings;
      const dir = this.app.vault.configDir;
      const own = this.pluginDir();
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
    out.push(...withConflicts(this.found, this.settings.conflictCopies));
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
    try {
      const outcome = await this.syncHeld(manual, force, inline);
      if (outcome.result) await this.heartbeat();
      return outcome;
    } finally {
      this.release();
    }
  }

  /** Tells the other devices where this one is: once per session, then every 30 minutes. Runs under the sync lock. */
  private async heartbeat(): Promise<void> {
    if (!heartbeatDue(this.lastHeartbeat, Date.now())) return;
    this.lastHeartbeat = Date.now();
    try {
      const platform = Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'Unknown';
      await writeHeartbeat(await this.getEngine().view(), { platform, version: this.manifest.version });
    } catch {
      // Storage may be down or refuse the write; the next try is in 30 minutes.
    }
  }

  /** Runs `task` once no sync is running, keeping syncs off until it ends. `label` is the status meanwhile. */
  private async exclusive<T>(label: string, task: () => Promise<T>): Promise<T> {
    while (this.running) await sleep(250);
    this.running = true;
    this.progress = label;
    this.updateStatus();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private release(): void {
    this.running = false;
    this.progress = '';
    this.updateStatus();
    if (this.changedWhileRunning) this.schedule();
  }

  /**
   * A sync. When it is refused for deleting many files, and every file it would delete from storage is one a restore
   * the user confirmed removed, it runs again forced: the guard is for deletions nobody asked for.
   */
  private async syncEngine(force: boolean): Promise<SyncResult> {
    const engine = this.getEngine();
    try {
      return await engine.sync({ force });
    } catch (e) {
      if (!(e instanceof SafetyError) || !(await this.restoreExplains(e))) throw e;
      return engine.sync({ force: true });
    }
  }

  private async restoreExplains(e: SafetyError): Promise<boolean> {
    const restored = this.restored;
    if (!restored || e.localDeletes || !this.fs) return false;
    try {
      const { st, cfg } = await this.getEngine().view();
      const present = new Set((await this.fs.list()).map((f) => vaultKey(f.path)));
      return goneOnlyByRestore(st.synced.keys(), present, compileExcludes(cfg.exclude), restored);
    } catch {
      return false;
    }
  }

  /** A sync while the caller holds `running`. */
  private async syncHeld(manual: boolean, force: boolean, inline: boolean): Promise<SyncOutcome> {
    this.changedWhileRunning = false;
    this.dirty = false;
    this.updateStatus();
    // Settings changes fire no vault event; asked to sync, look at them now rather than at a listing up to 5 minutes old.
    if (manual) this.fs?.forgetConfigListing();
    try {
      const r = await this.syncEngine(force);
      this.restored = undefined;
      if (r.pulled || r.deletedLocal) this.fs?.forgetConfigListing();
      if (r.pushed || r.pulled || r.deletedLocal || r.deletedRemote || r.merged) this.noteActivity();
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
      this.progress = '';
      this.progressNotice?.hide();
      this.progressNotice = undefined;
      this.report();
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

  /** Reading the file table while a sync changes it would mix two moments, so no sync runs while it is copied. */
  async look(): Promise<Look> {
    return this.exclusive('Reading history…', async () => {
      const v = await this.getEngine().view();
      return { repo: v.repo, remote: new Map(v.st.remote), lastSeq: v.st.lastSeq, cfg: v.cfg, now: v.now };
    });
  }

  /** Paths no restore touches: excluded from sync here, the plugin's own folder, and the settings folder when it does not sync. */
  keptOut(): (path: string) => boolean {
    const dir = this.app.vault.configDir;
    const own = this.pluginDir();
    return keepOut(syncConfig(this.settings, dir, own).exclude, this.settings.syncConfigDir ? [own] : [own, dir]);
  }

  /** This device's files by vault key, with the path each has on disk. */
  private async localPaths(): Promise<Map<string, string>> {
    this.getEngine();
    return new Map((await this.fs!.list()).map((f) => [vaultKey(f.path), f.path]));
  }

  /**
   * Writes through the vault, so the file list the next sync reads has the file at once. The vault does not list
   * the settings folder, so those files go straight to disk, where the sync looks for them.
   */
  private async writeFile(path: string, data: Uint8Array): Promise<void> {
    const vault = this.app.vault;
    if (path.startsWith(`${vault.configDir}/`)) {
      this.getEngine();
      await this.fs!.write(path, data);
      return;
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const file = vault.getAbstractFileByPath(path);
    if (file instanceof TFile) return vault.modifyBinary(file, buffer);
    if (file) throw new Error('A folder has this name');
    for (let i = path.indexOf('/'); i > 0; i = path.indexOf('/', i + 1)) {
      const dir = path.slice(0, i);
      // Can fail when the folder exists on disk but not yet in the vault; creating the file says if it is really missing.
      if (!vault.getAbstractFileByPath(dir)) await vault.createFolder(dir).catch(() => undefined);
    }
    await vault.createBinary(path, buffer);
  }

  /** Puts `version` in place of the file at `path`, or brings it back if there is none; the next sync sends it. */
  async restoreVersion(path: string, version: Version): Promise<void> {
    if (!version.entry) return;
    await this.writeFile(path, await this.getEngine().readVersion(version.entry));
    new Notice(`Restored “${fileName(path)}” as it was ${momentLabel(version.time, Date.now())}.`);
  }

  /** Brings deleted files back where they were, or beside whatever has their name now. */
  async restoreDeleted(files: DeletedFile[]): Promise<{ placed: { path: string; to: string }[]; failed: Failed[] }> {
    const engine = this.getEngine();
    const taken = new Set([...this.app.vault.getAllLoadedFiles().map((f) => f.path), ...(await this.localPaths()).keys()].map((p) => vaultKey(p).toLowerCase()));
    const to = placeRestored(files.map((f) => f.path), taken);
    const outcome: ({ path: string; to: string } | Failed)[] = new Array(files.length);
    await pool(files, 4, async (f, i) => {
      try {
        await this.writeFile(to.get(f.path)!, await engine.readVersion(f.entry));
        outcome[i] = { path: f.path, to: to.get(f.path)! };
      } catch (e) {
        outcome[i] = { path: f.path, message: errorText(e) };
      }
    });
    return { placed: outcome.filter((x) => 'to' in x), failed: outcome.filter((x) => 'message' in x) };
  }

  private say(progress: string): void {
    this.progress = progress;
    this.updateStatus();
  }

  /**
   * Brings `folder` (the whole vault when '') back to `target`, with syncs held off from start to end. Syncs first,
   * so nothing unsynced is lost and the plan is made against what storage holds; when that plan is no longer
   * `expected`, returns it without changing anything. Removals go first, then writes; one file failing does not stop
   * the rest. Ends with the sync that sends the result.
   */
  async restoreTo(target: Map<string, Entry>, folder: string, expected: Step[]): Promise<RestoreOutcome> {
    return this.exclusive('Restoring…', async () => {
      this.say('Syncing recent changes first…');
      const before = await this.syncHeld(true, false, true);
      if (before.problem) return { problem: before.problem, done: [], failed: [] };
      const unsent = before.result?.errors.filter((e) => !folder || e.path.startsWith(`${folder.replace(/\/+$/, '')}/`)) ?? [];
      if (unsent.length) {
        const problem: Problem = {
          id: 'restore-unsent',
          severity: 'critical',
          title: `${plural(unsent.length, 'file')} could not sync first`,
          detail: `Restoring now could overwrite changes that are not saved anywhere else, so nothing was restored.\n${unsent.map((e) => `${e.path}: ${e.message}`).join('\n')}`,
        };
        return { problem, done: [], failed: [] };
      }
      const engine = this.getEngine();
      const { st, cfg } = await engine.view();
      const { steps } = restoreSteps(planRestore(st.remote, target, folder), st.remote, this.keptOut());
      if (!sameSteps(steps, expected)) return { changed: steps, done: [], failed: [] };
      const synced = st.synced.size;

      const here = await this.localPaths();
      const done: Step[] = [];
      const failed: Failed[] = [];
      const removals = steps.filter((s) => s.kind === 'remove');
      const writes = steps.filter((s) => s.kind !== 'remove');
      for (const [i, s] of removals.entries()) {
        this.say(`Removing ${(i + 1).toLocaleString()} of ${removals.length.toLocaleString()}`);
        try {
          await this.fs!.remove(here.get(s.path) ?? s.path);
          done.push(s);
        } catch (e) {
          failed.push({ path: s.path, message: errorText(e) });
        }
      }
      let n = 0;
      await pool(writes, 4, async (s) => {
        try {
          await this.writeFile(here.get(s.path) ?? s.path, await engine.readVersion(s.entry!));
          done.push(s);
        } catch (e) {
          failed.push({ path: s.path, message: errorText(e) });
        }
        this.say(`Restoring ${(++n).toLocaleString()} of ${writes.length.toLocaleString()}`);
      });
      this.fs!.forgetConfigListing();
      const removed = done.filter((s) => s.kind === 'remove').map((s) => s.path);
      this.restored = new Set([...(this.restored ?? []), ...removed]);
      this.say('Sending the result to storage…');
      const sent = await this.syncHeld(true, false, true);
      return { done, failed, sent, othersPause: deleteLimitCrossed(done.length - removed.length, removed.length, synced, cfg) !== undefined };
    });
  }
}
