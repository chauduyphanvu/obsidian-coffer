import { Notice, Platform, Plugin, TFile, TFolder, TextFileView, debounce, setIcon, type SecretStorage } from 'obsidian';
import { pool } from '../core/bytes.ts';
import { DEFAULT_CONFIG, compileExcludes, type SyncConfig } from '../core/config.ts';
import { forgetDevice, heartbeatDue, writeHeartbeat } from '../core/devices.ts';
import {
  PassphraseUnknownError,
  RemovedError,
  UnverifiedError,
  type Arrival,
  type GcResult,
  type MemberStanding,
  type MemberStatus,
  type RepairOptions,
  type RepairReport,
  type RepoView,
  type SuggestOutcome,
  type SyncEngine,
  type SyncResult,
  type WaitingSuggestions,
} from '../core/engine.ts';
import { encodeFollow, encodeInvite, ownerLinkFields, type FollowInvite, type MemberChange, type MemberInvite, type MemberKeys } from '../core/members.ts';
import { createMemberShare, joinShare } from '../core/membership.ts';
import { fileName, vaultKey } from '../core/paths.ts';
import type { Repo } from '../core/repo.ts';
import { LocalState } from '../core/state.ts';
import { errorText, firstSentence, plural } from '../core/text.ts';
import { planRestore, type DeletedFile } from '../core/timeline.ts';
import type { Entry, Version } from '../core/types.ts';
import { checkStore } from '../stores/doctor.ts';
import { openRemote } from '../stores/open.ts';
import { arrivalLine, type Self } from './activity.ts';
import { ChangeLog, fromEvents, type Why } from './changes.ts';
import { chooseDeferred } from './deferred.ts';
import { checkFollowAddress, expiresIn, followRekey, isUsedError, joinWithInvite, keysOf, mustNotWrite, rekey, rekeySkip, rekeyTest, standingHere, testKeys, withKeys, type KeySet, type RekeyFailure } from './members.ts';
import { forgetGone, isOffered, lookForOffers, offerKey, offersDue, offersHere, offersIn, offersOf, publishOffer, withdrawOffers, type Offer, type OfferCache } from './offers.ts';
import { OtherSenderError, PropertyFS, isAttachment, isNote, inviteProblem, joinProblem, keptText, noteInShare, onlyShownBy, newEmbeds, otherSender, propertyProblems, sendProblem, sentNotesText, settleChoices, startProblem, unmarkedText, unusedText, withShare, withoutShare, writeProblem, type Survey } from './byproperty.ts';
import { RemoveModal, WhatsSharedModal } from './byproperty-ui.ts';
import { ObsidianCatalog, ObsidianFS, PluginState, lookup, obsidianHttp } from './obsidianfs.ts';
import { Pauses, Retries, nextPollDelay, pausesOn, pollPlaces, receivedChanges } from './polling.ts';
import {
  cleanupDue,
  codeIterations,
  decodeSetupCode,
  defaultSettings,
  encodeSetupCode,
  folderProblem,
  folderShares,
  hasStorageAddress,
  isConfigured,
  labelOf,
  loadSettings,
  positionPath,
  propertyConfig,
  remoteSpec,
  secretName,
  setupLink,
  shareConfig,
  shareSecretName,
  statePath,
  storagePayload,
  storageProblem,
  syncConfig,
  type Settings,
  type Share,
} from './settings.ts';
import { IDS, SetupModal, type Keys } from './setup.ts';
import {
  followRename,
  freeTaken,
  goneWith,
  hasMembers,
  inVault,
  locationClash,
  makeEngine,
  memberKeysIn,
  placeOf,
  propertyPlaces,
  readOnlyInviteCode,
  rejoin,
  SHARES_AT_ONCE,
  syncAll,
  syncable,
  takeVaultCopies,
  targetsOf,
  vaultPath,
  type EngineHost,
  type Outcome,
  type Place,
  type ShareFS,
} from './shares.ts';
import { ShareModal, pickTarget } from './sharing.ts';
import { resolveFirstConflict } from './resolve.ts';
import { applyRestore, deleteLimitCrossed, describeCleanup, keepDeferred, keepOut, momentLabel, placeRestored, restoreSteps, sameSteps, sentNote, type Failed, type Step } from './restore.ts';
import { canSuggest, forgetSent, recordSent, sentBefore } from './suggestions.ts';
import {
  MAX_COMPARE_BYTES,
  connectError,
  describeFailure,
  inShare,
  keptNote,
  keysMissingProblem,
  missingProblem,
  resultProblems,
  RunProgress,
  shareLine,
  statusText,
  summarize,
  targetProblems,
  type MemberContext,
  type Problem,
  type RunPlace,
  type Snapshot,
  type Tone,
  unchangedSince,
} from './status.ts';
import { ActivityModal, DeletedModal, RepairModal, RestoreEarlierModal, VerifyModal, VersionsModal } from './timemachine.ts';
import { ProblemsModal, SettingsTab } from './views.ts';

type SecretKey = 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret';
/** Every setting of a share that names a secret, so that stopping it forgets them all. */
const SHARE_SECRETS = ['accessKeySecret', 'secretKeySecret', 'passphraseSecret', 'webdavPasswordSecret', 'memberKeysSecret'] as const;

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
  /** In a shared folder with members, every member change this device holds, oldest first; otherwise none. */
  members: MemberChange[];
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
  /** Files the last finished sync left in storage until asked for, by their path in this place. */
  deferred?: string[];
  /** A shared folder with members: what this device is in it, as of its last sync that got as far as the member list. */
  standing?: MemberStanding;
  /** A shared folder with members: the re-key found not to work on this device, tried again only after a while (`rekeySkip`). */
  rekeyFailed?: RekeyFailure;
  /** The owner's devices: how many suggestions wait in storage, and when that was last looked at. */
  suggestions?: number;
  inboxLooked?: number;
}

/** `true` lets the vault's sync delete many files; a share's id lets that shared folder's. */
type Force = boolean | string;

const keyOf = (share?: Share) => share?.id ?? '';
/** How long the notice of other people's changes shows. */
const ARRIVALS_SHOWN = 15_000;
/** How often a sync of a shared folder looks for suggestions on the owner's devices; a sync asked for always looks. */
const INBOX_EVERY = 60_000;
const placeOfRun = (share?: Share): RunPlace => share ?? { id: '' };

export default class CofferPlugin extends Plugin {
  settings: Settings = defaultSettings(Platform.isMobile);
  /** One line for the whole run, such as "Receiving 40 of 249", while a sync moves files; otherwise empty. */
  progress = '';
  running = false;
  private files?: ObsidianFS;
  /** What Obsidian has read of the vault's notes, for notes shared by a property. */
  catalog!: ObsidianCatalog;
  /** The vault's engine under '', each share's under its id. */
  private engines = new Map<string, { engine: SyncEngine; fs: ShareFS }>();
  private tracking = new Map<string, Tracked>();
  /** Where each place of the running sync is, since shared folders sync side by side. */
  private run = new RunProgress();
  private changes = new ChangeLog(() => this.settings.shares);
  private pauses = new Pauses();
  private retries = new Retries();
  /** Whether a sync started for `why`, or a poll, includes a place: not while it is paused or waits after failing. */
  private gate = { includes: (id: string, why: Why) => this.pauses.includes(id, why) && this.retries.includes(id, why, Date.now()) };
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
  private retryTimer?: number;
  private lastHeartbeat = 0;
  /** The device name this session's last heartbeat went under. */
  private heartbeatName = '';
  /** When something last suggested another device may be involved; see nextPollDelay. */
  private lastActivity = Date.now();
  private dirty = false;
  /** Shared folders the vault's other devices offer (offers.ts), as of the last look, and when that was. */
  private offers: OfferCache = new Map();
  private offersLooked = 0;
  private offersLooking?: Promise<void>;
  /** The notice of other people's changes on show, with when it went up and what it tells, by share id (`tellArrivals`). */
  private arrivals?: { notice: Notice; at: number; byShare: Map<string, Arrival[]> };
  private progressNotice?: Notice;
  /** Notes shared by a property: what this session already told, so a notice is not repeated at every sync. */
  private told = new Set<string>();
  /** Notes shared by a property: what the last sync of each found, by share id (`PropertyFS.survey`). */
  private surveys = new Map<string, Survey>();
  /** The vault's notes and attachments as Obsidian's index has them, without the settings folder. */
  private notes?: ObsidianFS;
  private schedule = debounce(() => void this.auto('edit'), 10_000, true);
  private lookup = (name: string) => this.secret(name);

  async onload(): Promise<void> {
    const loadedLate = this.app.workspace.layoutReady;
    this.settings = loadSettings((await this.loadData()) as Partial<Settings> | null, Platform.isMobile);
    // Registered before the layout is ready, so that the first time Obsidian has read the whole vault is not missed.
    this.catalog = new ObsidianCatalog(this.app);
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.catalogReady()));
    if (!this.settings.deviceName) {
      this.settings.deviceName = `${Platform.isMobile ? 'mobile' : 'desktop'}-${Math.random().toString(16).slice(2, 6)}`;
      await this.saveData(this.settings);
    }
    this.addSettingTab(new SettingsTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('coffer-status', 'mod-clickable');
    this.statusEl.onClickEvent(() => this.openStatus());
    this.ribbonEl = this.addRibbonIcon('refresh-cw', 'Sync now', () => (this.problems().length ? this.openStatus() : void this.sync(true)));
    this.registerObsidianProtocolHandler('coffer', (params) => {
      if (params.setup) new SetupModal(this.app, this, 'join', params.setup).open();
      else if (params.share) new ShareModal(this.app, this, 'join', params.share).open();
    });

    this.addCommand({ id: 'sync', name: 'Sync now', callback: () => void this.sync(true) });
    this.addCommand({ id: 'status', name: 'Show sync status and problems', callback: () => this.openStatus() });
    this.addCommand({ id: 'setup', name: 'Set up sync', callback: () => new SetupModal(this.app, this, 'start').open() });
    this.addCommand({ id: 'force-sync', name: 'Sync now, allowing large deletions in the vault', callback: () => void this.sync(true, true) });
    this.addCommand({
      id: 'download-deferred',
      name: 'Download a file left in storage',
      checkCallback: (checking) => {
        if (!this.configured() || !this.settings.deferAboveMB) return false;
        if (!checking) void chooseDeferred(this);
        return true;
      },
    });
    this.addCommand({ id: 'check-storage', name: 'Check storage connection', callback: () => void this.checkStorage() });
    this.addCommand({
      id: 'clean-up',
      name: 'Delete expired versions from storage',
      checkCallback: (checking) => {
        if (this.targets().every((share) => (share ?? this.settings).readOnly)) return false;
        if (!checking) void this.cleanUp();
        return true;
      },
    });
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
    this.addCommand({
      id: 'activity',
      name: 'Show recent changes in a shared folder',
      checkCallback: (checking) => {
        if (!this.configured() || !this.targets().some((share) => share)) return false;
        if (!checking) pickTarget(this, 'Show recent changes in', (share) => share && new ActivityModal(this.app, this, share).open(), (share) => !!share);
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
      // Notes shared by a property keep every version in the vault's history: restoring goes through the vault.
      checkCallback: whenConfigured(() => pickTarget(this, 'Restore deleted files from', (share) => new DeletedModal(this.app, this, share).open(), (share) => !share?.property)),
    });
    this.addCommand({
      id: 'restore-earlier',
      name: 'Restore the vault or a folder to an earlier time',
      checkCallback: whenConfigured(() => new RestoreEarlierModal(this.app, this, '').open()),
    });
    this.addCommand({
      id: 'verify',
      name: 'Check synced data for damage',
      // A followed folder is read from an address that can not be listed, which checking needs.
      checkCallback: whenConfigured(() => pickTarget(this, 'Check the synced data of', (share) => new VerifyModal(this.app, this, share).open(), (share) => !share?.followUrl)),
    });
    this.addCommand({
      id: 'repair',
      name: "Repair synced data from this device's files",
      checkCallback: (checking) => {
        if (!this.configured() || this.targets().every((share) => this.receivesOnly(share))) return false;
        if (!checking) pickTarget(this, 'Repair the synced data of', (share) => new RepairModal(this.app, this, share, false).open(), (share) => !this.receivesOnly(share));
        return true;
      },
    });
    const noteCommand = (act: (share: Share, file: TFile) => void, offered: (share: Share, path: string) => boolean) => (checking: boolean) => {
      const share = this.propertyShare();
      const file = this.app.workspace.getActiveFile();
      if (!share || !file || !isNote(file.path) || !syncable(share, this.lookup) || !offered(share, file.path)) return false;
      if (!checking) act(share, file);
      return true;
    };
    this.addCommand({
      id: 'share-note',
      name: 'Add the current note to the notes shared by property',
      checkCallback: noteCommand((share, file) => void this.shareNoteSaying(share, file), (share, path) => !this.noteIn(share, path) && !this.joinProblemOf(share, path)),
    });
    this.addCommand({
      id: 'unshare-note',
      name: 'Remove the current note from the notes shared by property…',
      checkCallback: noteCommand((share, file) => new RemoveModal(this.app, this, share, [file.path]).open(), (share, path) => this.noteIn(share, path, true)),
    });
    this.addCommand({
      id: 'whats-shared',
      name: "Show what's shared by property",
      checkCallback: (checking) => {
        const share = this.propertyShare();
        if (!share) return false;
        if (!checking) new WhatsSharedModal(this.app, this, share).open();
        return true;
      },
    });
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        const share = this.propertyShare();
        if (!(file instanceof TFile) || !share || !isNote(file.path) || !syncable(share, this.lookup)) return;
        const held = this.surveys.get(share.id)?.shared.has(vaultKey(file.path));
        // A note in a shared folder or a left-out one can not be in the share, whatever its properties say.
        if (!held && this.joinProblemOf(share, file.path)) return;
        const shared = this.noteIn(share, file.path);
        menu.addItem((item) =>
          shared
            ? item.setTitle(`Remove from “${share.property}”…`).setIcon('user-minus').onClick(() => new RemoveModal(this.app, this, share, [file.path]).open())
            : item.setTitle(`Add to “${share.property}”`).setIcon('user-plus').onClick(() => void this.shareNoteSaying(share, file)),
        );
      }),
    );
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
    this.register(() => window.clearTimeout(this.retryTimer));
    // A sync an edit scheduled must not run once the plugin is disabled, or beside the next copy of it after an update.
    this.register(() => this.schedule.cancel());
    this.app.workspace.onLayoutReady(() => {
      // `places` are the ids of the places the change is in: a place paused before a mass delete may sync again.
      const changed = (...places: (string | string[])[]) => {
        for (const id of places.flat()) this.pauses.lift(id);
        this.dirty = true;
        if (this.running) this.changedWhileRunning = true;
        else this.schedule();
      };
      // Each event also tells the next sync of the place it is in what to look at; see ChangeLog.
      this.registerEvent(
        this.app.vault.on('create', (file) => {
          // A new folder holds nothing yet: files put in it come with events of their own.
          changed(file instanceof TFile ? [this.changes.file(file.path), ...this.propertyOf(file.path)] : []);
        }),
      );
      this.registerEvent(
        this.app.vault.on('modify', (file) => {
          changed(this.changes.file(file.path), this.propertyOf(file.path));
        }),
      );
      // Obsidian reads a note's properties a moment after it changes: a sync that ran before it did may not have added it.
      this.registerEvent(
        this.app.metadataCache.on('changed', (file) => {
          const share = this.propertyShare();
          if (!share || !this.catalog.ready() || !isNote(file.path)) return;
          if (this.surveys.get(share.id)?.shared.has(vaultKey(file.path)) || this.catalog.says(file.path, share.property)) changed(share.id);
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
            changed(places, this.propertyIds());
          } else changed(this.changes.file(file.path), this.propertyOf(file.path));
        }),
      );
      this.registerEvent(
        this.app.vault.on('rename', (file, oldPath) => {
          if (file instanceof TFolder) {
            const places = this.changes.folder(oldPath, file.path);
            // A shared folder renamed or moved in Obsidian takes its share along.
            if (followRename(this.settings.shares, oldPath, file.path).length) void this.saveSettings();
            changed(places, this.propertyIds());
          } else changed(this.changes.file(oldPath), this.changes.file(file.path), this.propertyOf(oldPath), this.propertyOf(file.path));
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
      if (this.catalog.readAlready(loadedLate)) this.catalog.markReady();
      // Should Obsidian never say it has read the vault, files may still join a minute on: until then only joining waits.
      const fallback = window.setTimeout(() => this.catalogReady(), 60_000);
      this.register(() => window.clearTimeout(fallback));
      this.applySchedule();
      this.updateStatus();
      if (!this.configured()) {
        const n = new Notice(this.fragment('Coffer is not set up yet', 'Tap to set up encrypted sync for this vault.'), 15_000);
        n.containerEl.addEventListener('click', () => new SetupModal(this.app, this, 'start').open());
      } else if (this.settings.syncOnStart) void this.auto('start');
    });
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.engines.clear();
    this.files = undefined;
    // A place that stopped only receiving owes a sync for what it kept back.
    if (this.targets().some((share) => !this.receivesOnly(share) && this.tracked(share).found.some((p) => p.id === 'unsent'))) this.dirty = true;
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
    // The timer just replaced may have held the sync an edit is owed, as when resolving a conflict saves settings.
    if (this.dirty && !this.running) this.schedule();
  }

  private stopPoll(): void {
    window.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
  }

  /** Keeps one poll timer. A pending one is only ever pulled sooner, so activity cannot keep postponing it. */
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
   * A place paused before a mass delete, or waiting after a failed sync, is not asked (see Pauses and Retries).
   */
  private async poll(): Promise<void> {
    if (this.polling || this.running || document.visibilityState !== 'visible' || !this.configured()) return;
    this.polling = true;
    try {
      const places = new Map(this.targets().map((share) => [keyOf(share), share]));
      if (!(await pollPlaces([...places.keys()], this.gate, (id) => this.getEngine(places.get(id)).remoteChanged(), SHARES_AT_ONCE))) return;
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

  /**
   * Whether this device never writes to the storage of `share` (the vault's when none): it is set to only receive, or
   * in a shared folder with members, its member may not write, or not yet.
   */
  receivesOnly(share?: Share): boolean {
    if ((share ?? this.settings).readOnly) return true;
    const standing = share && this.tracked(share).standing;
    return !!standing && !standing.mayWrite;
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
    this.files ??= new ObsidianFS(this.app, this.settings.syncConfigDir, () => folderShares(this.settings.shares).map((s) => s.folder));
    this.notes ??= new ObsidianFS(this.app, false, () => []);
    return {
      settings: this.settings,
      configDir: this.app.vault.configDir,
      pluginDir: this.pluginDir(),
      files: this.files,
      secret: this.lookup,
      openStore: (spec) => openRemote(spec, obsidianHttp),
      stateStore: (path) => new PluginState(this.app, path),
      notes: { files: this.notes, catalog: this.catalog },
    };
  }

  private scope(share?: Share): { engine: SyncEngine; fs: ShareFS } {
    let e = this.engines.get(keyOf(share));
    if (!e) {
      const pending = share ? '' : this.secret(this.pendingPassphrase());
      e = makeEngine(this.host(), share, {
        onProgress: (p) => this.showProgress(placeOfRun(share), `${p.phase === 'upload' ? 'Sending' : 'Receiving'} ${p.done.toLocaleString()} of ${p.total.toLocaleString()}`, p.total),
        ...(pending && { nextPassphrase: pending, onPassphrase: (p: string) => this.settlePassphrase(p) }),
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
    if (!t) this.tracking.set(keyOf(share), (t = { found: [] }));
    return t;
  }

  /** Called whenever the status, progress or problem list changes; returns an unsubscribe function. */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `place` says what it is doing. An engine still working after its sync ended says nothing that shows. */
  private showProgress(place: RunPlace, text: string, total: number): void {
    if (!this.running) return;
    this.run.say(place, text);
    this.showRun();
    // Phones have no status bar; a long first sync should not look like nothing is happening.
    // A screen that shows progress itself (setup, settings) is listening and makes this unnecessary.
    if (!Platform.isMobile || total < 50 || this.listeners.size) return;
    if (this.progressNotice) this.progressNotice.setMessage(`Sync: ${this.progress}`);
    else this.progressNotice = new Notice(`Sync: ${this.progress}`, 0);
  }

  /** Shows the run as it stands: its one line, and each place's state. */
  private showRun(): void {
    this.progress = this.run.line();
    this.updateStatus();
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
    if (share && !isConfigured(share, this.lookup)) return [keysMissingProblem(share)];
    const t = this.tracked(share);
    const rec = share ?? this.settings;
    return targetProblems({ failure: t.failure, found: t.found, conflictCopies: this.conflictCopies(share), lastSuccess: rec.lastSuccess, readOnly: this.receivesOnly(share) }, Date.now());
  }

  /** Whether the last sync of any place could not reach its storage. */
  offline(): boolean {
    return this.targets().some((share) => this.tracked(share).failure?.id === 'offline');
  }

  /** Whether files were changed here since the last sync began, so that it has not sent them yet. */
  waiting(): boolean {
    return this.dirty;
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

  /** One line for a shared folder in settings: where the running sync is with it, or how its last one went. */
  shareStatus(share: Share): { text: string; tone: Tone } {
    const state = this.running ? this.run.stateOf(share.id) : undefined;
    if (state) return { text: state === 'syncing' ? 'Syncing…' : 'Waiting to sync', tone: 'busy' };
    const t = this.tracked(share);
    return shareLine(this.problemsOf(share), t.standing, share.lastSuccess, t.failure?.id === 'offline');
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
      this.ribbonEl.toggleClass('coffer-alert', tone === 'critical');
    }
    for (const l of this.listeners) l();
  }

  fragment(title: string, detail: string): DocumentFragment {
    return createFragment((f) => {
      f.createDiv({ cls: 'coffer-notice-title', text: title });
      if (detail) f.createDiv({ cls: 'coffer-notice-detail', text: detail });
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
          ? [fresh[0].title, `${firstSentence(fresh[0].detail)} Tap for details.`]
          : [critical ? 'Sync needs your attention' : `${fresh.length} things to review`, `${fresh.map((p) => p.title).join('\n')}\nTap for details.`];
      const notice = new Notice(this.fragment(title, detail), critical ? 0 : 30_000);
      notice.containerEl.addClass('coffer-notice', critical ? 'is-critical' : 'is-warning');
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

  /**
   * Tells the vault's other devices where this one is: once per session, then every 30 minutes. Runs under the sync
   * lock. Never in a shared folder, whose storage other people may read.
   */
  private async heartbeat(look: () => Promise<RepoView>): Promise<void> {
    if (this.settings.readOnly) return;
    const name = this.settings.deviceName;
    // Renamed since the last one: the record goes under the new name now, and the one under the old name goes.
    const renamed = this.heartbeatName && this.heartbeatName !== name ? this.heartbeatName : '';
    if (!renamed && !heartbeatDue(this.lastHeartbeat, Date.now())) return;
    this.lastHeartbeat = Date.now();
    try {
      const platform = Platform.isIosApp ? 'iOS' : Platform.isAndroidApp ? 'Android' : Platform.isMacOS ? 'macOS' : Platform.isWin ? 'Windows' : Platform.isLinux ? 'Linux' : 'Unknown';
      const view = await look();
      await writeHeartbeat(view, { platform, version: this.manifest.version });
      this.heartbeatName = name;
      if (renamed) await forgetDevice(view, renamed);
    } catch {
      // Storage may be down or refuse the write; the next try is in 30 minutes.
    }
  }

  /** After the vault's sync: its heartbeat, and the offers of shared folders between this vault's devices, on one look at storage. */
  private async vaultChores(): Promise<void> {
    let view: Promise<RepoView> | undefined;
    const look = () => (view ??= this.getEngine().view());
    await this.heartbeat(look);
    await this.offerChores(look);
  }

  /**
   * Offers this device owes the vault's storage are written; then, when due, the offers of the vault's other devices
   * are looked for, and each new one is announced once. Best effort: what fails is tried at the next sync.
   */
  private async offerChores(look: () => Promise<RepoView>): Promise<void> {
    const s = this.settings;
    // A device that only receives the vault's changes never writes to its storage, offers included.
    if (!s.readOnly) {
      for (const share of s.shares.filter((x) => x.offerPending && syncable(x, this.lookup))) {
        try {
          const offer = await publishOffer((await look()).repo, share, this.lookup, s.deviceName, Date.now());
          // Known as offered before the next look: stopping it asks whether to withdraw it.
          if (offer) this.offers.set(offerKey(share.id), { modified: Number.NaN, offer });
          share.offerPending = '';
        } catch {
          // Storage may be down; the next sync writes it.
        }
      }
    }
    if (!offersDue(this.offersLooked, Date.now())) return;
    try {
      await this.readOffers(look, true);
    } catch {
      // The next sync looks again.
    }
  }

  /**
   * Reads the offers in the vault's storage. With `tell`, each one shown here for the first time is announced; without,
   * as when the settings that list them are open, they count as told.
   */
  private readOffers(look: () => Promise<RepoView>, tell: boolean): Promise<void> {
    this.offersLooking ??= (async () => {
      try {
        await lookForOffers((await look()).repo, this.offers);
        this.offersLooked = Date.now();
        forgetGone(this.settings, this.offers);
        const fresh = this.offersHere().filter((o) => !this.settings.offersTold.includes(o.id));
        for (const o of fresh) {
          this.settings.offersTold.push(o.id);
          if (tell) this.announceOffer(o);
        }
        this.updateStatus();
      } finally {
        this.offersLooking = undefined;
      }
    })();
    return this.offersLooking;
  }

  private announceOffer(o: Offer): void {
    const n = new Notice(this.fragment(`Add “${o.folder}” here too?`, `It is shared on ${o.by}, another device of this vault. Tap to add it here.`), 30_000);
    n.containerEl.addClass('coffer-notice');
    n.containerEl.addEventListener('click', () => new ShareModal(this.app, this, 'offer', '', o).open());
  }

  /** The shared folders the vault's other devices offer that this device has not added, as of the last look. */
  offersHere(): Offer[] {
    return offersHere(offersIn(this.offers), this.settings);
  }

  /**
   * Looks for offers now, as the settings that list them open, unless that was done moments ago. They count as told:
   * the screen shows them.
   */
  async refreshOffers(): Promise<void> {
    if (!this.configured() || Date.now() - this.offersLooked < 15_000) return;
    const kept = () => JSON.stringify([this.settings.offersTold, this.settings.offersHidden]);
    const before = kept();
    try {
      await this.readOffers(() => this.getEngine().view(), false);
    } catch {
      return;
    }
    if (kept() !== before) await this.saveData(this.settings);
  }

  /** Stops showing an offer on this device. Nothing lists hidden offers, so a tap on the notice it leaves brings it back. */
  async hideOffer(o: Offer): Promise<void> {
    const hidden = this.settings.offersHidden;
    if (!hidden.includes(o.id)) hidden.push(o.id);
    await this.saveData(this.settings);
    this.updateStatus();
    const n = new Notice(this.fragment(`“${o.folder}” is no longer offered here`, 'Tap to undo.'), 10_000);
    n.containerEl.addClass('coffer-notice');
    n.containerEl.addEventListener('click', () => {
      n.hide();
      this.settings.offersHidden = this.settings.offersHidden.filter((id) => id !== o.id);
      void this.saveData(this.settings).then(() => this.updateStatus());
    });
  }

  /** Whether the vault's other devices are offered `share`, as of the last look. */
  isOffered(share: Share): boolean {
    return isOffered(share, this.offers);
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
    this.run.clear();
    this.updateStatus();
    if (this.changedWhileRunning) this.schedule();
  }

  /**
   * One place's sync and, when due, its cleanup and the vault's heartbeat. Throws when the sync fails. It looks only at
   * the files the vault's events named when they are all there is to see; otherwise it lists every file.
   */
  private async syncOne(share: Share | undefined, force: boolean, why: Why, fetch?: string[]): Promise<SyncResult> {
    const t = this.tracked(share);
    const rec = share ?? this.settings;
    const engine = this.getEngine(share);
    if (share?.property) {
      const cannot = sendProblem(this.settings);
      if (cannot) throw cannot;
    }
    // Notes shared by a property are anywhere in the vault: their sync always lists it.
    const changed = share?.property
      ? undefined
      : this.changes.take(share, why, share ? { folderMissing: !(lookup(this.app, share.folder) instanceof TFolder) } : { settingsDue: this.files?.configListingDue() ?? true });
    // What the sharer removed goes for everyone as a deletion they confirmed, whatever else changed.
    const allowDeletes = share?.property ? [...rec.restored, ...share.removed] : rec.restored;
    let r: SyncResult;
    let shared: Problem[] = [];
    try {
      r = await engine.sync({ force, changed, allowDeletes, fetch, ...(share && canSuggest(share) && { suggested: sentBefore(share) }) });
      if (share?.property) shared = await this.afterProperty(share, engine, r);
    } catch (e) {
      // These come after the member list was read, so what it says of this device is known.
      if (hasMembers(share) && (e instanceof RemovedError || e instanceof UnverifiedError)) t.standing = standingHere(share, await engine.memberStanding().catch(() => undefined)) ?? t.standing;
      throw e;
    }
    if (hasMembers(share)) t.standing = standingHere(share, await engine.memberStanding());
    this.pauses.lift(keyOf(share));
    this.retries.reset(keyOf(share));
    rec.restored = [];
    if (!share && (r.pulled || r.deletedLocal)) this.files?.forgetConfigListing();
    if (receivedChanges(r)) this.noteActivity();
    t.failure = undefined;
    t.deferred = r.deferred;
    rec.lastSuccess = Date.now();
    rec.conflictCopies = [...new Set([...rec.conflictCopies, ...r.conflictCopies])];
    this.pruneConflictCopies(share);
    t.found = resultProblems(
      share ? inVault(share, r) : r,
      this.conflictCopies(share),
      this.settings.maxFileSizeMB,
      t.standing?.waiting ? t.standing.owner : undefined,
      share && canSuggest(share) ? (t.standing?.owner ?? '') : undefined,
    );
    t.found.push(...shared);
    // Only a device that just committed asks for an early cleanup, so the one whose commit tipped the count does it.
    if (!r.errors.length && cleanupDue({ autoCleanDays: this.settings.autoCleanDays, lastCleanup: rec.lastCleanup }, Date.now(), r.commits > 0 && (await engine.compactionDue()))) {
      await engine.gc();
      rec.lastCleanup = Date.now();
    }
    if (!share) await this.vaultChores();
    // A followed folder has no storage keys to change.
    if (hasMembers(share) && !share.followUrl) await this.takeRekey(share, engine);
    if (share && canSuggest(share)) forgetSent(share, r.unsent);
    if (share?.role === 'owner' && (why === 'manual' || Date.now() - (t.inboxLooked ?? 0) >= INBOX_EVERY)) await this.lookInbox(share);
    return r;
  }

  /** Owner: counts the suggestions waiting for `share`, for its row. One listing; best effort. */
  private async lookInbox(share: Share): Promise<void> {
    const t = this.tracked(share);
    t.inboxLooked = Date.now();
    try {
      const n = (await this.getEngine(share).inbox()).length;
      if (n === t.suggestions) return;
      t.suggestions = n;
      this.updateStatus();
    } catch {
      // The next sync looks again.
    }
  }

  /**
   * New storage keys the owner of `share` handed this device: kept once they work for it, here, and the engine made
   * again with them; otherwise this device carries on with its own, and says so once. Best effort: the next sync asks again.
   */
  private async takeRekey(share: Share, engine: SyncEngine): Promise<void> {
    const t = this.tracked(share);
    try {
      const repo = this.memberKeysOf(share).repo;
      const out = await followRekey(engine, {
        type: share.storageType,
        kept: keysOf(share, this.lookup),
        skip: rekeySkip(t.rekeyFailed, Date.now()),
        test: (keys) => testKeys(this.storeWith(share, keys), { repo, write: !share.readOnly, storageType: share.storageType }),
        keep: async (keys) => {
          this.keepKeys(share, keys);
          this.engines.delete(share.id);
        },
      });
      if (!out) return;
      const owner = t.standing?.owner || 'the owner';
      if (out.switched) {
        new Notice(`“${labelOf(share)}”: this device now uses the new storage keys from ${owner}.`, 10_000);
        return;
      }
      if (out.transient) return;
      const told = t.rekeyFailed?.n === out.n;
      t.rekeyFailed = { n: out.n, at: Date.now() };
      if (told) return;
      new Notice(
        this.fragment(`“${labelOf(share)}”: new storage keys did not work here`, `${owner} sent new storage keys, but they do not work on this device, so it keeps using its own. ${out.problem ?? ''}`),
        20_000,
      );
    } catch {
      // Storage may be down; the next sync asks again.
    }
  }

  /** What a shared folder with members tells about its failures; undefined for any other place. */
  private memberContext(share?: Share): MemberContext | undefined {
    return hasMembers(share) ? { owner: share.role === 'owner', ownerName: this.tracked(share).standing?.owner ?? '' } : undefined;
  }

  private failed(share: Share | undefined, e: unknown): Problem {
    const t = this.tracked(share);
    t.failure = describeFailure(e, this.memberContext(share));
    this.changes.failed(share);
    if (pausesOn(e)) {
      this.pauses.pause(keyOf(share));
      this.retries.reset(keyOf(share));
    } else {
      this.engines.delete(keyOf(share));
      this.retries.failed(keyOf(share), Date.now());
    }
    return t.failure;
  }

  /** One timer, for when the soonest wait after a failed sync ends: the syncs it held back are owed then. */
  private armRetry(): void {
    window.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const due = this.retries.due(Date.now());
    if (due === undefined) return;
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = undefined;
      void this.auto('retry');
    }, due - Date.now());
  }

  /**
   * A sync of the vault and then of the shared folders, while the caller holds `running`. The vault goes first and
   * alone, the shared folders after it a few at a time (see `syncAll`). One failing does not stop the rest.
   */
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
      // A place's failure is taken in as it ends, so its row says so while the others still sync.
      const failures = new Map<string, Problem>();
      const outcomes = await syncAll(
        this.settings,
        this.lookup,
        (share) => this.syncOne(share, share ? force === share.id : force === true, why),
        (share) => this.gate.includes(keyOf(share), why),
        {
          planned: (targets) => this.run.plan(targets.map(placeOfRun)),
          started: (share) => {
            this.run.start(placeOfRun(share));
            this.showRun();
          },
          ended: (share, error) => {
            if (error !== undefined) failures.set(keyOf(share), this.failed(share, error));
            this.run.end(placeOfRun(share));
            this.showRun();
          },
        },
      );
      const out: SyncOutcome = { shares: new Map() };
      for (const o of outcomes) {
        const one: SyncOutcome = 'error' in o ? { problem: failures.get(keyOf(o.target)) ?? this.failed(o.target, o.error) } : { result: o.result };
        if (o.target) out.shares!.set(o.target.id, one);
        else Object.assign(out, one);
      }
      if (manual && !inline) this.announce(outcomes, out.problem);
      this.tellArrivals(outcomes);
      await this.saveData(this.settings);
      return out;
    } finally {
      this.run.clear();
      this.progress = '';
      this.progressNotice?.hide();
      this.progressNotice = undefined;
      this.armRetry();
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
      else if (r.pushed || r.pulled || r.deletedLocal || r.deletedRemote || r.merged || r.conflictCopies.length || r.errors.length) lines.push(`“${labelOf(o.target)}”: ${summarize(r)}`);
    }
    if (lines.length) new Notice(`Sync: ${lines.join('\n')}`);
    if (vaultProblem?.id === 'offline') new Notice(this.fragment(vaultProblem.title, vaultProblem.detail), 10_000);
  }

  /**
   * After a sync that brought in other people's changes to shared folders: one notice, a line per folder, like "Lan
   * changed 3 notes in “Family”". Changes that come in while it shows join it, so someone typing away makes one notice,
   * not one per sync. Tapping it shows that folder's activity.
   */
  private tellArrivals(outcomes: Outcome<Share | undefined, SyncResult>[]): void {
    const now = Date.now();
    const recent = this.arrivals && now - this.arrivals.at < ARRIVALS_SHOWN ? this.arrivals : undefined;
    const all = new Map(recent?.byShare);
    let fresh = false;
    for (const o of outcomes) {
      if (!o.target || 'error' in o || !arrivalLine(labelOf(o.target), o.result.arrived, this.selfIn(o.target))) continue;
      all.set(o.target.id, [...(all.get(o.target.id) ?? []), ...o.result.arrived]);
      fresh = true;
    }
    if (!fresh) return;
    const told = this.settings.shares.filter((x) => all.has(x.id)).map((share) => ({ share, line: arrivalLine(labelOf(share), all.get(share.id)!, this.selfIn(share)) }));
    if (!told.length) return;
    recent?.notice.hide();
    const n = new Notice(this.fragment(told[0].line, [...told.slice(1).map((x) => x.line), 'Tap to see what changed.'].join('\n')), ARRIVALS_SHOWN);
    n.containerEl.addClass('coffer-notice');
    n.containerEl.addEventListener('click', () => {
      this.arrivals = undefined;
      const shares = told.map((x) => x.share);
      if (shares.length === 1) new ActivityModal(this.app, this, shares[0]).open();
      else pickTarget(this, 'Show recent changes in', (share) => share && new ActivityModal(this.app, this, share).open(), (share) => !!share && shares.includes(share));
    });
    this.arrivals = { notice: n, at: now, byShare: all };
  }

  /** What tells this device's own changes to `share` from others': its member, its name, and the member changes it holds (`changes`). */
  selfIn(share: Share, changes: MemberChange[] = []): Self {
    let member: string | undefined;
    try {
      member = share.memberKeysSecret ? this.memberKeysOf(share).id : undefined;
    } catch {
      // Keys missing here: nothing is this device's member's.
    }
    return { member, device: this.settings.deviceName, changes };
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
    const { kept, left } = await this.exclusive(share?.property ? 'Keeping the files…' : 'Keeping all files…', async () => {
      const engine = this.getEngine(share);
      const before = new Set((await engine.deferred()).map((f) => f.path));
      const kept = await engine.keepAllFiles();
      return { kept, left: (await engine.deferred()).filter((f) => !before.has(f.path)).length };
    });
    // Notes shared by a property put nothing back in the vault: the files stay in the share.
    new Notice(share?.property ? keptText(share.property, kept) : `Keeping all files${share ? ` in “${labelOf(share)}”` : ''}: ${keptNote(kept, left)}`);
    await this.sync(true);
  }

  /**
   * After the history in storage turned out not to be the one this device saw, as when storage was restored from a
   * backup: carries on from storage as it is now. Nothing is deleted; files that differ are merged or kept both ways.
   */
  async acceptStorage(share?: Share): Promise<void> {
    await this.exclusive('Carrying on from storage…', () => this.getEngine(share).acceptStorage());
    new Notice(
      share?.property
        ? `Carrying on from storage as it is now in “${share.property}”. Nothing is deleted; where files differ, your notes are sent again.`
        : `Carrying on from storage as it is now${share ? ` in “${share.folder}”` : ''}. Nothing is deleted; where files differ, both versions are kept.`,
    );
    await this.sync(true);
  }

  /** Slow (key derivation at the vault's cost), so callers make it before the tap that copies it: phones only allow a clipboard write inside the tap. */
  async setupLink(): Promise<string> {
    const iterations = codeIterations(await this.getEngine().kdfIterations().catch(() => undefined));
    return setupLink(await encodeSetupCode(this.settings, this.lookup, undefined, iterations));
  }

  /** A link that lets someone join `share`, encrypted with its passphrase. It suggests the folder's name. */
  async inviteLink(share: Share): Promise<string> {
    const iterations = codeIterations(await this.getEngine(share).kdfIterations().catch(() => undefined));
    return setupLink(await encodeSetupCode(share, this.lookup, fileName(share.folder), iterations));
  }

  /** With `readOnly`, this device never writes to storage; set before the first sync. */
  async importSetupCode(code: string, passphrase: string, readOnly = false): Promise<void> {
    const { settings, secrets } = await decodeSetupCode(code, passphrase, this.app.vault.getName());
    for (const [id, value] of secrets) this.app.secretStorage.setSecret(id, value);
    Object.assign(this.settings, settings, { readOnly });
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

  /**
   * The new passphrase waits under a secret of its own until storage is known to take it. When the connection fails
   * before storage could say (`PassphraseUnknownError`), it stays there, and the vault's next open tries both and keeps
   * the one that works (`settlePassphrase`).
   */
  async changePassphrase(next: string): Promise<void> {
    const pending = this.pendingPassphrase();
    if (this.secret(pending)) throw new Error('An earlier change of the passphrase is not confirmed yet. Sync first: that settles it.');
    this.app.secretStorage.setSecret(pending, next);
    try {
      await this.getEngine().changePassphrase(next);
      this.settlePassphrase(next);
    } catch (e) {
      if (!(e instanceof PassphraseUnknownError)) this.forgetSecret(pending);
      throw e;
    } finally {
      this.engines.delete('');
    }
  }

  private pendingPassphrase(): string {
    return secretName('coffer-passphrase-next', this.app.vault.getName());
  }

  /** Storage opens with `passphrase`: it is the vault's from now on, and a change that waited for that is settled. */
  private settlePassphrase(passphrase: string): void {
    const id = this.settings.passphraseSecret;
    if (this.secret(id) !== passphrase) this.app.secretStorage.setSecret(id, passphrase);
    const pending = this.pendingPassphrase();
    if (this.secret(pending)) this.forgetSecret(pending);
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

  /** Forgets a share's sync state. Its member list, if it has one, stays: see `positionPath`. */
  private removeState(share: Share): Promise<void> {
    return new PluginState(this.app, statePath(this.pluginDir(), share.id)).remove();
  }

  /** Every secret a setting of the vault or of a share names. */
  private secretsInUse(): Set<string> {
    const s = this.settings;
    const names: string[] = [s.accessKeySecret, s.secretKeySecret, s.passphraseSecret, s.webdavPasswordSecret];
    for (const x of s.shares) for (const k of SHARE_SECRETS) names.push(x[k]);
    return new Set(names.filter(Boolean));
  }

  /**
   * Empties a secret no setting names any more, and takes it off the keychain's list where this version of Obsidian
   * can (`deleteSecret` is not in its published API, so it may be missing).
   */
  private forgetSecret(name: string): void {
    const store = this.app.secretStorage as SecretStorage & { deleteSecret?: (id: string) => unknown };
    try {
      store.setSecret(name, '');
      if (typeof store.deleteSecret === 'function') store.deleteSecret(name);
    } catch {
      // The setting no longer points at it, which is what matters.
    }
  }

  /**
   * Adds a shared folder, creating its folder when missing, and stores its secrets. Waits for any sync to finish
   * first: a sync of the vault that began before must not see the folder taken away from it halfway. The vault's next
   * sync offers it to the vault's other devices (offers.ts), unless it came from such an offer (`offered`) or this
   * device never writes to the vault's storage.
   */
  async addShare(share: Share, secrets: [string, string][], offered = false): Promise<void> {
    await this.exclusive('Adding the shared folder…', () => this.placeShare(share, secrets, offered));
  }

  /**
   * Starts a shared folder with members in `share`'s storage, which must be empty, with this device as its owner,
   * `owner` being the name members see, and adds it as `addShare` does. Storage is written only once every check has
   * passed and the folder is there, and the keys are kept right after, with nothing to wait for in between: closing the
   * screen meanwhile can not leave a shared folder whose keys nobody has.
   */
  async startMemberShare(share: Share, secrets: [string, string][], owner: string, passphrase: string): Promise<void> {
    await this.exclusive('Starting the shared folder…', () =>
      this.placeShare(share, secrets, false, async () => {
        const values = new Map(secrets);
        const store = openRemote(remoteSpec(share, (n) => values.get(n) ?? ''), obsidianHttp);
        const keys = await createMemberShare(store, { owner, device: this.settings.deviceName, passphrase, kdfIterations: DEFAULT_CONFIG.kdfIterations, chunk: DEFAULT_CONFIG.chunk });
        return [[share.memberKeysSecret, JSON.stringify(keys)]];
      }),
    );
  }

  /** What `addShare` and `startMemberShare` do while no sync runs. `start` runs last before anything is kept, and gives secrets to keep too. */
  private async placeShare(share: Share, secrets: [string, string][], offered: boolean, start?: () => Promise<[string, string][]>): Promise<void> {
    const s = this.settings;
    // Notes shared by a property stay where they are: no folder to make, nothing to take out of the vault, and offered to
    // no other device, since only this one sends them.
    const problem =
      (share.property ? startProblem(s, share.property) : folderProblem(s, share.folder, this.app.vault.configDir, this.pluginDir(), '', await this.propertyHeld())) ||
      storageProblem(s, share);
    if (problem) throw new Error(problem);
    if (!share.property) {
      share.folder = await this.ensureFolder(share.folder);
      await takeVaultCopies(this.host(), share);
    }
    const more = start ? await start() : [];
    this.engines.clear();
    for (const [id, value] of [...secrets, ...more]) this.app.secretStorage.setSecret(id, value);
    share.offerPending = share.property || offered || s.readOnly ? '' : 'add';
    s.shares.push(share);
    await this.saveSettings();
  }

  /** Whether a file has a vault path, by key, as the vault's index has it. The index is read on the first question. */
  private localKeys(): (key: string) => boolean {
    let keys: Set<string> | undefined;
    return (key) => (keys ??= new Set(this.app.vault.getFiles().map((f) => vaultKey(f.path)))).has(key);
  }

  /**
   * Stops syncing `share` on this device. Its files stay where they are and from then on sync with the vault, with
   * nothing deleted on either side (see `rejoin`). Its secrets and sync state are forgotten here; nothing is deleted
   * from its storage. With `withdraw`, the vault's other devices are no longer offered it (offers.ts); returns why
   * that could not be done, if it could not.
   */
  async stopSharing(share: Share, withdraw = false): Promise<string | undefined> {
    let notWithdrawn: string | undefined;
    await this.exclusive('Stopping…', async () => {
      const s = this.settings;
      let remote: Set<string> | undefined;
      let view: RepoView | undefined;
      try {
        view = await this.getEngine().view();
        remote = new Set(view.st.remote.keys());
      } catch {
        // Offline: what the vault's state last saw of storage stands in.
      }
      if (withdraw) {
        try {
          if (!view) throw new Error('Could not reach this vault’s storage');
          await withdrawOffers(view.repo, share, this.offers);
        } catch (e) {
          notWithdrawn = errorText(e);
        }
      }
      // Still offered to the other devices, it is not offered back to this one, which just stopped it.
      for (const id of withdraw && notWithdrawn === undefined ? [] : [share.id, ...offersOf(share, this.offers)]) if (!s.offersHidden.includes(id)) s.offersHidden.push(id);
      // No vault engine may save its own copy of the state over what `rejoin` writes.
      this.engines.clear();
      // Notes shared by a property never left the vault's sync: nothing to take back.
      if (!share.property) await rejoin(this.host(), share, this.localKeys(), remote);
      this.surveys.delete(share.id);
      s.shares = s.shares.filter((x) => x.id !== share.id);
      const inUse = this.secretsInUse();
      for (const k of SHARE_SECRETS) {
        const name = share[k];
        if (name && !inUse.has(name)) this.forgetSecret(name);
      }
      this.tracking.delete(share.id);
      this.pauses.lift(share.id);
      this.retries.reset(share.id);
      await this.removeState(share);
      await new PluginState(this.app, positionPath(this.pluginDir(), share.id)).remove();
      await this.saveSettings();
    });
    this.report();
    // Its files are the vault's to sync now, and no vault event says so.
    this.dirty = true;
    this.schedule();
    return notWithdrawn;
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

  /**
   * A link that lets someone join `share` and only receive changes, with `keys` that were made to read only: see
   * `readOnlyInviteCode`.
   */
  async readOnlyInviteLink(share: Share, keys: Keys & { user: string }): Promise<string> {
    const iterations = codeIterations(await this.getEngine(share).kdfIterations().catch(() => undefined));
    return setupLink(await readOnlyInviteCode(share, keys, this.lookup, fileName(share.folder), iterations));
  }

  // Shared folders with members (`members.ts`, and `membership.ts` in core).

  /** This device's keys to `share`, a shared folder with members. */
  memberKeysOf(share: Share): MemberKeys {
    return memberKeysIn(share, this.lookup);
  }

  /** What this device is in `share`, as of its last sync; undefined before one, or for a share without members. */
  standingOf(share: Share): MemberStanding | undefined {
    return this.tracked(share).standing;
  }

  /** A store that reaches `share`'s storage with `keys` instead of the ones kept, for trying them. */
  private storeWith(share: Share, keys: KeySet) {
    const { storage, secret } = withKeys(share, keys);
    return openRemote(remoteSpec(storage, secret), obsidianHttp);
  }

  /**
   * Keeps `keys` as the ones this device reaches `share`'s storage with. A secret that the vault or another share also
   * names is left to them, and the share gets one of its own.
   */
  private keepKeys(share: Share, keys: KeySet): void {
    const vault = this.app.vault.getName();
    const others = new Set([this.settings, ...this.settings.shares.filter((x) => x.id !== share.id)].flatMap((x) => [x.accessKeySecret, x.secretKeySecret, x.webdavPasswordSecret]));
    const put = (key: 'accessKeySecret' | 'secretKeySecret' | 'webdavPasswordSecret', base: string, value: string) => {
      const name = share[key] && !others.has(share[key]) ? share[key] : shareSecretName(base, vault, share.id);
      this.app.secretStorage.setSecret(name, value);
      share[key] = name;
    };
    if (share.storageType === 'webdav') {
      share.webdavUser = keys.user.trim() || share.webdavUser;
      put('webdavPasswordSecret', IDS.password, keys.password);
    } else {
      put('accessKeySecret', IDS.access, keys.access.trim());
      put('secretKeySecret', IDS.secret, keys.secret.trim());
    }
    // An offer of it kept in the vault's storage carries the old keys.
    if (!share.offerPending && !this.settings.readOnly && !share.property) share.offerPending = 'update';
  }

  /** The id of the vault or shared folder `share`'s storage should hold: from its keys, or as its last sync saw it; undefined before one. */
  private async knownRepo(share: Share): Promise<string | undefined> {
    if (share.memberKeysSecret) return this.memberKeysOf(share).repo;
    const st = LocalState.parse(await new PluginState(this.app, statePath(this.pluginDir(), share.id)).load());
    return st.vaultId || undefined;
  }

  /**
   * Joins a shared folder with members with a member's invite: its keys are kept and the share added before this
   * device asks the owner's to confirm it (`joinWithInvite`). When another device used the invite first, the share is
   * taken off again and the error thrown. Returns whether the request to confirm went out; the next sync sends it if not.
   */
  async joinMember(share: Share, secrets: [string, string][], invite: MemberInvite): Promise<boolean> {
    const values = new Map(secrets);
    const store = openRemote(remoteSpec(share, (n) => values.get(n) ?? ''), obsidianHttp);
    let added = false;
    try {
      const { sent } = await joinWithInvite(store, invite, async (keys) => {
        await this.addShare(share, [...secrets, [share.memberKeysSecret, JSON.stringify(keys)]]);
        added = true;
      });
      return sent;
    } catch (e) {
      if (added && isUsedError(e)) await this.stopSharing(share);
      throw e;
    }
  }

  /** Every member of `share` and how each stands, as its owner's device sees it, with storage brought up to date. */
  async members(share: Share): Promise<MemberStatus[]> {
    return this.getEngine(share).members();
  }

  /**
   * Owner: invites `name` to `share` for `days`. A read invite carries `read`, keys made to read only (`suggest`: and
   * to add suggestions, which marks the member as one who sends them), tested first; a write invite carries this
   * device's own. Returns the link, ready to copy.
   */
  async invite(share: Share, o: { name: string; role: 'write' | 'read'; days: number; read?: KeySet; suggest?: boolean }): Promise<{ link: string; expires: number }> {
    const refused = inviteProblem(share, o.role);
    if (refused) throw new Error(refused);
    const keys = this.memberKeysOf(share);
    const reach = o.role === 'read' ? withKeys(share, o.read!) : { storage: share, secret: this.lookup };
    if (o.role === 'read') await testKeys(this.storeWith(share, o.read!), { repo: keys.repo, write: false, onlyRead: mustNotWrite(share, !!o.suggest), storageType: share.storageType });
    const expires = expiresIn(o.days, Date.now());
    const suggest = o.role === 'read' && !!o.suggest;
    const grant = await this.exclusive('Making an invite…', () => this.getEngine(share).invite({ name: o.name, role: o.role, expires, suggest }));
    const name = share.property || fileName(share.folder);
    const invite: MemberInvite = { ...grant, storage: storagePayload(reach.storage, reach.secret), share: name, folder: name };
    return { link: setupLink(encodeInvite(invite)), expires };
  }

  /**
   * Owner: a link that sets up another of the owner's devices for `share`, sealed with its passphrase. It carries the
   * owner's keys. Slow, so it is made before the tap that copies it.
   */
  async ownerLink(share: Share): Promise<string> {
    if (share.property) throw new Error('Notes shared by a property are sent from this device only, so there is no link for your other devices.');
    const keys = this.memberKeysOf(share);
    const iterations = codeIterations(await this.getEngine(share).kdfIterations().catch(() => undefined));
    return setupLink(await encodeSetupCode({ ...share, readOnly: false }, this.lookup, fileName(share.folder), iterations, ownerLinkFields(keys)));
  }

  /**
   * Owner: a follow link to `share`, read from public address `url`, which is checked to serve this folder first. Its
   * member, named `name`, reads with no storage keys, and its link never expires.
   */
  async followLink(share: Share, o: { name: string; url: string }): Promise<string> {
    const keys = this.memberKeysOf(share);
    const url = o.url.trim();
    await checkFollowAddress(openRemote({ type: 'follow', url }, obsidianHttp), keys.repo);
    const grant = await this.exclusive('Making a follow link…', () => this.getEngine(share).invite({ name: o.name, role: 'read', expires: 0, follow: true }));
    const name = share.property || fileName(share.folder);
    return setupLink(encodeFollow({ repo: grant.repo, member: grant.member, secret: grant.secret, owner: grant.owner, since: grant.since, url, share: name, folder: name }));
  }

  /** Follows a shared folder with a follow link: opens it at its public address for its keys, kept with the share as it is added. */
  async joinFollow(share: Share, invite: FollowInvite): Promise<void> {
    const keys = await joinShare(openRemote({ type: 'follow', url: invite.url }, obsidianHttp), invite);
    await this.addShare(share, [[share.memberKeysSecret, JSON.stringify(keys)]]);
  }

  /** Owner: confirms the devices that joined `share` to write, so they may send changes. Returns how many. */
  async confirmJoins(share: Share): Promise<number> {
    return (await this.exclusive('Confirming…', () => this.getEngine(share).confirmJoins())).length;
  }

  /** Owner: removes member `id` from `share`. */
  async removeMember(share: Share, id: string): Promise<void> {
    await this.exclusive('Removing a member…', () => this.getEngine(share).removeMember(id));
  }

  /**
   * Owner: takes out of `share`'s storage the changes at the end of its log that no member who may write made, so that
   * syncing carries on (`SyncEngine.removeUnverifiable`). Returns how many were removed.
   */
  async removeUnverifiable(share: Share): Promise<number> {
    const removed = await this.exclusive('Removing changes…', () => this.getEngine(share).removeUnverifiable());
    this.tracked(share).failure = undefined;
    this.pauses.lift(share.id);
    this.retries.reset(share.id);
    this.report();
    void this.sync(true);
    return removed.length;
  }

  /**
   * Owner: hands `write` (`read` to those who only read, named in `readers`, and `suggest` to those who also send
   * suggestions, named in `suggesters`) to every device of `share`, each tested against it first, and switches this
   * device to `write`. Returns when that is done; the others switch at their next sync.
   */
  async rekey(share: Share, o: { write: KeySet; read?: KeySet; readers: string[]; suggest?: KeySet; suggesters: string[] }): Promise<void> {
    if (share.readOnly) throw new Error('This device only receives changes for this folder. Turn that off first: handing out keys writes to its storage.');
    const repo = this.memberKeysOf(share).repo;
    await this.exclusive('Handing out new storage keys…', () =>
      rekey(this.getEngine(share), {
        type: share.storageType,
        ...o,
        current: keysOf(share, this.lookup),
        test: (keys, use) => testKeys(this.storeWith(share, keys), { repo, ...rekeyTest(share, use), storageType: share.storageType }),
      }),
    );
    this.keepKeys(share, o.write);
    await this.saveSettings();
  }

  /**
   * Replaces the storage keys this device uses for `share`, once they reach the same shared folder and, for a device
   * that sends changes, may write there.
   */
  async changeKeys(share: Share, keys: KeySet): Promise<void> {
    await this.exclusive('Checking the keys…', async () => {
      await testKeys(this.storeWith(share, keys), { repo: await this.knownRepo(share), write: !share.readOnly, storageType: share.storageType });
      this.keepKeys(share, keys);
      await this.saveSettings();
    });
    this.tracked(share).failure = undefined;
    this.retries.reset(share.id);
    this.report();
  }

  // Suggestions (`suggestions.ts`, and `suggest.ts` in core).

  /** Whether this device can send `share`'s owner what it changed, as a suggestion. */
  canSuggest(share: Share): boolean {
    return canSuggest(share);
  }

  /** The files changed here in `share` and not sent, as of its last sync, by their path inside it. */
  unsentOf(share: Share): string[] {
    const files = this.tracked(share).found.find((p) => p.id === 'unsent')?.files ?? [];
    return files.map((path) => this.placeOf(path)).filter((p) => p.share === share).map((p) => p.path);
  }

  /**
   * Sends the files at `paths` (inside `share`) to its owner as one suggestion, leaving out what was sent before and is
   * unchanged since. Throws when storage refuses it (see `isRefused`).
   */
  async sendSuggestion(share: Share, paths: string[]): Promise<SuggestOutcome> {
    const out = await this.getEngine(share).sendSuggestion(paths, sentBefore(share));
    if (out.sent.length) {
      recordSent(share, out);
      await this.saveData(this.settings);
      this.updateStatus();
    }
    return out;
  }

  /** Owner: how many suggestions wait for `share`, as of the last look; 0 before one. */
  suggestionCount(share: Share): number {
    return this.tracked(share).suggestions ?? 0;
  }

  /** Owner: the newest suggestions waiting for `share`, opened, and how many more wait; the count on its row follows. */
  async suggestions(share: Share): Promise<WaitingSuggestions> {
    const found = await this.getEngine(share).suggestions();
    const t = this.tracked(share);
    t.inboxLooked = Date.now();
    const total = found.items.length + found.more;
    if (t.suggestions !== total) {
      t.suggestions = total;
      this.updateStatus();
    }
    return found;
  }

  /**
   * The file at `path` inside `share` as it is now, any editor of it saved first: its size and time, and its bytes when
   * small enough to compare; undefined when there is none.
   */
  async currentFile(share: Share, path: string): Promise<Snapshot | undefined> {
    const { fs } = this.scope(share);
    const at = (await this.localPaths(share)).get(vaultKey(path)) ?? path;
    await this.saveEditorOf(fs.pathOf(at));
    const stat = await fs.stat(at);
    if (!stat) return undefined;
    return { size: stat.size, mtime: stat.mtime, ...(stat.size <= MAX_COMPARE_BYTES && { data: await fs.read(at) }) };
  }

  /**
   * Owner: takes a suggested file in, writing `data` at `path` (inside `share`; where it is now, if it moved since), unless
   * that file changed since it was `shown`; then the file `suggested` of suggestion `key` counts as dealt with. The next
   * sync sends it as this device's change. False when the file changed meanwhile, and nothing was written.
   */
  async acceptSuggested(share: Share, key: string, suggested: string, path: string, data: Uint8Array, shown: Snapshot | undefined): Promise<boolean> {
    if (!unchangedSince(shown, await this.currentFile(share, path))) return false;
    const at = (await this.localPaths(share)).get(vaultKey(path)) ?? path;
    await this.writeFile(share, at, data);
    await this.settleSuggested(share, key, suggested);
    return true;
  }

  /** Owner: file `path` of suggestion `key` was dealt with, taken in or left out. */
  async settleSuggested(share: Share, key: string, path: string): Promise<void> {
    await this.getEngine(share).settleSuggestion(key, path);
    await this.lookInbox(share);
  }

  /** Owner: takes suggestion `key` out of storage whole. */
  async dismissSuggestion(share: Share, key: string): Promise<void> {
    await this.getEngine(share).dismissSuggestion(key);
    await this.lookInbox(share);
  }

  /** How many files are left in storage until asked for, in the vault and in each shared folder that syncs, as of its last sync; undefined before it has run since the app started. */
  deferredCounts(): (number | undefined)[] {
    return this.targets().map((share) => this.tracked(share).deferred?.length);
  }

  /** Downloads the files at `paths` (inside `share`, or the vault's) that are left in storage, with a sync of that place. */
  async fetchDeferred(paths: string[], share?: Share): Promise<SyncOutcome> {
    const clash = locationClash(this.settings, share);
    if (clash) return { problem: { id: 'location', severity: 'critical', title: 'Nothing was downloaded', detail: clash } };
    return this.exclusive('Downloading…', async () => {
      try {
        return { result: await this.syncOne(share, false, 'manual', paths) };
      } catch (e) {
        return { problem: this.failed(share, e) };
      } finally {
        await this.saveData(this.settings);
        this.report();
      }
    });
  }

  async checkStorage(): Promise<void> {
    if (!hasStorageAddress(this.settings)) {
      new Notice('Fill in the storage address first.');
      return;
    }
    const checking = new Notice('Checking the storage…', 0);
    let report: Awaited<ReturnType<typeof checkStore>>;
    try {
      report = await checkStore(this.store(), this.settings.readOnly);
    } finally {
      checking.hide();
    }
    const bad = report.checks.find((c) => !c.ok);
    if (!bad) new Notice('Storage works: all checks passed.', 5000);
    else new Notice(this.fragment('Storage check failed', connectError(bad.detail ?? bad.name, this.settings.storageType)), 20_000);
  }

  /** Cleans up the vault's storage and every shared folder's. Syncs, and changes to shared folders, wait meanwhile. */
  private async cleanUp(): Promise<void> {
    if (!this.configured()) return;
    const total: GcResult = { packsDeleted: 0, bytesFreed: 0, snapshotsDeleted: 0, packsCombined: 0, packsWritten: 0, bytesMoved: 0, bytesFreedLater: 0 };
    const failed: string[] = [];
    const targets = this.targets().filter((share) => !(share ?? this.settings).readOnly);
    if (!targets.length) {
      new Notice('This device only receives changes, so it does not clean up storage.');
      return;
    }
    await this.exclusive('Cleaning up storage…', async () => {
      for (const share of targets) {
        try {
          const r = await this.getEngine(share).gc();
          for (const k of Object.keys(total) as (keyof GcResult)[]) total[k] += r[k];
        } catch (e) {
          failed.push(`${share ? `“${labelOf(share)}”` : 'This vault'}: ${errorText(e)}`);
        }
      }
    });
    if (failed.length < targets.length) new Notice(describeCleanup(total), 10_000);
    if (failed.length) new Notice(`Clean-up failed.\n${failed.join('\n')}`, 10_000);
  }

  /** Stores again, from this device's files, the data `share`'s storage (the vault's when none) lost. Syncs wait meanwhile. */
  repair(share: Share | undefined, deep: boolean, onProgress?: RepairOptions['onProgress']): Promise<RepairReport> {
    return this.exclusive('Repairing synced data…', () => this.getEngine(share).repair({ deep, onProgress }));
  }

  /** The file table is copied before anything else is awaited: a sync waiting on the engine may change it from then on. */
  async look(share?: Share): Promise<Look> {
    const v = await this.getEngine(share).view();
    return { repo: v.repo, remote: new Map(v.st.remote), lastSeq: v.st.lastSeq, cfg: v.cfg, now: v.now, members: [...v.st.members] };
  }

  /**
   * Paths no restore touches. In the vault: excluded from sync here (shared folders among them), the plugin's own
   * folder, and the settings folder when it does not sync. In a shared folder: what its sync leaves out.
   */
  keptOut(share?: Share): (path: string) => boolean {
    const dir = this.app.vault.configDir;
    if (share?.property) return keepOut(propertyConfig(this.settings, dir, this.pluginDir()).exclude, []);
    if (share) return keepOut(shareConfig(this.settings, share, dir).exclude, []);
    const own = this.pluginDir();
    return keepOut(syncConfig(this.settings, dir, own).exclude, this.settings.syncConfigDir ? [own] : [own, dir]);
  }

  /** As `keptOut` for files, and with those left in storage until asked for, which the engine lists now, not as of the last sync. */
  keptOutFiles(share?: Share): Promise<(path: string) => boolean> {
    return keepDeferred(this.keptOut(share), this.getEngine(share));
  }

  /** The files of the vault, or of a shared folder, by key, with the path each has there. */
  private async localPaths(share?: Share): Promise<Map<string, string>> {
    // Notes shared by a property are at their vault paths.
    if (share?.property) return new Map(this.app.vault.getFiles().map((f) => [vaultKey(f.path), f.path]));
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
    if (share?.property) data = await this.intoProperty(share, full, data);
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

  /** Puts `version` in place of the file at vault path `path`, or brings it back if there is none; the next sync sends it, unless the place only receives. */
  async restoreVersion(path: string, version: Version): Promise<void> {
    if (!version.entry) return;
    const { share, path: inside } = this.placeOf(path);
    await this.writeFile(share, inside, await this.getEngine(share).readVersion(version.entry));
    new Notice(`Restored “${fileName(path)}” as it was ${momentLabel(version.time, Date.now())}.${this.receivesOnly(share) ? ` ${sentNote(1, true)}` : ''}`);
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
    const outcome: ({ path: string; to: string } | Failed)[] = new Array<{ path: string; to: string } | Failed>(files.length);
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

  /** Saves what any open editor of vault path `path` holds. An editor with nothing unsaved writes nothing. */
  private async saveEditorOf(path: string): Promise<void> {
    const saving: Promise<void>[] = [];
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof TextFileView && leaf.view.file && vaultKey(leaf.view.file.path) === vaultKey(path)) saving.push(leaf.view.save());
    });
    await Promise.all(saving);
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
    if (this.receivesOnly(share)) {
      const problem: Problem = {
        id: 'read-only',
        severity: 'critical',
        title: 'This device only receives changes',
        detail: 'A restore changes files that would then have to be sent to storage, which this device never writes to. Restore from a device that sends changes, or turn off Only receive changes here.',
      };
      return { problem, done: [], failed: [] };
    }
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
      const kept = await this.keptOutFiles(share);
      const { st, cfg } = await engine.view();
      const { steps } = restoreSteps(planRestore(st.remote, target, folder), st.remote, kept);
      if (!sameSteps(steps, expected)) return { changed: steps, done: [], failed: [] };
      const synced = st.synced.size;
      const last = new Map([...st.synced].map(([key, s]) => [key, { lsize: s.lsize, lmtime: s.lmtime }]));

      const here = await this.localPaths(share);
      const at = (path: string) => here.get(path) ?? path;
      const { done, failed } = await applyRestore(
        steps,
        last,
        {
          // Typing in an open note reaches the disk only when its editor saves: save it first, or the check below
          // would pass and the restore would overwrite what was typed.
          stat: async (path) => {
            await this.saveEditorOf(fs.pathOf(at(path)));
            return fs.stat(at(path));
          },
          write: (path, data) => this.writeFile(share, at(path), data),
          remove: (path) => fs.remove(at(path)),
          read: (entry) => engine.readVersion(entry),
        },
        4,
        (kind, n, total) => this.say(`${kind === 'remove' ? 'Removing' : 'Restoring'} ${n.toLocaleString()} of ${total.toLocaleString()}`),
      );
      this.files?.forgetConfigListing();
      const removed = done.filter((s) => s.kind === 'remove').map((s) => s.path);
      const rec = share ?? this.settings;
      rec.restored = [...new Set([...rec.restored, ...removed])];
      // Kept before the sync that sends them, which may fail: whichever sync goes through next sends them as confirmed.
      await this.saveData(this.settings);
      this.say('Sending the result to storage…');
      const sent = this.outcomeOf(await this.syncHeld(true, false, true, 'manual'), share);
      return { done, failed, sent, olderPause: deleteLimitCrossed(done.length - removed.length, removed.length, synced, cfg) !== undefined };
    });
  }

  // Notes shared by a property (byproperty.ts): one per vault, sent only from this device.

  /** Obsidian has read the vault: new notes may join from now on, and screens waiting for that look again. */
  private catalogReady(): void {
    if (this.catalog.ready()) return;
    this.catalog.markReady();
    this.updateStatus();
    if (this.propertyShare()) this.schedule();
  }

  /** The notes this vault shares by a property, if it does. */
  propertyShare(): Share | undefined {
    return this.settings.shares.find((s) => s.property);
  }

  /** The id of the notes shared by a property that a change at vault path `path` concerns: a file they hold, or a note they show. */
  private propertyOf(path: string): string[] {
    return propertyPlaces(this.settings.shares, path).filter((id) => {
      const survey = this.surveys.get(id);
      return !survey || survey.held.has(vaultKey(path)) || survey.shared.has(vaultKey(path));
    });
  }

  private propertyIds(): string[] {
    return this.settings.shares.filter((s) => s.property).map((s) => s.id);
  }

  /** What the last sync of `share`, notes shared by a property, found; undefined before one in this session. */
  surveyOf(share: Share): Survey | undefined {
    return this.surveys.get(share.id);
  }

  /** The files notes shared by a property hold here, as the last sync found them: a shared folder may not take any. */
  propertyFiles(): string[] {
    return [...this.surveys.values()].flatMap((v) => [...new Set([...v.held, ...v.shared.keys()])]);
  }

  /** As `propertyFiles`, also from storage when no sync has looked yet. */
  private async propertyHeld(): Promise<string[]> {
    const share = this.propertyShare();
    if (!share || !syncable(share, this.lookup) || this.surveys.has(share.id)) return this.propertyFiles();
    try {
      const { st } = await this.getEngine(share).view();
      return [...new Set([...st.synced.keys(), ...st.remote.keys()])];
    } catch {
      return this.propertyFiles();
    }
  }

  /** What `share` holds and would take in now, read without syncing, for "What's shared". */
  async lookAtShared(share: Share): Promise<Survey> {
    return (this.scope(share).fs as PropertyFS).peek(await this.getEngine(share).held());
  }

  /** What starting notes shared by a property named `name` would send now. */
  previewProperty(name: string): Promise<Survey> {
    const config = propertyConfig(this.settings, this.app.vault.configDir, this.pluginDir());
    this.notes ??= new ObsidianFS(this.app, false, () => []);
    const fs = new PropertyFS({ inner: this.notes, catalog: this.catalog, share: () => ({ property: name.trim(), removed: [], approved: [], ask: [] }), excluded: compileExcludes(config.exclude) });
    return fs.preview();
  }

  /**
   * After a sync of notes shared by a property: stops when another device signed as this one; keeps the sharer's
   * choices that still matter; tells what changed. Returns what waits for the sharer, as problems.
   */
  private async afterProperty(share: Share, engine: SyncEngine, r: SyncResult): Promise<Problem[]> {
    const other = otherSender(r.arrived, this.memberKeysOf(share).id, this.settings.deviceName);
    if (other) throw new OtherSenderError(other);
    const survey = (this.scope(share).fs as PropertyFS).survey();
    if (!survey) return [];
    // Listed before the sync, which deleted most of them for everyone: what is left stays in the share.
    const held = await engine.held();
    survey.stored = survey.stored.filter((k) => held.get(k));
    this.surveys.set(share.id, survey);
    Object.assign(share, settleChoices(share, this.localKeys(), survey.held));
    this.tellProperty(share, survey, r);
    return propertyProblems(share.property, survey);
  }

  /** Notices after a sync of notes shared by a property: new notes sent, notes that stopped saying share, files no note shows. */
  private tellProperty(share: Share, survey: Survey, r: SyncResult): void {
    const failed = new Set(r.errors.map((e) => vaultKey(e.path)));
    const sent = r.commits ? survey.fresh.filter((k) => isNote(k) && !failed.has(k)) : [];
    const open = () => new WhatsSharedModal(this.app, this, share).open();
    const notice = (title: string, detail: string) => {
      const n = new Notice(this.fragment(title, detail), 15_000);
      n.containerEl.addClass('coffer-notice');
      n.containerEl.addEventListener('click', open);
    };
    if (sent.length) notice(sentNotesText(share.property, sent), 'Tap to see what is shared.');
    const fresh = (keys: string[], tag: string) => keys.filter((k) => !this.told.has(`${tag}:${k}`));
    const unmarked = fresh(survey.unmarked, 'unmarked');
    if (unmarked.length) notice(unmarkedText(share.property, unmarked), 'What you change in it is not sent until you choose. Tap to choose.');
    const unused = fresh(survey.unused, 'unused');
    if (unused.length) notice(unusedText(share.property, unused), 'Tap to remove them.');
    for (const k of unmarked) this.told.add(`unmarked:${k}`);
    for (const k of unused) this.told.add(`unused:${k}`);
  }

  /**
   * The attachments in `share` that the note at `note` shows and no other shared note mentions by name, read from each
   * note's bytes now. None until Obsidian has read the vault, so that the box to remove them waits until then.
   */
  async filesOnlyIn(share: Share, note: string): Promise<string[]> {
    if (!this.catalog.ready()) return [];
    const survey = await this.lookAtShared(share);
    const key = vaultKey(note);
    const shows = new Set(this.catalog.embeds(note).flatMap((e) => (e.target && survey.shared.has(vaultKey(e.target)) && isAttachment(vaultKey(e.target)) ? [vaultKey(e.target)] : [])));
    if (!shows.size) return [];
    const fs = this.scope(share).fs as PropertyFS;
    const others: { key: string; text: string }[] = [];
    for (const [k, f] of survey.shared) if (isNote(k) && k !== key) others.push({ key: k, text: new TextDecoder().decode(await fs.read(f.path)) });
    // A note that no longer says share is still in the share, and may show them too.
    for (const k of survey.unmarked) if (k !== key) others.push({ key: k, text: new TextDecoder().decode(await fs.read(k)) });
    return onlyShownBy(key, [...shows], others);
  }

  /** Shares `file` in `share` (its properties say share: <name> from now on, and nothing keeps it out), saying how it went. */
  async shareNoteSaying(share: Share, file: TFile): Promise<void> {
    try {
      await this.shareNote(share, file);
      new Notice(`“${file.basename}” is added to “${share.property}” at the next sync.`);
    } catch (e) {
      new Notice(errorText(e), 10_000);
    }
  }

  /** Writes share: <name> into the properties of `file`, and lets it join again if it was taken out. */
  async shareNote(share: Share, file: TFile): Promise<void> {
    const problem = this.joinProblemOf(share, file.path);
    if (problem) throw new Error(problem);
    await this.saveEditorOf(file.path);
    if (!(await this.editProperties(file, (text) => withShare(text, share.property)))) {
      throw new Error(`The properties of “${file.basename}” could not be read, so share: ${share.property} was not added. Fix them, or add it by hand.`);
    }
    await this.shareFiles(share, [file.path]);
  }

  /** Whether the note at `path` is in `share` or joins it at the next sync; with `unmarked`, also one that no longer says so. */
  private noteIn(share: Share, path: string, unmarked = false): boolean {
    return noteInShare(vaultKey(path), share, this.surveys.get(share.id), this.catalog.says(path, share.property), unmarked);
  }

  /** Why the note at `path` can not join `share` by its property, or '' when it can. */
  private joinProblemOf(share: Share, path: string): string {
    return joinProblem(vaultKey(path), share.property, { folder: this.placeOf(path).share?.folder, excluded: this.keptOut(share) });
  }

  /** Rewrites a note's text with `edit`, unless that leaves it as it is. False when `edit` could not read its properties. */
  private async editProperties(file: TFile, edit: (text: string) => string | undefined): Promise<boolean> {
    const text = await this.app.vault.read(file);
    const now = edit(text);
    if (now === undefined) return false;
    // Written by `process`, which reads the note again: nothing typed in between is lost.
    if (now !== text) await this.app.vault.process(file, (t) => edit(t) ?? t);
    return true;
  }

  /** Lets files at `paths` join `share`: not kept out any more, and an attachment said yes to. */
  async shareFiles(share: Share, paths: string[]): Promise<void> {
    const keys = new Set(paths.map(vaultKey));
    share.removed = share.removed.filter((k) => !keys.has(vaultKey(k)));
    share.ask = share.ask.filter((k) => !keys.has(vaultKey(k)));
    share.approved = [...new Set([...share.approved, ...[...keys].filter((k) => !isNote(k))])];
    await this.saveSettings();
    this.dirty = true;
    this.schedule();
  }

  /** Keeps the attachments at `paths` out of `share`, as waiting ones the sharer said no to. */
  async keepOutOf(share: Share, paths: string[]): Promise<void> {
    const keys = new Set(paths.map(vaultKey));
    share.removed = [...new Set([...share.removed, ...keys])];
    share.ask = share.ask.filter((k) => !keys.has(vaultKey(k)));
    share.approved = share.approved.filter((k) => !keys.has(vaultKey(k)));
    await this.saveSettings();
    this.dirty = true;
    this.schedule();
  }

  /**
   * Takes the files at `paths` out of `share`. They are deleted from it on everyone's devices, as a deletion the sharer
   * confirmed, and stay in this vault; a note loses share: <name> from its properties, so it is not shared again. The
   * deletion is sent at once, whatever else changed. Returns what could not be done, which leaves them out all the same,
   * and whether a deletion is still to be sent (`pending`), with why this sync did not send it, when it says.
   */
  async removeFromShare(share: Share, paths: string[]): Promise<{ problems: string[]; pending: boolean; why: string }> {
    const problems: string[] = [];
    await this.exclusive(`Removing from “${share.property}”…`, async () => {
      const keys = new Set(paths.map(vaultKey));
      share.removed = [...new Set([...share.removed, ...keys])];
      share.approved = share.approved.filter((k) => !keys.has(vaultKey(k)));
      share.ask = share.ask.filter((k) => !keys.has(vaultKey(k)));
      await this.saveSettings();
      for (const key of [...keys].filter(isNote)) {
        const file = lookup(this.app, key);
        if (!(file instanceof TFile)) continue;
        try {
          await this.saveEditorOf(file.path);
          if (!(await this.editProperties(file, (text) => withoutShare(text, share.property)))) {
            problems.push(`The properties of “${file.basename}” could not be read, so share: ${share.property} is still in them. It stays out of “${share.property}” all the same.`);
          }
        } catch (e) {
          problems.push(`“${file.basename}”: ${errorText(e)}. It stays out of “${share.property}” all the same.`);
        }
      }
    });
    this.pauses.lift(share.id);
    this.retries.reset(share.id);
    // Undefined when this sync did not run, as when another was running: the one after it sends the deletion.
    const out = (await this.sync(true)).shares?.get(share.id);
    // What the engine still holds after the sync is what was not deleted for the others, whatever stopped it.
    let pending = true;
    try {
      const held = await this.getEngine(share).held();
      pending = paths.some((p) => held.get(vaultKey(p)));
    } catch {
      // Not known here, as without its keys: said as not sent yet.
    }
    return { problems, pending, why: pending ? (out?.problem?.title ?? '') : '' };
  }

  /**
   * Owner: why the suggested file at `path` (inside `share`) can not be taken in, or '' when it can. Reads nothing of
   * the file there, so a suggestion aimed at a note that is not shared shows nothing of it. Into notes shared by a
   * property, see `writeProblem`; into a shared folder, a file its sync leaves out.
   */
  async takeProblem(share: Share, path: string): Promise<string> {
    if (share.property) return writeProblem(vaultKey(path), share.property, this.writeChecks(await this.lookAtShared(share)));
    return this.keptOut(share)(path) ? `“${path}” is left out of sync on this device, so it can not be taken in here.` : '';
  }

  /** What `writeProblem` asks of the vault and of notes shared by a property, as `survey` found them. */
  private writeChecks(survey: Survey): Parameters<typeof writeProblem>[2] {
    const byCase = new Map(this.app.vault.getFiles().map((f) => [vaultKey(f.path).toLowerCase(), vaultKey(f.path)]));
    const config = propertyConfig(this.settings, this.app.vault.configDir, this.pluginDir());
    return {
      excluded: compileExcludes(config.exclude),
      exists: (k) => byCase.get(k.toLowerCase()),
      shared: (k) => survey.shared.has(k) || survey.unmarked.includes(k),
    };
  }

  /**
   * A suggested note as it goes into notes shared by a property: never over a file of the vault that is not in the
   * share. A new note gets share: <name>, so it joins; what the note newly shows waits for the sharer, noted before
   * anything is written.
   */
  private async intoProperty(share: Share, path: string, data: Uint8Array): Promise<Uint8Array> {
    const key = vaultKey(path);
    const fs = this.scope(share).fs as PropertyFS;
    const survey = await this.lookAtShared(share);
    const checks = this.writeChecks(survey);
    const problem = writeProblem(key, share.property, checks);
    if (problem) throw new Error(problem);
    const exists = checks.exists(key) !== undefined;
    const before = exists ? new TextDecoder().decode(await fs.read(path)) : '';
    let text = new TextDecoder().decode(data);
    if (!exists) {
      const marked = withShare(text, share.property);
      if (marked === undefined) throw new Error(`Its properties could not be read, so it could not be added to “${share.property}”.`);
      text = marked;
    }
    const asks = newEmbeds(before, text)
      .map((link) => this.catalog.resolve(link, path))
      .filter((target): target is string => !!target && isAttachment(vaultKey(target)) && !survey.shared.has(vaultKey(target)))
      .map(vaultKey);
    if (asks.length) {
      share.ask = [...new Set([...share.ask, ...asks])];
      await this.saveData(this.settings);
    }
    return new TextEncoder().encode(text);
  }
}
