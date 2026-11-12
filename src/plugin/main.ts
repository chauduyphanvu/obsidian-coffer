import { Notice, Platform, Plugin, TFile, TFolder, TextFileView, debounce, setIcon } from 'obsidian';
import { pool } from '../core/bytes.ts';
import type { SyncConfig } from '../core/config.ts';
import { heartbeatDue, writeHeartbeat } from '../core/devices.ts';
import { SafetyError, type GcResult, type SyncEngine, type SyncResult } from '../core/engine.ts';
import { fileName, vaultKey } from '../core/paths.ts';
import type { Repo } from '../core/repo.ts';
import type { ScopedFS } from '../core/scopedfs.ts';
import { plural } from '../core/text.ts';
import { planRestore, type DeletedFile } from '../core/timeline.ts';
import type { Entry, Version } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import { ChangeLog, fromEvents, type Why } from './changes.ts';
import { ObsidianFS, PluginState, lookup, obsidianHttp } from './obsidianfs.ts';
import { Pauses, nextPollDelay, pollPlaces } from './polling.ts';
import {
  cleanupDue,
  decodeSetupCode,
  defaultSettings,
  encodeSetupCode,
  folderProblem,
  hasStorageAddress,
  isConfigured,
  loadSettings,
  remoteSpec,
  secretName,
  setupLink,
  shareConfig,
  shareSecretName,
  statePath,
  storageProblem,
  syncConfig,
  type Settings,
  type Share,
} from './settings.ts';
import { SetupModal } from './setup.ts';
import {
  followRename,
  freeTaken,
  goneWith,
  inVault,
  makeEngine,
  placeOf,
  rejoin,
  syncAll,
  syncable,
  takeVaultCopies,
  targetsOf,
  vaultPath,
  type EngineHost,
  type Outcome,
  type Place,
} from './shares.ts';
import { ShareModal, pickTarget } from './sharing.ts';
import { resolveFirstConflict } from './resolve.ts';
import { applyRestore, deleteLimitCrossed, describeCleanup, keepOut, momentLabel, placeRestored, restoreSteps, sameSteps, type Failed, type Step } from './restore.ts';
import {
  describeFailure,
  inShare,
  keysMissingProblem,
  missingProblem,
  resultProblems,
  statusText,
  summarize,
  targetProblems,
  type Problem,
  type Tone,
} from './status.ts';
import { DeletedModal, RestoreEarlierModal, VerifyModal, VersionsModal } from './timemachine.ts';
import { ProblemsModal, SettingsTab } from './views.ts';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type SecretKey = 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret';
const SECRET_KEYS: SecretKey[] = ['accessKeySecret', 'secretKeySecret', 'passphraseSecret', 'webdavPasswordSecret'];

/** What a sync run ended with, for screens that show it inline. */
export interface SyncOutcome {
  result?: SyncResult;
  problem?: Problem;
  /** Each shared folder's part of the run, by share id. A share that did not sync (folder missing, no keys) has none. */
  shares?: Map<string, SyncOutcome>;
}

/** What the screens that look at the past read: the repo, and the file table as copied while no sync could change it. */
export interface Look {
  repo: Repo;
  remote: Map<string, Entry>;
  lastSeq: number;
  cfg: SyncConfig;
  now: number;
}

export type { Failed };

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
  /**
   * So many files were removed that a device on an older version pauses before deleting them, as it does whenever
   * many files go at once. The sync marks them as confirmed, so devices on this version do not.
   */
  olderPause?: boolean;
}

/** What the plugin remembers between syncs about one synced place: the vault, or a shared folder. */
interface Tracked {
  /** Why the last sync stopped; cleared by the next one that finishes. */
  failure?: Problem;
  /** What the last finished sync left to look at: failed, conflicting or oversized files. */
  found: Problem[];
  /** Files a restore removed, which the next sync to finish deletes from storage as confirmed (`allowDeletes`). */
  restored?: Set<string>;
  lastHeartbeat: number;
}

/** `true` lets the vault's sync delete many files; a share's id lets that shared folder's. */
type Force = boolean | string;

const keyOf = (share?: Share) => share?.id ?? '';

export default class SelfSyncPlugin extends Plugin {
  settings: Settings = defaultSettings(Platform.isMobile);
  /** "Receiving 40 of 249" while a sync moves files, otherwise empty. */
  progress = '';
  running = false;
  private files?: ObsidianFS;
  /** The vault's engine under '', each share's under its id. */
  private engines = new Map<string, { engine: SyncEngine; fs: ScopedFS }>();
  private tracking = new Map<string, Tracked>();
  private changes = new ChangeLog(() => this.settings.shares);
  private pauses = new Pauses();
  private changedWhileRunning = false;
  private statusEl?: HTMLElement;
  private ribbonEl?: HTMLElement;
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
  private progressNotice?: Notice;
  private schedule = debounce(() => void this.auto('edit'), 10_000, true);
  private lookup = (name: string) => this.secret(name);

  async onload(): Promise<void> {
    this.settings = loadSettings((await this.loadData()) as Partial<Settings> | null, Platform.isMobile);
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
      else if (params.share) new ShareModal(this.app, this, 'join', params.share).open();
    });

    this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true) });
    this.addCommand({ id: 'status', name: 'Show sync status and problems', callback: () => this.openStatus() });
    this.addCommand({ id: 'setup', name: 'Set up sync', callback: () => new SetupModal(this.app, this, 'start').open() });
    this.addCommand({ id: 'force-sync', name: 'Sync now, allowing large deletions in the vault', callback: () => void this.sync(true, true) });
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
    this.addCommand({
      id: 'restore-deleted',
      name: 'Restore deleted files',
      checkCallback: whenConfigured(() => pickTarget(this, 'Restore deleted files from', (share) => new DeletedModal(this.app, this, share).open())),
    });
    this.addCommand({
      id: 'restore-earlier',
      name: 'Restore the vault or a folder to an earlier time',
      checkCallback: whenConfigured(() => new RestoreEarlierModal(this.app, this, '').open()),
    });
    this.addCommand({
      id: 'verify',
      name: 'Check synced data for damage',
      checkCallback: whenConfigured(() => pickTarget(this, 'Check the synced data of', (share) => new VerifyModal(this.app, this, share).open())),
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFolder) || !this.configured()) return;
        const { share, path } = this.placeOf(file.path);
        if (share ? !syncable(share, this.lookup) || (path && this.keptOut(share)(`${path}/`)) : this.keptOut()(`${file.path}/`)) return;
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
      // `places` are the ids of the places the change is in: a place paused before a mass delete may sync again.
      const changed = (...places: (string | string[])[]) => {
        for (const id of places.flat()) this.pauses.lift(id);
        this.noteActivity();
        this.dirty = true;
        if (this.running) this.changedWhileRunning = true;
        else this.schedule();
      };
      // Each event also tells the next sync of the place it is in what to look at; see ChangeLog.
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          // A new folder holds nothing yet: files put in it come with events of their own.
          changed(file instanceof TFile ? this.changes.file(file.path) : []);
        }),
      );
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          changed(this.changes.file(file.path));
        }),
      );
      this.registerEvent(
        this.app.vault.on('delete', (file) => {
          if (file instanceof TFolder) {
            const places = this.changes.folder(file.path);
            // A shared folder deleted here must not delete its files for everyone else: the share stops until the user chooses.
            const gone = goneWith(this.settings.shares, file.path).filter((s) => !s.missing);
            for (const s of gone) s.missing = true;
            if (gone.length) void this.saveSettings().then(() => this.report());
            changed(places);
          } else changed(this.changes.file(file.path));
        }),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFolder) {
            const places = this.changes.folder(oldPath, file.path);
            // A shared folder renamed or moved in Obsidian takes its share along.
            if (followRename(this.settings.shares, oldPath, file.path).length) void this.saveSettings();
            changed(places);
          } else changed(this.changes.file(oldPath), this.changes.file(file.path));
        }),
      );
      // Phones suspend the app in the background; catch up the moment it is opened again.
      // Going to the background: send pending edits now, before the system suspends the app.
      this.registerDomEvent(document, 'visibilitychange', () => {
        const visible = document.visibilityState === 'visible';
        if (visible) this.noteActivity();
        if (visible || this.dirty) {
          this.schedule.cancel();
          void this.auto(visible ? 'resume' : 'edit');
        }
      });
      this.applySchedule();
      this.updateStatus();
      if (!this.configured()) {
        const n = new Notice(this.fragment('Self Sync is not set up yet', 'Tap to set up encrypted sync for this vault.'), 15_000);
        n.containerEl.addEventListener('click', () => new SetupModal(this.app, this, 'start').open());
      } else if (this.settings.syncOnStart) void this.auto('start');
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engines.clear();
    this.files = undefined;
    this.applySchedule();
    this.updateStatus();
  }

  private applySchedule(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.stopPoll();
    this.timer = undefined;
    this.schedule.cancel();
    this.schedule = debounce(() => void this.auto('edit'), Math.max(2, this.settings.changeDelaySeconds) * 1000, true);
    if (this.settings.intervalMinutes > 0) {
      this.timer = window.setInterval(() => void this.auto('timer'), this.settings.intervalMinutes * 60_000);
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

  /**
   * Storage cannot notify devices, so ask each one: a tiny request each, and a real sync only when something is there.
   * A place paused before a mass delete is not asked (see Pauses).
   */
  private async poll(): Promise<void> {
    if (this.polling || this.running || document.visibilityState !== 'visible' || !this.configured()) return;
    this.polling = true;
    try {
      const places = new Map(this.targets().map((share) => [keyOf(share), share]));
      if (!(await pollPlaces([...places.keys()], this.pauses, (id) => this.getEngine(places.get(id)).remoteChanged()))) return;
      this.noteActivity();
      await this.auto('poll');
    } finally {
      this.polling = false;
    }
  }

  secret(name: string): string {
    return (name && this.app.secretStorage.getSecret(name)) || '';
  }

  configured(): boolean {
    return isConfigured(this.settings, this.lookup);
  }

  private store() {
    return openRemote(remoteSpec(this.settings, this.lookup), obsidianHttp);
  }

  private pluginDir(): string {
    return `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
  }

  /** The vault, then every shared folder that can sync here. */
  targets(): (Share | undefined)[] {
    return targetsOf(this.settings, this.lookup);
  }

  /** Which engine a vault path syncs with, and the path that engine knows it by. */
  placeOf(path: string): Place {
    return placeOf(this.settings.shares, path);
  }

  private host(): EngineHost {
    this.files ??= new ObsidianFS(this.app, this.settings.syncConfigDir, () => this.settings.shares.map((s) => s.folder));
    return {
      settings: this.settings,
      configDir: this.app.vault.configDir,
      pluginDir: this.pluginDir(),
      files: this.files,
      secret: this.lookup,
      openStore: (spec) => openRemote(spec, obsidianHttp),
      stateStore: (path) => new PluginState(this.app, path),
    };
  }

  private scope(share?: Share): { engine: SyncEngine; fs: ScopedFS } {
    let e = this.engines.get(keyOf(share));
    if (!e) {
      e = makeEngine(this.host(), share, {
        onProgress: (p) =>
          this.showProgress(`${share ? `“${share.folder}”: ` : ''}${p.phase === 'upload' ? 'Sending' : 'Receiving'} ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, p.total),
      });
      this.engines.set(keyOf(share), e);
    }
    return e;
  }

  /** The vault's engine, or a shared folder's. */
  getEngine(share?: Share): SyncEngine {
    return this.scope(share).engine;
  }

  private tracked(share?: Share): Tracked {
    let t = this.tracking.get(keyOf(share));
    if (!t) this.tracking.set(keyOf(share), (t = { found: [], lastHeartbeat: 0 }));
    return t;
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

  /** Conflict copies of the vault, or of a shared folder, as vault paths. */
  conflictCopies(share?: Share): string[] {
    return share ? share.conflictCopies.map((p) => vaultPath(share, p)) : this.settings.conflictCopies;
  }

  /** Every conflict copy waiting, the vault's and every shared folder's, as vault paths. */
  allConflictCopies(): string[] {
    return [...this.conflictCopies(), ...this.settings.shares.flatMap((s) => this.conflictCopies(s))];
  }

  /** Takes a conflict copy, by vault path, off the list of the vault or shared folder it is in. */
  async forgetConflictCopy(path: string): Promise<void> {
    const { share, path: inside } = this.placeOf(path);
    const rec = share ?? this.settings;
    rec.conflictCopies = rec.conflictCopies.filter((p) => vaultKey(p) !== vaultKey(inside));
    await this.saveSettings();
  }

  /** The problems of the vault, or of one shared folder, in its own words. */
  problemsOf(share?: Share): Problem[] {
    if (share?.missing) return [missingProblem(share.folder)];
    if (share && !isConfigured(share, this.lookup)) return [keysMissingProblem()];
    const t = this.tracked(share);
    return targetProblems({ failure: t.failure, found: t.found, conflictCopies: this.conflictCopies(share), lastSuccess: (share ?? this.settings).lastSuccess }, Date.now());
  }

  /** Everything the user should know about, worst first; a shared folder's problems say which folder. */
  problems(): Problem[] {
    const out = this.problemsOf();
    for (const share of this.settings.shares) out.push(...this.problemsOf(share).map((p) => inShare(p, share)));
    return out.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1));
  }

  /** One line for the status bar and the settings screen. */
  statusLine(): { text: string; tone: Tone } {
    if (!this.configured()) return { text: 'Not set up', tone: 'off' };
    if (this.running) return { text: this.progress || 'Syncing…', tone: 'busy' };
    return statusText(this.problems(), this.settings.lastSuccess, this.tracked().failure?.id === 'offline');
  }

  /** One line for a shared folder in settings. */
  shareStatus(share: Share): { text: string; tone: Tone } {
    return statusText(this.problemsOf(share), share.lastSuccess, this.tracked(share).failure?.id === 'offline');
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
  private pruneConflictCopies(share?: Share): void {
    const rec = share ?? this.settings;
    rec.conflictCopies = rec.conflictCopies.filter((p) => lookup(this.app, vaultPath(share, p)));
  }

  async sync(manual = false, force: Force = false, inline = false, why: Why = 'manual'): Promise<SyncOutcome> {
    if (!this.configured()) {
      if (manual && !inline) new SetupModal(this.app, this, 'start').open();
      return {};
    }
    if (this.running) {
      // The sync that runs after this one stands in for it, so it must look as far as this one would have.
      if (!fromEvents(why)) this.changes.lost();
      this.changedWhileRunning = true;
      return {};
    }
    this.running = true;
    try {
      return await this.syncHeld(manual, force, inline, why);
    } finally {
      this.release();
    }
  }

  /** A sync nobody asked for in so many words; `why` says what started it. */
  private auto(why: Why): Promise<SyncOutcome> {
    return this.sync(false, false, false, why);
  }

  /** Tells the other devices where this one is: once per session, then every 30 minutes. Runs under the sync lock. */
  private async heartbeat(share?: Share): Promise<void> {
    const t = this.tracked(share);
    if (!heartbeatDue(t.lastHeartbeat, Date.now())) return;
    t.lastHeartbeat = Date.now();
    try {
      const platform = Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'Unknown';
      await writeHeartbeat(await this.getEngine(share).view(), { platform, version: this.manifest.version });
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
   * One place's sync and, when due, its cleanup and heartbeat. Throws when the sync fails. It looks only at the files
   * the vault's events named when they are all there is to see; otherwise it lists every file.
   */
  private async syncOne(share: Share | undefined, force: boolean, why: Why): Promise<SyncResult> {
    const t = this.tracked(share);
    const rec = share ?? this.settings;
    const engine = this.getEngine(share);
    const changed = this.changes.take(
      share,
      why,
      share ? { folderMissing: !(lookup(this.app, share.folder) instanceof TFolder) } : { settingsDue: this.files?.configListingDue() ?? true },
    );
    const r = await engine.sync({ force, changed, allowDeletes: t.restored });
    this.pauses.lift(keyOf(share));
    t.restored = undefined;
    if (!share && (r.pulled || r.deletedLocal)) this.files?.forgetConfigListing();
    if (r.pushed || r.pulled || r.deletedLocal || r.deletedRemote || r.merged) this.noteActivity();
    t.failure = undefined;
    rec.lastSuccess = Date.now();
    rec.conflictCopies = [...new Set([...rec.conflictCopies, ...r.conflictCopies])];
    this.pruneConflictCopies(share);
    t.found = resultProblems(share ? inVault(share, r) : r, this.conflictCopies(share), this.settings.maxFileSizeMB);
    if (!r.errors.length && cleanupDue({ autoCleanDays: this.settings.autoCleanDays, lastCleanup: rec.lastCleanup }, Date.now())) {
      await engine.gc();
      rec.lastCleanup = Date.now();
    }
    await this.heartbeat(share);
    return r;
  }

  private failed(share: Share | undefined, e: unknown): Problem {
    const t = this.tracked(share);
    t.failure = describeFailure(e);
    this.changes.failed(share);
    if (e instanceof SafetyError) this.pauses.pause(keyOf(share));
    else this.engines.delete(keyOf(share));
    return t.failure;
  }

  /** A sync of the vault and then of each shared folder, while the caller holds `running`. One failing does not stop the rest. */
  private async syncHeld(manual: boolean, force: Force, inline: boolean, why: Why): Promise<SyncOutcome> {
    this.changedWhileRunning = false;
    this.dirty = false;
    this.updateStatus();
    // Settings changes fire no vault event; asked to sync, look at them now rather than at a listing up to 5 minutes old.
    if (manual) this.files?.forgetConfigListing();
    try {
      try {
        if (await freeTaken(this.host(), this.localKeys())) {
          this.engines.delete('');
          await this.saveData(this.settings);
        }
      } catch {
        // The paths stay left out, which is safe; the next sync tries again.
      }
      const outcomes = await syncAll(
        this.settings,
        this.lookup,
        (share) => this.syncOne(share, share ? force === share.id : force === true, why),
        (share) => this.pauses.includes(keyOf(share), why),
      );
      const out: SyncOutcome = { shares: new Map() };
      for (const o of outcomes) {
        const one: SyncOutcome = 'error' in o ? { problem: this.failed(o.target, o.error) } : { result: o.result };
        if (o.target) out.shares!.set(o.target.id, one);
        else Object.assign(out, one);
      }
      if (manual && !inline) this.announce(outcomes, out.problem);
      await this.saveData(this.settings);
      return out;
    } finally {
      this.progress = '';
      this.progressNotice?.hide();
      this.progressNotice = undefined;
      this.report();
    }
  }

  /** After "Sync now": what the vault's sync did, and what each shared folder's did when it did anything. */
  private announce(outcomes: Outcome<Share | undefined, SyncResult>[], vaultProblem?: Problem): void {
    const lines: string[] = [];
    for (const o of outcomes) {
      if ('error' in o) continue;
      const r = o.result;
      if (!o.target) lines.push(summarize(r));
      else if (r.pushed || r.pulled || r.deletedLocal || r.deletedRemote || r.merged || r.conflictCopies.length || r.errors.length) lines.push(`“${o.target.folder}”: ${summarize(r)}`);
    }
    if (lines.length) new Notice(`Sync: ${lines.join('\n')}`);
    if (vaultProblem?.id === 'offline') new Notice(this.fragment(vaultProblem.title, vaultProblem.detail), 10_000);
  }

  /** The part of a sync's outcome about `share`, or about the vault. A share that did not sync says why. */
  private outcomeOf(out: SyncOutcome, share?: Share): SyncOutcome {
    if (!share) return out;
    const one = out.shares?.get(share.id);
    if (one) return one;
    return { problem: this.problemsOf(share)[0] ?? { id: 'not-synced', severity: 'critical', title: 'This shared folder did not sync', detail: 'Try again.' } };
  }

  /** The safe answer to a paused mass delete: copy every file back to the side that lost it. */
  async keepAllFiles(share?: Share): Promise<void> {
    const kept = await this.exclusive('Keeping all files…', () => this.getEngine(share).keepAllFiles());
    new Notice(`Keeping all files${share ? ` in “${share.folder}”` : ''}: ${plural(kept, 'file')} will be copied back.`);
    await this.sync(true);
  }

  /**
   * After the history in storage turned out not to be the one this device saw, as when storage was restored from a
   * backup: carries on from storage as it is now. Nothing is deleted; files that differ are merged or kept both ways.
   */
  async acceptStorage(share?: Share): Promise<void> {
    await this.exclusive('Carrying on from storage…', () => this.getEngine(share).acceptStorage());
    new Notice(`Carrying on from storage as it is now${share ? ` in “${share.folder}”` : ''}. Nothing is deleted; where files differ, both versions are kept.`);
    await this.sync(true);
  }

  async setupLink(): Promise<string> {
    return setupLink(await encodeSetupCode(this.settings, this.lookup));
  }

  /** A link that lets someone join `share`, encrypted with its passphrase. It suggests the folder's name. */
  async inviteLink(share: Share): Promise<string> {
    return setupLink(await encodeSetupCode(share, this.lookup, fileName(share.folder)));
  }

  async importSetupCode(code: string, passphrase: string): Promise<void> {
    const { settings, secrets } = await decodeSetupCode(code, passphrase, this.app.vault.getName());
    for (const [id, value] of secrets) this.app.secretStorage.setSecret(id, value);
    Object.assign(this.settings, settings);
    await this.saveSettings();
  }

  /**
   * Stores a secret and points the setting at it, the vault's or `share`'s. A vault setting still on the bare name
   * `base`, which older versions shared between every vault on a phone, moves to this vault's own name, so fixing one
   * vault cannot break another.
   */
  async setSecret(key: SecretKey, base: string, value: string, share?: Share): Promise<void> {
    const rec = share ?? this.settings;
    const current = rec[key];
    const vault = this.app.vault.getName();
    const name = current && current !== base ? current : share ? shareSecretName(base, vault, share.id) : secretName(base, vault);
    this.app.secretStorage.setSecret(name, value);
    rec[key] = name;
    await this.saveSettings();
  }

  async changePassphrase(next: string): Promise<void> {
    await this.getEngine().changePassphrase(next);
    const id = this.settings.passphraseSecret;
    this.app.secretStorage.setSecret(id, next);
    this.engines.delete('');
  }

  /**
   * Creates `path` and the folders above it that are missing. Returns the folder's path as the vault has it, which may
   * be in the other Unicode form.
   */
  private async ensureFolder(path: string): Promise<string> {
    const vault = this.app.vault;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const found = lookup(this.app, dir);
      if (found instanceof TFile) throw new Error(`“${dir}” is a file, not a folder.`);
      // Can fail when the folder exists on disk but not yet in the vault; the check below says if it is really missing.
      if (!found) await vault.createFolder(dir).catch(() => undefined);
    }
    const folder = lookup(this.app, path);
    if (!(folder instanceof TFolder)) throw new Error(`Could not create the folder “${path}”.`);
    return folder.path;
  }

  private async removeState(share: Share): Promise<void> {
    const adapter = this.app.vault.adapter;
    const path = statePath(this.pluginDir(), share.id);
    if (await adapter.exists(path)) await adapter.remove(path);
  }

  /**
   * Adds a shared folder, creating its folder when missing, and stores its secrets. Waits for any sync to finish
   * first: a sync of the vault that began before must not see the folder taken away from it halfway.
   */
  async addShare(share: Share, secrets: [string, string][]): Promise<void> {
    await this.exclusive('Adding the shared folder…', async () => {
      const s = this.settings;
      const problem = folderProblem(s, share.folder, this.app.vault.configDir, this.pluginDir()) || storageProblem(s, share);
      if (problem) throw new Error(problem);
      share.folder = await this.ensureFolder(share.folder);
      this.engines.clear();
      await takeVaultCopies(this.host(), share);
      for (const [id, value] of secrets) this.app.secretStorage.setSecret(id, value);
      s.shares.push(share);
      await this.saveSettings();
    });
  }

  /** Whether a file has a vault path, by key, as the vault's index has it. The index is read on the first question. */
  private localKeys(): (key: string) => boolean {
    let keys: Set<string> | undefined;
    return (key) => (keys ??= new Set(this.app.vault.getFiles().map((f) => vaultKey(f.path)))).has(key);
  }

  /**
   * Stops syncing `share` on this device. Its files stay where they are and from then on sync with the vault, with
   * nothing deleted on either side (see `rejoin`). Its secrets and sync state are forgotten here; nothing is deleted
   * from its storage.
   */
  async stopSharing(share: Share): Promise<void> {
    await this.exclusive('Stopping…', async () => {
      const s = this.settings;
      let remote: Set<string> | undefined;
      try {
        remote = new Set((await this.getEngine().view()).st.remote.keys());
      } catch {
        // Offline: what the vault's state last saw of storage stands in.
      }
      // No vault engine may save its own copy of the state over what `rejoin` writes.
      this.engines.clear();
      await rejoin(this.host(), share, this.localKeys(), remote);
      s.shares = s.shares.filter((x) => x.id !== share.id);
      const inUse = new Set([s, ...s.shares].flatMap((x) => SECRET_KEYS.map((k) => x[k])));
      for (const k of SECRET_KEYS) {
        const name = share[k];
        if (!name || inUse.has(name)) continue;
        try {
          this.app.secretStorage.setSecret(name, '');
        } catch {
          // The setting no longer points at it, which is what matters.
        }
      }
      this.tracking.delete(share.id);
      this.pauses.lift(share.id);
      await this.removeState(share);
      await this.saveSettings();
    });
    this.report();
  }

  /**
   * After a shared folder went missing: makes the folder again and forgets what this device knew of the share, so its
   * next sync downloads every file and deletes nothing. Files already in the folder are kept and sent.
   */
  async downloadAgain(share: Share): Promise<SyncOutcome> {
    const out = await this.exclusive('Downloading the shared folder…', async () => {
      share.folder = await this.ensureFolder(share.folder);
      this.engines.delete(share.id);
      await this.removeState(share);
      share.missing = false;
      this.tracked(share).failure = undefined;
      await this.saveSettings();
      return this.syncHeld(true, false, true, 'manual');
    });
    return this.outcomeOf(out, share);
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

  /** Cleans up the vault's storage and every shared folder's. Syncs, and changes to shared folders, wait meanwhile. */
  private async cleanUp(): Promise<void> {
    if (!this.configured()) return;
    const total: GcResult = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 };
    const failed: string[] = [];
    const targets = this.targets();
    await this.exclusive('Cleaning up storage…', async () => {
      for (const share of targets) {
        try {
          const r = await this.getEngine(share).gc();
          for (const k of Object.keys(total) as (keyof GcResult)[]) total[k] += r[k];
        } catch (e) {
          failed.push(`${share ? `“${share.folder}”` : 'This vault'}: ${errorText(e)}`);
        }
      }
    });
    if (failed.length < targets.length) new Notice(describeCleanup(total), 10_000);
    if (failed.length) new Notice(`Clean-up failed.\n${failed.join('\n')}`, 10_000);
  }

  /** The file table is copied before anything else is awaited: a sync waiting on the engine may change it from then on. */
  async look(share?: Share): Promise<Look> {
    const v = await this.getEngine(share).view();
    return { repo: v.repo, remote: new Map(v.st.remote), lastSeq: v.st.lastSeq, cfg: v.cfg, now: v.now };
  }

  /**
   * Paths no restore touches. In the vault: excluded from sync here (shared folders among them), the plugin's own
   * folder, and the settings folder when it does not sync. In a shared folder: what its sync leaves out.
   */
  keptOut(share?: Share): (path: string) => boolean {
    const dir = this.app.vault.configDir;
    if (share) return keepOut(shareConfig(this.settings, share, dir).exclude, []);
    const own = this.pluginDir();
    return keepOut(syncConfig(this.settings, dir, own).exclude, this.settings.syncConfigDir ? [own] : [own, dir]);
  }

  /** The files of the vault, or of a shared folder, by key, with the path each has there. */
  private async localPaths(share?: Share): Promise<Map<string, string>> {
    return new Map((await this.scope(share).fs.list()).map((f) => [vaultKey(f.path), f.path]));
  }

  /**
   * Writes through the vault, so the file list the next sync reads has the file at once. The vault does not list
   * the settings folder, so those files go straight to disk, where the sync looks for them. `path` is inside `share`
   * when given; one that would leave it, as a shared folder's history from someone else might hold, is refused.
   */
  private async writeFile(share: Share | undefined, path: string, data: Uint8Array): Promise<void> {
    const vault = this.app.vault;
    const full = this.scope(share).fs.pathOf(path);
    if (full.startsWith(`${vault.configDir}/`)) {
      await this.files!.write(full, data);
      // Settings fire no vault events: the next sync lists them again and finds it.
      this.files!.forgetConfigListing();
      return;
    }
    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    const file = lookup(this.app, full);
    if (file instanceof TFile) return vault.modifyBinary(file, buffer);
    if (file) throw new Error('A folder has this name');
    for (let i = full.indexOf('/'); i > 0; i = full.indexOf('/', i + 1)) {
      const dir = full.slice(0, i);
      // Can fail when the folder exists on disk but not yet in the vault; creating the file says if it is really missing.
      if (!lookup(this.app, dir)) await vault.createFolder(dir).catch(() => undefined);
    }
    await vault.createBinary(full, buffer);
  }

  /** Puts `version` in place of the file at vault path `path`, or brings it back if there is none; the next sync sends it. */
  async restoreVersion(path: string, version: Version): Promise<void> {
    if (!version.entry) return;
    const { share, path: inside } = this.placeOf(path);
    await this.writeFile(share, inside, await this.getEngine(share).readVersion(version.entry));
    new Notice(`Restored “${fileName(path)}” as it was ${momentLabel(version.time, Date.now())}.`);
  }

  /** Brings deleted files of the vault, or of `share`, back where they were, or beside whatever has their name now. */
  async restoreDeleted(files: DeletedFile[], share?: Share): Promise<{ placed: { path: string; to: string }[]; failed: Failed[] }> {
    const engine = this.getEngine(share);
    const loaded = this.app.vault
      .getAllLoadedFiles()
      .map((f) => this.placeOf(f.path))
      .filter((p) => p.share === share)
      .map((p) => p.path);
    const taken = new Set([...loaded, ...(await this.localPaths(share)).keys()].map((p) => vaultKey(p).toLowerCase()));
    const to = placeRestored(files.map((f) => f.path), taken);
    const outcome: ({ path: string; to: string } | Failed)[] = new Array(files.length);
    await pool(files, 4, async (f, i) => {
      try {
        await this.writeFile(share, to.get(f.path)!, await engine.readVersion(f.entry));
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
   * Brings `folder` (all of it when '') of the vault, or of `share`, back to `target`, with syncs held off from start
   * to end. Syncs first, editors saved, so what was typed is in storage and the plan is made against what storage
   * holds; when that plan is no longer `expected`, returns it without changing anything. Removals go first, then
   * writes; a file with changes the sync has not sent is left as it is (see `applyRestore`), and one file failing does
   * not stop the rest. Ends with the sync that sends the result.
   */
  async restoreTo(target: Map<string, Entry>, folder: string, expected: Step[], share?: Share): Promise<RestoreOutcome> {
    return this.exclusive('Restoring…', async () => {
      this.say('Syncing recent changes first…');
      const saving: Promise<void>[] = [];
      this.app.workspace.iterateAllLeaves((leaf) => {
        if (leaf.view instanceof TextFileView && leaf.view.file) saving.push(leaf.view.save().catch(() => undefined));
      });
      await Promise.all(saving);
      const before = this.outcomeOf(await this.syncHeld(true, false, true, 'manual'), share);
      if (!before.result) return { problem: before.problem, done: [], failed: [] };
      const scope = vaultKey(folder).replace(/\/+$/, '');
      const unsent = before.result.errors.filter((e) => !scope || vaultKey(e.path).startsWith(`${scope}/`));
      if (unsent.length) {
        const problem: Problem = {
          id: 'restore-unsent',
          severity: 'critical',
          title: `${plural(unsent.length, 'file')} could not sync first`,
          detail: `Restoring now could overwrite changes that are not saved anywhere else, so nothing was restored.\n${unsent.map((e) => `${e.path}: ${e.message}`).join('\n')}`,
        };
        return { problem, done: [], failed: [] };
      }
      const { engine, fs } = this.scope(share);
      const { st, cfg } = await engine.view();
      const { steps } = restoreSteps(planRestore(st.remote, target, folder), st.remote, this.keptOut(share));
      if (!sameSteps(steps, expected)) return { changed: steps, done: [], failed: [] };
      const synced = st.synced.size;
      const last = new Map([...st.synced].map(([key, s]) => [key, { lsize: s.lsize, lmtime: s.lmtime }]));

      const here = await this.localPaths(share);
      const at = (path: string) => here.get(path) ?? path;
      const { done, failed } = await applyRestore(
        steps,
        last,
        {
          stat: (path) => fs.stat(at(path)),
          write: (path, data) => this.writeFile(share, at(path), data),
          remove: (path) => fs.remove(at(path)),
          read: (entry) => engine.readVersion(entry),
        },
        4,
        (kind, n, total) => this.say(`${kind === 'remove' ? 'Removing' : 'Restoring'} ${n.toLocaleString()} of ${total.toLocaleString()}`),
      );
      this.files?.forgetConfigListing();
      const removed = done.filter((s) => s.kind === 'remove').map((s) => s.path);
      const t = this.tracked(share);
      t.restored = new Set([...(t.restored ?? []), ...removed]);
      this.say('Sending the result to storage…');
      const sent = this.outcomeOf(await this.syncHeld(true, false, true, 'manual'), share);
      return { done, failed, sent, olderPause: deleteLimitCrossed(done.length - removed.length, removed.length, synced, cfg) !== undefined };
    });
  }
}
