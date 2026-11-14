// Shared folders on screen: the list in settings, adding one (sharing a folder or joining with an invite link),
// copying an invite link, stopping, and choosing the vault or a shared folder for commands that work on one.
import { Modal, Notice, SuggestModal, TFile, TFolder, Vault, type App } from 'obsidian';
import { DEFAULT_CONFIG } from '../core/config.ts';
import { MIN_PASSPHRASE, WrongPassphraseError } from '../core/crypto.ts';
import { decodeFollow, decodeInvite as decodeMemberInvite, type FollowInvite, type MemberInvite, type MemberKeys } from '../core/members.ts';
import type { Policy } from '../core/policy.ts';
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
  hasStorageAddress,
  isFollowLink,
  isMemberInvite,
  lastPart,
  linkProblem,
  normalFolder,
  opensAlone,
  passphraseProblem,
  remoteSpec,
  sameKeys,
  labelOf,
  setupCodeFrom,
  shareSecretName,
  shareWith,
  storageFromPayload,
  storageProblem,
  type Provider,
  type Share,
  type Storage,
  type StorageForm,
} from './settings.ts';
import { MEMBER_KEYS, addedLine, openedLink, roleLabel, roleOnRow, sharePolicy, storedKind } from './members.ts';
import { shareFromOffer, type Offer } from './offers.ts';
import { SendSuggestionModal, SuggestionsModal } from './inbox.ts';
import { MembersModal, ShareOptionsModal } from './people.ts';
import { hasMembers, mountHint, newShareId, rejoinNeeds, rejoinNote } from './shares.ts';
import { IDS, formStorage, readOnlyBox, storageFields, trialStore, tryStorage, type Keys } from './setup.ts';
import { summarize, waitingText, type Problem } from './status.ts';
import { ActivityModal } from './timemachine.ts';
import { WhatsSharedModal, sharedCounts } from './byproperty-ui.ts';
import { isNote, startProblem, type Survey } from './byproperty.ts';
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
    const offers = plugin.offersHere();
    // Redrawn only when something shown changes, not on every progress step, so a button is not replaced while tapped.
    const now = JSON.stringify([
      shares.map((s) => [s.id, s.folder, s.missing, s.readOnly, s.role, plugin.shareStatus(s), describeStorage(s), plugin.suggestionCount(s), plugin.unsentOf(s).length, sharedCounts(plugin.surveyOf(s))]),
      offers.map((o) => [o.id, o.folder, o.by]),
    ]);
    if (now === shown) return;
    shown = now;
    box.empty();
    if (!shares.length) {
      message(
        box,
        'Share a folder with other people, each with an invite of their own, or keep one folder on different storage. Each shared folder has its own storage, and nothing else in this vault can be seen through it.',
        'coffer-hint',
      );
    }
    for (const share of shares) shareRow(box, plugin, share);
    for (const offer of offers) offerRow(box, plugin, offer);
    button(buttonRow(box), 'Add a shared folder', () => new ShareModal(plugin.app, plugin, 'start').open(), shares.length ? 'plain' : 'cta');
  };
  draw();
  // The vault's other devices may have added shared folders since the last look.
  void plugin.refreshOffers();
  return draw;
}

/** A shared folder another device of this vault offers: added here at the same folder with one tap. */
function offerRow(box: HTMLElement, plugin: CofferPlugin, offer: Offer): void {
  const el = box.createDiv({ cls: 'coffer-share coffer-offer' });
  const body = el.createDiv({ cls: 'coffer-share-text' });
  body.createDiv({ cls: 'coffer-share-name', text: `Add “${offer.folder}” here too` });
  const { share } = shareFromOffer(offer, '');
  // A write member's other device only receives: its invite to edit was for the device that offers it.
  const role = offer.edits ? 'Only receives here' : roleLabel(offer.role, !!offer.followUrl);
  body.createDiv({ cls: 'coffer-share-meta', text: [`Shared on ${offer.by}`, describeStorage(share), role].filter(Boolean).join(' · ') });
  const actions = el.createDiv({ cls: 'coffer-share-actions' });
  button(actions, 'Add here', () => new ShareModal(plugin.app, plugin, 'offer', '', offer).open(), 'cta');
  button(actions, 'Not on this device', () => plugin.hideOffer(offer));
}

/** Notes shared by a property: what they are, how they sync, and what to do with them. They only send, so there is no "Only receive changes". */
function propertyRow(box: HTMLElement, plugin: CofferPlugin, share: Share): void {
  const { text, tone } = plugin.shareStatus(share);
  const name = share.property;
  const el = box.createDiv({ cls: `coffer-share is-${tone}` });
  const body = el.createDiv({ cls: 'coffer-share-text' });
  body.createDiv({ cls: 'coffer-share-name', text: name });
  const status = body.createDiv({ cls: 'coffer-share-status' });
  status.createSpan({ cls: 'coffer-share-dot' });
  status.createSpan({ text });
  body.createDiv({ cls: 'coffer-share-meta', text: [`Notes with share: ${name}`, sharedCounts(plugin.surveyOf(share)), describeStorage(share), roleLabel(share.role, false)].filter(Boolean).join(' · ') });
  const actions = el.createDiv({ cls: 'coffer-share-actions' });
  button(actions, "What's shared", () => new WhatsSharedModal(plugin.app, plugin, share).open());
  button(actions, 'Members', () => new MembersModal(plugin.app, plugin, share).open());
  const suggestions = plugin.suggestionCount(share);
  if (suggestions) button(actions, `Suggestions (${suggestions})`, () => new SuggestionsModal(plugin.app, plugin, share).open(), 'cta');
  if (plugin.targets().includes(share)) button(actions, 'Activity', () => new ActivityModal(plugin.app, plugin, share).open());
  button(actions, 'More…', () => new ShareOptionsModal(plugin.app, plugin, share).open());
  button(actions, 'Stop sharing', () => new StopSharingModal(plugin.app, plugin, share).open());
}

function shareRow(box: HTMLElement, plugin: CofferPlugin, share: Share): void {
  if (share.property) return propertyRow(box, plugin, share);
  const { text, tone } = plugin.shareStatus(share);
  const el = box.createDiv({ cls: `coffer-share is-${tone}` });
  const body = el.createDiv({ cls: 'coffer-share-text' });
  body.createDiv({ cls: 'coffer-share-name', text: share.folder });
  const status = body.createDiv({ cls: 'coffer-share-status' });
  status.createSpan({ cls: 'coffer-share-dot' });
  status.createSpan({ text });
  // A member who may only read is locked to only receiving, as the invite said.
  const locked = share.role === 'read';
  const meta = [describeStorage(share), roleOnRow(share, plugin.standingOf(share)), share.readOnly && !locked ? 'Only receives' : ''];
  body.createDiv({ cls: 'coffer-share-meta', text: meta.filter(Boolean).join(' · ') });
  const only = body.createEl('label', { cls: 'coffer-check' });
  const check = only.createEl('input', { attr: { type: 'checkbox' } });
  check.checked = share.readOnly || locked;
  check.disabled = locked;
  check.addEventListener('change', () => {
    share.readOnly = check.checked;
    void plugin.saveSettings();
  });
  only.appendText(' Only receive changes');
  const actions = el.createDiv({ cls: 'coffer-share-actions' });
  if (share.missing) button(actions, 'Download again', () => downloadAgain(plugin, share), 'cta');
  else if (share.role === 'owner') button(actions, 'Members', () => new MembersModal(plugin.app, plugin, share).open());
  else if (!hasMembers(share)) button(actions, 'Copy invite link', () => new InviteModal(plugin.app, plugin, share).open());
  const suggestions = plugin.suggestionCount(share);
  if (!share.missing && share.role === 'owner' && suggestions) button(actions, `Suggestions (${suggestions})`, () => new SuggestionsModal(plugin.app, plugin, share).open(), 'cta');
  if (!share.missing && plugin.canSuggest(share) && plugin.unsentOf(share).length) button(actions, 'Send as a suggestion', () => new SendSuggestionModal(plugin.app, plugin, share).open());
  if (plugin.targets().includes(share)) button(actions, 'Activity', () => new ActivityModal(plugin.app, plugin, share).open());
  // A followed folder has no storage keys or members to manage.
  if (!share.missing && !share.followUrl) button(actions, 'More…', () => new ShareOptionsModal(plugin.app, plugin, share).open());
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
    return this.targets.filter((t) => !q || (t.share ? labelOf(t.share) : 'this vault').toLowerCase().includes(q));
  }

  renderSuggestion(t: { share?: Share }, el: HTMLElement): void {
    el.createDiv({ text: t.share ? (t.share.property ? `Shared notes “${t.share.property}”` : `Shared folder “${t.share.folder}”`) : 'This vault' });
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
    policyBox(c, sharePolicy(share, 'readOnly'));
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

/**
 * Shown wherever an invite link is made for a shared folder that holds this vault's own storage keys: what that means,
 * and the rules for a key that reaches only the shared folder, to use instead.
 */
export function inviteWarning(c: HTMLElement, plugin: CofferPlugin, share: Share): void {
  if (!sameKeys(share, plugin.settings, (n) => plugin.secret(n))) return;
  message(
    c,
    'This shared folder uses the same storage and keys as this vault, and an invite carries those keys. Whoever gets one can not read the rest of your vault, ' +
      'which is encrypted with a different passphrase, but they could delete or overwrite it in storage. That is fine for your own devices. ' +
      'Before inviting someone else, make a key that reaches only this folder, as below, and enter it under More… → Change storage keys on this device.',
    'coffer-note',
  );
  policyBox(c, sharePolicy(share, 'readWrite'));
}

/**
 * Access rules for a storage key, ready to copy into the provider's console: what they are for, where they go, and a
 * Copy button. Where the provider can not do it, what to do instead.
 */
export function policyBox(c: HTMLElement, policy: Policy): void {
  const box = c.createDiv({ cls: 'coffer-policy' });
  box.createDiv({ cls: 'coffer-policy-title', text: `At your storage provider: ${policy.title.charAt(0).toLowerCase()}${policy.title.slice(1)}` });
  message(box, policy.steps, policy.possible ? 'coffer-hint' : 'coffer-note');
  if (!policy.text) return;
  box.createEl('pre', { cls: 'coffer-policy-text', text: policy.text });
  button(buttonRow(box), 'Copy', async () => {
    try {
      await activeWindow.navigator.clipboard.writeText(policy.text);
      new Notice('Copied.');
    } catch (e) {
      new Notice(`Could not copy it: ${errorText(e)}. Select it and copy it by hand.`, 8000);
    }
  });
}

class StopSharingModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  /** Also stop offering it to this vault's other devices. */
  private withdraw = false;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    // Whether the vault's other devices are offered it shows once storage has been looked at.
    let offered = this.plugin.isOffered(this.share);
    this.unsubscribe = this.plugin.onChange(() => {
      if (offered === this.plugin.isOffered(this.share)) return;
      offered = !offered;
      this.render();
    });
    this.render();
    void this.plugin.refreshOffers();
  }

  private render(): void {
    const c = this.contentEl;
    const s = this.share;
    c.empty();
    if (s.property) return this.renderProperty();
    this.setTitle(`Stop sharing “${s.folder}” on this device?`);
    if (!s.missing) c.createEl('p', { cls: 'coffer-intro', text: `The files stay in “${s.folder}” and from now on sync with the rest of this vault, to your own storage.` });
    const note = rejoinNote(s);
    if (note) c.createEl('p', { cls: 'coffer-intro', text: note });
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'Nothing is deleted from the shared storage, and the others who share this folder are not affected. ' +
        `To join again later, you need ${rejoinNeeds(s)}.`,
    });
    if (s.role === 'owner') {
      message(
        c,
        'This device holds the keys that let you invite and remove members. If none of your other devices shares this folder, first copy the link for your other devices (in Members) and keep it safe: without it, nobody can change who is a member.',
        'coffer-note',
      );
    }
    // Only a device that writes to the vault's storage can take the offer out of it.
    if (!this.plugin.settings.readOnly && this.plugin.isOffered(s)) {
      const label = c.createEl('label', { cls: 'coffer-check' });
      const box = label.createEl('input', { attr: { type: 'checkbox' } });
      box.checked = this.withdraw;
      box.addEventListener('change', () => (this.withdraw = box.checked));
      label.appendText(' Also stop offering it to your other devices');
      c.createDiv({ cls: 'coffer-hint', text: 'Your other devices that have not added it no longer see it offered under Shared folders. Those that have it keep it.' });
    }
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    button(row, 'Stop sharing', async () => {
      this.close();
      try {
        const notWithdrawn = await this.plugin.stopSharing(s, this.withdraw);
        new Notice(
          notWithdrawn === undefined
            ? `Stopped sharing “${s.folder}” on this device.`
            : `Stopped sharing “${s.folder}” on this device. Your other devices are still offered it: ${notWithdrawn}`,
          notWithdrawn === undefined ? 5000 : 10_000,
        );
      } catch (e) {
        new Notice(`Could not stop sharing “${s.folder}”: ${errorText(e)}`, 10_000);
      }
    }, 'warning');
  }

  /** Notes shared by a property: nothing in the vault changes, and they can not be picked up elsewhere. */
  private renderProperty(): void {
    const c = this.contentEl;
    const s = this.share;
    this.setTitle(`Stop sharing “${s.property}”?`);
    c.createEl('p', { cls: 'coffer-intro', text: 'Your notes stay as they are. People keep their copies and stop getting your changes. Nothing is deleted from the shared storage.' });
    message(c, 'It can not be picked up on another device. To share these notes again, start a new share and invite people again.', 'coffer-note');
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    button(row, 'Stop sharing', async () => {
      this.close();
      try {
        await this.plugin.stopSharing(s);
        new Notice(`Stopped sharing “${s.property}”.`);
      } catch (e) {
        new Notice(`Could not stop sharing “${s.property}”: ${errorText(e)}`, 10_000);
      }
    }, 'warning');
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }
}

/** Asks before stopping a shared folder, from anywhere that offers it. */
export function confirmStopSharing(plugin: CofferPlugin, share: Share): void {
  new StopSharingModal(plugin.app, plugin, share).open();
}

type Step = 'start' | 'folder' | 'name' | 'where' | 'provider' | 'storage' | 'passphrase' | 'join' | 'mount' | 'syncing' | 'done';

/**
 * Adding a shared folder, written for phones like the setup wizard: share one of this vault's folders (pick it,
 * pick where it is stored, choose its passphrase), join one with an invite or follow link and pick where it goes here,
 * or add one another device of this vault offers (`offer`), at the same folder.
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
  /** What the invite link opened: storage settings and keys, and with an owner link, the owner's keys. */
  private invite?: { storage: Partial<Storage>; secrets: [string, string][]; member?: MemberKeys };
  /** A member's invite being joined, which needs no passphrase. */
  private member?: MemberInvite;
  /** A follow link being joined: no passphrase, no storage keys. */
  private follow?: FollowInvite;
  /** The folder the link opened last suggested. */
  private suggestedFolder = '';
  /** A shared folder another device of this vault offers, being added here. */
  private offer?: Offer;
  /** Starting a shared folder with members: the name its members see for this device's owner. */
  private ownerName = '';
  /** Joining to write: whether the request for the owner's device to confirm this one went out. */
  private sent = true;
  /** Sharing notes by a property (byproperty.ts) rather than a folder: its name, and what it would send now. */
  private byProperty = false;
  private property = '';
  private preview?: Survey;
  private showPreview?: () => void;
  private previewTimer?: number;
  /** The preview said Obsidian was still reading the vault: it looks again once it has. */
  private previewWaits = false;
  private id = newShareId();
  private share?: Share;
  private outcome?: { summary?: string; problem?: Problem };
  private error = '';
  private busy = false;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin, start: 'start' | 'join' | 'offer', code = '', offer?: Offer) {
    super(app);
    this.plugin = plugin;
    this.step = start === 'offer' ? 'mount' : start;
    this.joining = start !== 'start';
    this.code = code;
    if (offer) {
      this.offer = offer;
      this.id = offer.id;
      this.folder = offer.folder;
      this.readOnly = offer.readOnly;
    }
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.unsubscribe = this.plugin.onChange(() => {
      if (this.step === 'syncing') this.render();
      if (this.previewWaits && this.step === 'name' && this.plugin.catalog.ready()) this.refreshPreview();
    });
    this.render();
    // A member's invite or follow link opened on this device needs nothing typed: straight to where it goes.
    if (this.step === 'join' && opensAlone(setupCodeFrom(this.code))) void this.openInvite();
    // An offer whose folder here is free and holds nothing has nothing to choose or to say: one tap added it.
    if (this.offer && !this.problem(this.folder) && !filesIn(this.app, this.folder)) void this.join();
  }

  onClose(): void {
    this.unsubscribe?.();
    window.clearTimeout(this.previewTimer);
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
      name: () => this.nameStep(),
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
    this.intro('A shared folder syncs with storage of its own. Nothing else in this vault can be seen through it.');
    choice(this.contentEl, 'Share a folder', 'Choose a folder of this vault and where to store it. Then invite each person with a link of their own.', () => {
      this.joining = false;
      this.byProperty = false;
      this.go('folder');
    });
    // One per vault.
    if (!this.plugin.propertyShare()) {
      choice(this.contentEl, 'Share notes by a property', 'Share the notes whose properties say share: and a name, wherever they are, with the pictures and files they show. People can read them, or read and suggest.', () => {
        this.joining = false;
        this.byProperty = true;
        this.go('name');
      });
    }
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
              : `Its ${n === 1 ? 'file is' : `${n.toLocaleString()} files are`} sent to the shared storage, where everyone you invite can see ${n === 1 ? 'it' : 'them'}. ` +
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
    return folderProblem(plugin.settings, folder, this.app.vault.configDir, `${this.app.vault.configDir}/plugins/${plugin.manifest.id}`, '', plugin.propertyFiles());
  }

  private chooseFolder(): void {
    const folder = normalFolder(this.folder);
    const problem = folder ? this.problem(folder) : 'Choose a folder, or type the name of a new one.';
    if (problem) return this.fail(problem);
    this.folder = folder;
    this.go('where');
  }

  /** Notes shared by a property: their name, and exactly what would be sent now. Typing redraws only the preview, so a phone keeps its keyboard. */
  private nameStep(): void {
    const c = this.contentEl;
    this.setTitle('Share notes by a property');
    this.intro('Notes whose properties say share: and this name are shared, with the pictures, sound, video and PDF files they show. They stay where they are in your vault.');
    const input = field(c, 'Name', { value: this.property, placeholder: 'Family', hint: 'Notes join with the property share: and this name. People get them in a folder with this name.' }, (v) => {
      this.property = v;
      this.error = '';
      this.refreshPreview();
    });
    input.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') this.chooseName();
    });
    const box = c.createDiv();
    this.showPreview = () => {
      box.empty();
      this.previewWaits = false;
      if (this.error) return message(box, this.error);
      const name = this.property.trim();
      const v = this.preview;
      if (!name) return;
      if (!this.plugin.catalog.ready()) {
        this.previewWaits = true;
        return message(box, 'Obsidian is still reading this vault. What would be shared shows once it has.', 'coffer-note');
      }
      if (!v) return void box.createEl('p', { cls: 'coffer-progress', text: 'Looking for notes…' });
      const keys = [...v.shared.keys()].sort();
      const notes = keys.filter(isNote).length;
      if (!keys.length) return message(box, `No note says share: ${name} yet. Add it to a note's properties, or use “Share the current note by its property” on a note once this is set up.`, 'coffer-note');
      box.createDiv({ cls: 'coffer-section-title', text: `${notes === 1 ? '1 note' : `${notes.toLocaleString()} notes`} and ${keys.length - notes === 1 ? '1 file' : `${(keys.length - notes).toLocaleString()} files`} would be shared now:` });
      const list = box.createDiv({ cls: 'coffer-files' });
      for (const key of keys.slice(0, 200)) list.createDiv({ cls: 'coffer-file', text: key });
      if (keys.length > 200) list.createDiv({ cls: 'coffer-hint', text: `…and ${(keys.length - 200).toLocaleString()} more` });
      const folders = [...new Set(keys.filter((k) => k.includes('/')).map((k) => k.split('/')[0]))].sort();
      if (folders.length) box.createDiv({ cls: 'coffer-hint', text: `People see them in a folder named ${name}, in the same folders as here: ${folders.slice(0, 8).join(', ')}${folders.length > 8 ? '…' : ''}.` });
      if (v.waiting.length) box.createDiv({ cls: 'coffer-hint', text: `${v.waiting.length === 1 ? '1 file waits' : `${v.waiting.length} files wait`} for you: another file in this vault has the same name. Choose in What's shared once it is set up.` });
    };
    c.appendChild(box);
    this.showPreview();
    c.createDiv({ cls: 'coffer-hint', text: 'Only this device sends them. People’s suggestions you take in reach your other devices through this vault’s sync.' });
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('start'));
    button(row, 'Next', () => this.chooseName(), 'cta');
    if (this.property.trim() && !this.preview) this.refreshPreview();
  }

  /** Looks again at what the name typed would share, a moment after typing stops. */
  private refreshPreview(): void {
    this.preview = undefined;
    this.showPreview?.();
    window.clearTimeout(this.previewTimer);
    const name = this.property.trim();
    if (!name || !this.plugin.catalog.ready()) return;
    this.previewTimer = window.setTimeout(() => {
      this.plugin.previewProperty(name).then(
        (v) => {
          if (this.property.trim() !== name || this.step !== 'name') return;
          this.preview = v;
          this.showPreview?.();
        },
        (e) => {
          this.error = `Could not look at the vault: ${errorText(e)}`;
          this.showPreview?.();
        },
      );
    }, 400);
  }

  private chooseName(): void {
    const problem = startProblem(this.plugin.settings, this.property);
    if (problem) {
      this.error = problem;
      this.showPreview?.();
      return;
    }
    this.property = this.property.trim();
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
    button(buttonRow(this.contentEl), 'Back', () => this.go(this.byProperty ? 'name' : 'folder')).setDisabled(this.busy);
  }

  /** What the new share is called, for naming its place in storage. */
  private shareName(): string {
    return this.byProperty ? this.property : this.folder.split('/').pop()!;
  }

  private async useVaultStorage(): Promise<void> {
    const vault = this.plugin.settings;
    const secret = (n: string) => this.plugin.secret(n);
    this.sameStorage = true;
    this.storage = besideVault(vault, this.shareName(), newShareId().slice(0, 6));
    this.keys = { access: secret(vault.accessKeySecret), secret: secret(vault.secretKeySecret), password: secret(vault.webdavPasswordSecret) };
    this.busy = true;
    this.error = '';
    this.render();
    try {
      await this.checkLocation(this.storage);
      this.go('passphrase');
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  /**
   * Whether `storage` works with the keys typed, and what it holds: nothing yet, where a new shared folder with members
   * starts, or a folder shared with a passphrase, which this device joins with that. One with members is joined with
   * an invite instead.
   */
  private async checkLocation(storage: Storage): Promise<void> {
    this.exists = await tryStorage(storage, {}, this.keys);
    if (!this.exists) return;
    if (this.byProperty) throw new Error('This location already holds a shared folder. Notes shared by a property need a location of their own, with nothing in it yet.');
    if (storedKind(await Repo.header(trialStore(storage, this.keys))) === 'members') {
      throw new Error(
        'This location already holds a shared folder with members. To add it here, open an invite link from its owner, or, on the owner’s own devices, the link for your other devices from its Members screen.',
      );
    }
  }

  private providerStep(): void {
    this.setTitle('Where should the shared folder be stored?');
    for (const p of PROVIDERS) {
      choice(this.contentEl, p.name, p.hint, () => {
        this.provider = p.id;
        this.form.prefix ||= `shared-${folderFor(this.shareName())}`;
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
      storage = shareWith({ ...formStorage(this.provider, this.form, this.keys), id: this.id, folder: this.byProperty ? '' : this.folder, property: this.byProperty ? this.property : '' });
      const taken = storageProblem(this.plugin.settings, storage, this.id);
      if (taken) throw new Error(taken);
    } catch (e) {
      return this.fail(errorText(e));
    }
    this.busy = true;
    this.error = '';
    this.render();
    try {
      await this.checkLocation(storage);
      this.storage = storage;
      this.go('passphrase');
    } catch (e) {
      this.fail(errorText(e));
    }
  }

  private passphraseStep(): void {
    const c = this.contentEl;
    if (this.byProperty) {
      // No passphrase: it would only seal a link for this vault's other devices, and only this one sends these notes.
      this.setTitle('Your name');
      field(c, 'Your name', { value: this.ownerName, placeholder: 'Vu', hint: 'People you invite see it in the member list.' }, (v) => (this.ownerName = v));
      message(c, this.error);
      const row = buttonRow(c);
      button(row, 'Back', () => this.go(this.sameStorage ? 'where' : 'storage')).setDisabled(this.busy);
      button(row, this.busy ? 'Starting…' : 'Start sharing', () => this.create(), 'cta').setDisabled(this.busy);
      return;
    }
    if (this.exists) {
      this.setTitle('Enter the passphrase');
      this.intro('This location already holds a shared folder. Enter the passphrase it was shared with.');
      field(c, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
      message(c, this.error);
    } else {
      this.setTitle('Your name and a passphrase');
      this.intro(
        'Each person you invite gets a link of their own and never needs a passphrase. The passphrase is for your own devices: ' +
          'the link that sets up another of them for this folder is sealed with it. Use a different one from this vault\'s, and keep it in a password manager.',
      );
      field(c, 'Your name', { value: this.ownerName, placeholder: 'Vu', hint: 'Members see it in the member list and while they wait for your device to confirm theirs.' }, (v) => (this.ownerName = v));
      passphraseFields(c, { passphrase: this.passphrase, repeat: this.repeat, suggested: this.suggested }, { hint: `At least ${MIN_PASSPHRASE} characters.`, error: this.error, changed: (v) => void Object.assign(this, v) });
    }
    const row = buttonRow(c);
    button(row, 'Back', () => this.go(this.sameStorage ? 'where' : 'storage')).setDisabled(this.busy);
    button(row, this.busy ? 'Checking…' : 'Share this folder', () => this.create(), 'cta').setDisabled(this.busy);
  }

  private async create(): Promise<void> {
    if (this.byProperty) return this.createByProperty();
    const problem = passphraseProblem(this.passphrase, this.repeat, this.exists) || (!this.exists && !this.ownerName.trim() ? 'Enter your name, as members will see it.' : '');
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
    } else {
      // A new shared folder with members, this device its owner.
      Object.assign(share, { role: 'owner', memberKeysSecret: name(MEMBER_KEYS) });
      return this.start(share, secrets, this.passphrase);
    }
    await this.add(share, secrets);
  }

  /** Starts a shared folder with members at the location chosen, and adds it (`startMemberShare`). */
  private async start(share: Share, secrets: [string, string][], passphrase: string): Promise<void> {
    try {
      await this.plugin.startMemberShare(share, secrets, this.ownerName.trim(), passphrase);
    } catch (e) {
      return this.fail(`Could not start sharing there: ${errorText(e)}`);
    }
    await this.synced(share);
  }

  /** Notes shared by a property, this device the one that sends them, in storage that holds nothing yet. */
  private async createByProperty(): Promise<void> {
    if (!this.ownerName.trim()) return this.fail('Enter your name, as people will see it.');
    const k = this.keys;
    const dav = this.storage!.storageType === 'webdav';
    const name = (base: string) => shareSecretName(base, this.app.vault.getName(), this.id);
    const share = shareWith({
      ...this.storage!,
      id: this.id,
      folder: '',
      property: this.property,
      role: 'owner',
      memberKeysSecret: name(MEMBER_KEYS),
      accessKeySecret: dav ? '' : name(IDS.access),
      secretKeySecret: dav ? '' : name(IDS.secret),
      webdavPasswordSecret: dav ? name(IDS.password) : '',
      passphraseSecret: '',
    });
    const secrets: [string, string][] = dav ? [[name(IDS.password), k.password]] : [[name(IDS.access), k.access.trim()], [name(IDS.secret), k.secret.trim()]];
    this.busy = true;
    this.error = '';
    this.render();
    // The share's header wants a passphrase; no link is ever sealed with this one, so it is kept nowhere.
    const unused = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24))));
    await this.start(share, secrets, unused);
  }

  private joinStep(): void {
    const c = this.contentEl;
    this.setTitle('Join a shared folder');
    this.intro('Paste the invite link you were sent, or open it on this device. A folder shared with a passphrase also needs that passphrase, which should reach you separately.');
    // Only a link sealed with a passphrase asks for one. Typing shows or hides the field without drawing the rest again.
    const passphrase = createDiv();
    const showPassphrase = () => passphrase.toggle(!opensAlone(setupCodeFrom(this.code)));
    const code = field(c, 'Invite link', { value: this.code, multiline: true, placeholder: 'obsidian://coffer?share=…' }, (v) => {
      this.code = v;
      showPassphrase();
    });
    code.addClass('coffer-code');
    button(buttonRow(c), 'Paste', async () => {
      try {
        this.code = await navigator.clipboard.readText();
        code.value = this.code;
        showPassphrase();
      } catch {
        new Notice('Could not read the clipboard. Long-press the box and choose Paste.');
      }
    });
    c.appendChild(passphrase);
    field(passphrase, 'Passphrase', { value: this.passphrase, password: true }, (v) => (this.passphrase = v));
    showPassphrase();
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('start')).setDisabled(this.busy);
    button(row, this.busy ? 'Opening…' : 'Next', () => this.openInvite(), 'cta').setDisabled(this.busy);
  }

  private async openInvite(): Promise<void> {
    const code = setupCodeFrom(this.code);
    if (!code) return this.fail('Paste the invite link.');
    const kind = codeKind(code);
    if (kind !== 'share') {
      return this.fail(kind === 'vault' ? 'This is a setup link for a whole vault, not an invite to a shared folder. It goes in "Set up sync" on a new device.' : 'That is not an invite link. Copy it again.');
    }
    if (isMemberInvite(code)) return this.openMemberInvite(code);
    if (isFollowLink(code)) return this.openFollowLink(code);
    if (!this.passphrase) return this.fail('Enter the passphrase of the shared folder.');
    this.busy = true;
    this.error = '';
    this.render();
    let invite: Awaited<ReturnType<typeof decodeInvite>>;
    try {
      invite = await decodeInvite(code, this.passphrase, this.app.vault.getName(), this.id);
    } catch (e) {
      return this.fail(e instanceof WrongPassphraseError || !/owner link/.test(errorText(e)) ? linkProblem(e, 'invite') : errorText(e));
    }
    const taken = storageProblem(this.plugin.settings, shareWith({ ...invite.storage, id: this.id, folder: invite.folder }), this.id);
    if (taken) return this.fail(taken);
    this.opened({ invite, readOnly: !!invite.storage.readOnly, folder: invite.folder });
  }

  /** Joins `link` from now on, whatever link was opened before it (`openedLink`). */
  private opened(link: { invite: NonNullable<ShareModal['invite']>; member?: MemberInvite; follow?: FollowInvite; readOnly: boolean; folder: string }): void {
    ({ invite: this.invite, member: this.member, follow: this.follow, readOnly: this.readOnly, folder: this.folder, suggested: this.suggestedFolder } = openedLink(
      { folder: this.folder, suggested: this.suggestedFolder },
      link,
    ));
    this.go('mount');
  }

  /** A member's invite: not sealed, so it opens at once. Its storage is checked when joining, which opens the invite there. */
  private openMemberInvite(code: string): void {
    let member: MemberInvite;
    try {
      member = decodeMemberInvite(code);
    } catch (e) {
      return this.fail(`${errorText(e)}. Copy it again, or ask for a new one.`);
    }
    const { storage, secrets } = storageFromPayload(member.storage, (base) => shareSecretName(base, this.app.vault.getName(), this.id));
    const trial = shareWith({ ...storage, id: this.id, folder: lastPart(member.folder) || 'Shared' });
    if (!hasStorageAddress(trial)) return this.fail('That invite link does not say where the shared folder is stored. Ask for a new one.');
    const taken = storageProblem(this.plugin.settings, trial, this.id);
    if (taken) return this.fail(taken);
    this.opened({ invite: { storage, secrets }, member, readOnly: member.role === 'read', folder: lastPart(member.folder) });
  }

  /** A follow link: not sealed, so it opens at once. Its public address is checked when joining, which opens the link there. */
  private openFollowLink(code: string): void {
    let follow: FollowInvite;
    try {
      follow = decodeFollow(code);
    } catch (e) {
      return this.fail(`${errorText(e)}. Copy it again, or ask for a new one.`);
    }
    const taken = storageProblem(this.plugin.settings, shareWith({ id: this.id, folder: lastPart(follow.folder) || 'Shared', followUrl: follow.url }), this.id);
    if (taken) return this.fail(taken);
    this.opened({ invite: { storage: {}, secrets: [] }, follow, readOnly: true, folder: lastPart(follow.folder) });
  }

  private mountStep(): void {
    const offer = this.offer;
    if (offer) {
      this.setTitle(`Add “${offer.folder}” here too`);
      this.intro(`It is shared on ${offer.by}, and goes in the same folder here. Its keys come from that device, encrypted in this vault's storage: there is nothing to type.`);
    } else {
      this.setTitle('Where should it go in this vault?');
      this.intro('The shared files go in this folder. It does not need to have the same name as on the other devices.');
    }
    this.folderField();
    readOnlyBox(
      this.contentEl,
      this.readOnly,
      (v) => {
        this.readOnly = v;
        this.showFolder?.();
      },
      !!this.invite?.storage.readOnly || this.member?.role === 'read' || !!this.follow || offer?.role === 'read',
    );
    const hint = (text: string) => this.contentEl.createDiv({ cls: 'coffer-hint', text });
    if (this.member?.role === 'write') hint('Until the owner’s device confirms this one, which it does at its next sync, this device only receives changes.');
    if (this.follow || offer?.followUrl) hint('It is read from a public address, with no storage keys, so this device only receives changes.');
    if (offer?.edits) hint('An invite to edit works for one device, so here it only receives changes. To edit here too, ask the owner for an invite for this device.');
    const row = buttonRow(this.contentEl);
    if (offer) button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    else button(row, 'Back', () => this.go('join')).setDisabled(this.busy);
    button(row, this.busy ? 'Adding…' : offer ? 'Add' : 'Join', () => this.join(), 'cta').setDisabled(this.busy);
  }

  private async join(): Promise<void> {
    const folder = normalFolder(this.folder);
    const problem = folder ? this.problem(folder) : 'Choose a folder, or type the name of a new one.';
    if (problem) return this.fail(problem);
    this.folder = folder;
    if (this.offer) {
      const { share, secrets } = shareFromOffer(this.offer, this.app.vault.getName());
      Object.assign(share, { folder, readOnly: this.readOnly || this.offer.role === 'read' });
      return this.add(share, secrets, true);
    }
    const keys = shareSecretName(MEMBER_KEYS, this.app.vault.getName(), this.id);
    if (this.follow) {
      const share = shareWith({ id: this.id, folder, readOnly: true, role: 'read', followUrl: this.follow.url, memberKeysSecret: keys });
      this.busy = true;
      this.error = '';
      this.render();
      try {
        await this.plugin.joinFollow(share, this.follow);
      } catch (e) {
        return this.fail(`Could not follow it: ${errorText(e)}`);
      }
      return this.synced(share);
    }
    const invite = this.invite!;
    const share = shareWith({ ...invite.storage, id: this.id, folder, readOnly: this.readOnly });
    if (this.member) {
      Object.assign(share, { role: this.member.role, memberKeysSecret: keys });
      this.busy = true;
      this.error = '';
      this.render();
      try {
        this.sent = await this.plugin.joinMember(share, invite.secrets, this.member);
      } catch (e) {
        return this.fail(`Could not join: ${errorText(e)}`);
      }
      return this.synced(share);
    }
    // An owner link: another of the owner's devices.
    if (invite.member) {
      Object.assign(share, { role: 'owner', memberKeysSecret: keys });
      return this.add(share, [...invite.secrets, [keys, JSON.stringify(invite.member)]]);
    }
    await this.add(share, invite.secrets);
  }

  /** `offered`: it comes from another device's offer, which this device does not make again. */
  private async add(share: Share, secrets: [string, string][], offered = false): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await this.plugin.addShare(share, secrets, offered);
    } catch (e) {
      return this.fail(errorText(e));
    }
    await this.synced(share);
  }

  /** After `share` was added: its first sync, then how it went. */
  private async synced(share: Share): Promise<void> {
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
    else this.intro(addedLine(labelOf(share), !this.joining ? 'started' : this.offer || share.role === 'owner' ? 'added' : 'joined', this.outcome?.summary));
    if (share.property) {
      this.intro('Next, invite people in Members: each person gets a link of their own, to read, or to read and send suggestions.');
      message(c, 'Only this device sends these notes, and they are not offered to your other devices: those get them through this vault’s own sync.', 'coffer-hint');
      const row = buttonRow(c);
      button(row, "What's shared", () => {
        this.close();
        new WhatsSharedModal(this.app, this.plugin, share).open();
      });
      button(row, 'Members', () => {
        this.close();
        new MembersModal(this.app, this.plugin, share).open();
      }, 'cta');
      button(buttonRow(c), 'Done', () => this.close());
      return;
    }
    const joined = this.joining && share.role ? this.joinedNote(share) : '';
    if (joined) this.intro(joined);
    if (!this.offer) message(c, this.offeredNote(share), 'coffer-hint');
    if (!this.joining && share.role === 'owner') {
      this.intro('Next, invite the others in Members: each person gets a link of their own.');
      inviteWarning(c, this.plugin, share);
      button(buttonRow(c), 'Members', () => {
        this.close();
        new MembersModal(this.app, this.plugin, share).open();
      });
    } else if (!this.joining) {
      this.intro('Next, send an invite link to whoever should share it, and tell them the passphrase another way. On your own devices, use the same link in Settings → Coffer → Shared folders.');
      inviteWarning(c, this.plugin, share);
      button(buttonRow(c), 'Copy invite link', () => new InviteModal(this.app, this.plugin, share).open());
    }
    button(buttonRow(c), 'Done', () => this.close(), 'cta');
  }

  /** Whether this vault's other devices are offered the shared folder just added. */
  private offeredNote(share: Share): string {
    if (this.plugin.settings.readOnly) return 'This device only receives changes to this vault, so it does not offer this folder to your other devices.';
    return share.offerPending
      ? 'Your other devices that sync this vault are offered it too, once this vault syncs.'
      : 'Your other devices that sync this vault are offered it too, under Shared folders: nothing to type there.';
  }

  /** What joining a shared folder with members as `share.role` means from now on. */
  private joinedNote(share: Share): string {
    if (share.role === 'owner') return 'This device is one of the owner’s: it can invite and remove members, from Members on the folder’s row.';
    if (share.followUrl) return 'This device reads it from its public address and only receives changes.';
    if (share.role === 'read') return 'This device only receives changes to it.';
    const standing = this.plugin.standingOf(share);
    if (standing && !standing.waiting) return standing.mayWrite ? 'This device can send changes to it.' : '';
    const wait = `${waitingText(standing?.owner ?? '')}: until then this device only receives changes. It usually does at its next sync.`;
    return this.sent ? wait : `${wait} This device asks it to at its next sync.`;
  }
}
