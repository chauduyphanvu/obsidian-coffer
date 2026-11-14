// Shared folders with members on screen: the owner's member list, inviting, removing, the link for the owner's other
// devices, new storage keys for everyone or for this device, and what a stuck or older shared folder offers.
import { Modal, Notice, type App } from 'obsidian';
import type { MemberStatus } from '../core/engine.ts';
import { errorText } from '../core/text.ts';
import type CofferPlugin from './main.ts';
import {
  INVITE_DAYS,
  followCaveat,
  followNote,
  inviteNote,
  keysOf,
  keysProblem,
  memberLine,
  memberError,
  noKeys,
  publicAddressGuess,
  readKeyProblem,
  rekeyReadersNote,
  rekeySuggestersNote,
  roleLabel,
  sharePolicy,
  trimKeys,
  type KeySet,
} from './members.ts';
import { labelOf, providerOf, type Share } from './settings.ts';
import { confirmStopSharing, inviteWarning, policyBox } from './sharing.ts';
import { button, buttonRow, choice, field, message } from './ui.ts';

/** Fields for storage keys of `share`'s kind, filling `k` as they are typed. `what` comes before each label, like "Read-only". */
function keyFields(c: HTMLElement, share: Share, k: KeySet, what = ''): void {
  const label = (text: string) => (what ? `${what} ${text.charAt(0).toLowerCase()}${text.slice(1)}` : text);
  if (share.storageType === 'webdav') {
    field(c, label('User name'), { value: k.user }, (v) => (k.user = v));
    field(c, label('Password'), { value: k.password, password: true }, (v) => (k.password = v));
    return;
  }
  const b2 = providerOf(share) === 'b2';
  field(c, label(b2 ? 'Key ID' : 'Access key ID'), { value: k.access }, (v) => (k.access = v));
  field(c, label(b2 ? 'Application key' : 'Secret access key'), { value: k.secret, password: true }, (v) => (k.secret = v));
}

/** Two to four options side by side, the chosen one marked. */
function pick<T>(c: HTMLElement, label: string, options: [T, string][], value: T, chosen: (v: T) => void): void {
  c.createDiv({ cls: 'coffer-pick-label', text: label });
  const row = c.createDiv({ cls: 'coffer-pick' });
  for (const [v, text] of options) {
    const b = row.createEl('button', { text, cls: v === value ? 'is-selected' : '' });
    b.setAttr('aria-pressed', String(v === value));
    b.addEventListener('click', () => chosen(v));
  }
}

async function copy(text: string, done: string): Promise<boolean> {
  try {
    await activeWindow.navigator.clipboard.writeText(text);
    new Notice(done);
    return true;
  } catch (e) {
    new Notice(`Could not copy the link: ${errorText(e)}`, 8000);
    return false;
  }
}

type View = 'list' | 'invite' | 'link' | 'owner' | 'remove' | 'follow' | 'followed';

/** The owner's screen for a shared folder with members: who is in it and how each stands, inviting and removing. */
export class MembersModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private view: View = 'list';
  private members?: MemberStatus[];
  private loading = false;
  private error = '';
  private busy = false;
  /** Said above the list after someone was removed. */
  private removed = '';
  private name = '';
  private role: 'write' | 'read' = 'write';
  /** A read member who sends suggestions too: its key may also add them (`policy.ts`, readAndInbox), and re-keys hand it one that may. */
  private suggest = false;
  private days: number = 7;
  private read = noKeys();
  private link = '';
  private expires = 0;
  private ownerLink = '';
  private removing?: MemberStatus;
  /** A follow link being made: its public address, and the name its member has in the list. */
  private url = '';
  private followName = 'Public readers';

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.load();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private load(): void {
    this.loading = true;
    this.render();
    this.plugin.members(this.share).then(
      (m) => {
        this.members = m;
        this.error = '';
      },
      (e) => (this.error = `Could not read the members: ${memberError(e)}`),
    ).finally(() => {
      this.loading = false;
      if (this.view === 'list') this.render();
    });
  }

  private go(view: View): void {
    this.view = view;
    this.error = '';
    this.busy = false;
    this.render();
  }

  private render(): void {
    this.contentEl.empty();
    ({
      list: () => this.listView(),
      invite: () => this.inviteView(),
      link: () => this.linkView(),
      owner: () => this.ownerView(),
      remove: () => this.removeView(),
      follow: () => this.followView(),
      followed: () => this.followedView(),
    })[this.view]();
  }

  private intro(text: string): void {
    this.contentEl.createEl('p', { cls: 'coffer-intro', text });
  }

  private listView(): void {
    const c = this.contentEl;
    this.setTitle(`Members of “${labelOf(this.share)}”`);
    if (this.removed) {
      const note = c.createDiv({ cls: 'coffer-note' });
      note.createDiv({ text: this.removed });
      button(buttonRow(note), 'Give everyone new storage keys…', () => {
        this.close();
        new RekeyModal(this.app, this.plugin, this.share).open();
      });
    }
    if (this.loading && !this.members) c.createEl('p', { cls: 'coffer-progress', text: 'Reading the members…' });
    const now = Date.now();
    const list = c.createDiv({ cls: 'coffer-members' });
    for (const m of this.members ?? []) {
      const row = list.createDiv({ cls: 'coffer-device' });
      const text = row.createDiv({ cls: 'coffer-device-text' });
      const name = text.createDiv({ cls: 'coffer-device-name', text: m.name });
      name.createSpan({ cls: 'coffer-device-tag', text: roleLabel(m.role, !!m.follow, !!m.suggest) });
      text.createDiv({ cls: 'coffer-device-meta', text: memberLine(m, now) });
      if (m.state === 'confirming') button(row, 'Confirm now', () => this.confirm(), 'cta').setDisabled(this.busy);
      if (!m.self && m.role !== 'owner') {
        button(row, 'Remove', () => {
          this.removing = m;
          this.go('remove');
        }).setDisabled(this.busy);
      }
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Invite someone', () => {
      this.name = '';
      // People only read notes shared by a property, or read and suggest.
      this.role = this.share.property ? 'read' : 'write';
      this.suggest = false;
      this.days = 7;
      this.read = noKeys();
      this.link = '';
      this.go('invite');
    }, 'cta').setDisabled(this.busy);
    // Notes shared by a property are sent from this device only.
    if (!this.share.property) button(row, 'Link for your other devices', () => this.openOwnerLink()).setDisabled(this.busy);
    choice(c, 'Anyone with this link can read', 'A follow link: for publishing this folder from a public web address. Followers need no storage keys and no passphrase.', () => {
      this.url ||= publicAddressGuess(this.share);
      this.link = '';
      this.go('follow');
    }).disabled = this.busy;
    button(buttonRow(c), 'Close', () => this.close());
  }

  /** Making a follow link: the folder's storage made public, its address, and a check that it serves this folder. */
  private followView(): void {
    const c = this.contentEl;
    this.setTitle('Anyone with this link can read');
    this.intro(
      'A follow link lets anyone who has it read this folder from a public web address. Their devices only receive changes. ' +
        'First make this folder’s storage readable by anyone, then enter the address it is read at.',
    );
    message(c, 'A follower can not be cut off short of making a new shared folder: removing the link stops Coffer on their devices, but whoever kept it can still read everything at that address.', 'coffer-note');
    policyBox(c, sharePolicy(this.share, 'publicRead'));
    field(c, 'Public address', { value: this.url, placeholder: 'https://example.com/shared-family', hint: 'Where this folder’s files can be downloaded by anyone: its file vault.json must open at this address followed by /vault.json.' }, (v) => (this.url = v));
    field(c, 'Name in the member list', { value: this.followName }, (v) => (this.followName = v));
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('list')).setDisabled(this.busy);
    button(row, this.busy ? 'Checking the address…' : 'Check and make the link', () => this.makeFollowLink(), 'cta').setDisabled(this.busy);
  }

  private async makeFollowLink(): Promise<void> {
    const name = this.followName.trim();
    this.error = !this.url.trim() ? 'Enter the public address.' : !name ? 'Enter a name for the member list.' : '';
    if (this.error) return this.render();
    this.busy = true;
    this.render();
    try {
      this.link = await this.plugin.followLink(this.share, { name, url: this.url });
      this.members = undefined;
      this.go('followed');
    } catch (e) {
      this.busy = false;
      this.error = `Could not make the follow link: ${memberError(e)}`;
      this.render();
    }
  }

  /** The follow link just made, to copy. */
  private followedView(): void {
    const c = this.contentEl;
    this.setTitle('Follow link');
    this.intro(followNote);
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back to members', () => {
      this.go('list');
      this.load();
    });
    button(row, 'Copy follow link', async () => {
      if (await copy(this.link, 'Follow link copied.')) {
        this.go('list');
        this.load();
      }
    }, 'cta');
  }

  private async confirm(): Promise<void> {
    this.busy = true;
    this.render();
    try {
      const n = await this.plugin.confirmJoins(this.share);
      new Notice(n === 1 ? 'Confirmed: that device can send changes now.' : `Confirmed ${n} devices.`);
    } catch (e) {
      // Not reloaded: a reload that works clears the error before it is read.
      this.error = `Could not confirm: ${memberError(e)}`;
      this.busy = false;
      this.render();
      return;
    }
    this.busy = false;
    this.load();
  }

  private inviteView(): void {
    const c = this.contentEl;
    this.setTitle(`Invite someone to “${labelOf(this.share)}”`);
    field(c, 'Name', { value: this.name, placeholder: 'Ann', hint: 'Shown in the member list, and to the others in this folder.' }, (v) => (this.name = v));
    const roles: ['write' | 'read' | 'suggest', string][] = [['write', 'Edit files'], ['read', 'Only read'], ['suggest', 'Read and suggest']];
    pick<'write' | 'read' | 'suggest'>(c, 'They can', this.share.property ? roles.slice(1) : roles, this.suggest ? 'suggest' : this.role, (v) => {
      this.role = v === 'write' ? 'write' : 'read';
      this.suggest = v === 'suggest';
      this.error = '';
      this.render();
    });
    pick(c, 'The invite works for', INVITE_DAYS.map((d): [number, string] => [d, d === 1 ? '1 day' : `${d} days`]), this.days, (v) => {
      this.days = v;
      this.render();
    });
    if (this.role === 'read') {
      c.createEl('p', {
        cls: 'coffer-intro',
        text: this.suggest
          ? 'Make a key at your storage provider that can read this folder and add suggestions to it, and enter it here. The invite carries that key. Their devices only receive changes, and can send you changed notes, for you to look at and take in.'
          : 'Make a key at your storage provider that can only read this folder, and enter it here. The invite carries that key, and their devices only receive changes.',
      });
      policyBox(c, sharePolicy(this.share, this.suggest ? 'readAndInbox' : 'readOnly'));
      keyFields(c, this.share, this.read, this.suggest ? 'Their' : 'Read-only');
    } else {
      c.createEl('p', { cls: 'coffer-hint', text: 'The invite carries the storage keys this device uses. Their device can send changes once your device confirms it, which it does at its next sync.' });
      inviteWarning(c, this.plugin, this.share);
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('list')).setDisabled(this.busy);
    button(row, this.busy ? 'Making the link…' : 'Make the link', () => this.makeInvite(), 'cta').setDisabled(this.busy);
  }

  private async makeInvite(): Promise<void> {
    const name = this.name.trim();
    const own = keysOf(this.share, (n) => this.plugin.secret(n));
    this.error = !name ? 'Enter their name.' : this.role !== 'read' ? '' : readKeyProblem(this.share.storageType, this.read, own, this.suggest);
    if (this.error) return this.render();
    this.busy = true;
    this.render();
    try {
      const made = await this.plugin.invite(this.share, { name, role: this.role, days: this.days, ...(this.role === 'read' && { read: trimKeys(this.read), suggest: this.suggest }) });
      this.link = made.link;
      this.expires = made.expires;
      this.members = undefined;
      this.go('link');
    } catch (e) {
      this.busy = false;
      this.error = `Could not make the invite: ${memberError(e)}`;
      this.render();
    }
  }

  /** The invite just made. It is in the member list already, so this screen only copies it. */
  private linkView(): void {
    const c = this.contentEl;
    this.setTitle(`Invite for ${this.name.trim()}`);
    this.intro(inviteNote(this.name, this.role, this.expires));
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back to members', () => {
      this.go('list');
      this.load();
    });
    button(row, 'Copy invite link', async () => {
      if (await copy(this.link, 'Invite link copied.')) {
        this.go('list');
        this.load();
      }
    }, 'cta');
  }

  private openOwnerLink(): void {
    this.ownerLink = '';
    this.go('owner');
    // Made before the tap, so the copy happens in the tap itself, as phones require.
    this.plugin.ownerLink(this.share).then(
      (link) => (this.ownerLink = link),
      (e) => (this.error = `Could not make the link: ${errorText(e)}`),
    ).finally(() => {
      if (this.view === 'owner') this.render();
    });
  }

  private ownerView(): void {
    const c = this.contentEl;
    this.setTitle('Your other devices');
    this.intro(
      'Open this link on another of your devices, or paste it there in Settings → Coffer → Shared folders → Add a shared folder → Join with an invite link. ' +
        'It asks for the passphrase you chose for this folder. That device can then invite and remove members too.',
    );
    message(c, 'The link carries the keys that make a device the owner’s. Keep it to your own devices.', 'coffer-note');
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Back', () => this.go('list'));
    button(row, this.ownerLink || this.error ? 'Copy link' : 'Preparing…', async () => {
      if (await copy(this.ownerLink, 'Link copied. It asks for this folder’s passphrase.')) this.go('list');
    }, 'cta').setDisabled(!this.ownerLink);
  }

  private removeView(): void {
    const c = this.contentEl;
    const m = this.removing!;
    this.setTitle(`Remove ${m.name}?`);
    if (m.follow) {
      this.intro(`The follow link opens nothing for new devices, and Coffer stops on the devices that follow “${labelOf(this.share)}” at their next sync.`);
      const what = c.createEl('ul', { cls: 'coffer-what' });
      what.createEl('li', { text: 'Whoever kept the link can still read everything at the public address, now and later. New storage keys do not change that.' });
      what.createEl('li', { text: 'To cut them off, make the address private and start a new shared folder.' });
    } else {
      this.intro(`${m.name}’s devices stop syncing “${labelOf(this.share)}” at their next sync, and their invite stops working. What they changed before stays.`);
      const what = c.createEl('ul', { cls: 'coffer-what' });
      what.createEl('li', { text: 'They keep the files they already have.' });
      what.createEl('li', {
        text: 'The storage keys they were given still reach the storage until you replace them. After removing someone, give everyone new storage keys, so theirs stop working.',
      });
      const caveat = followCaveat(this.members);
      if (caveat) what.createEl('li', { text: caveat });
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.go('list')).setDisabled(this.busy);
    button(row, this.busy ? 'Removing…' : 'Remove', () => this.remove(m), 'warning').setDisabled(this.busy);
  }

  private async remove(m: MemberStatus): Promise<void> {
    this.busy = true;
    this.render();
    try {
      await this.plugin.removeMember(this.share, m.id);
    } catch (e) {
      this.busy = false;
      this.error = `Could not remove ${m.name}: ${memberError(e)}`;
      this.render();
      return;
    }
    // A follow link carried no storage keys, so new ones change nothing for it; a reminder about someone removed before stays.
    if (!m.follow) this.removed = `${m.name} was removed. To stop the storage keys they had from working, give everyone new storage keys.`;
    if (m.follow) new Notice(`${m.name} was removed: the follow link opens nothing new.`);
    this.members = this.members?.filter((x) => x.id !== m.id);
    this.go('list');
    this.load();
  }
}

/** The less common things to do with a shared folder, from its row. */
export class ShareOptionsModal extends Modal {
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
    this.setTitle(`“${labelOf(s)}”`);
    const then = (open: () => Modal) => () => {
      this.close();
      open().open();
    };
    if (s.role === 'owner') {
      choice(c, 'Give everyone new storage keys', 'After removing someone: new keys reach every member’s device and your other devices, and the old ones can be deleted.', then(() => new RekeyModal(this.app, this.plugin, s)));
    }
    choice(c, 'Change storage keys on this device', 'When the keys for this folder’s storage changed at your provider. They are checked before they are saved.', then(() => new ChangeKeysModal(this.app, this.plugin, s)));
    if (!s.memberKeysSecret) {
      choice(c, 'Share again with members', 'Give each person an invite of their own, which you can remove, instead of one passphrase for everyone.', then(() => new ShareAgainModal(this.app, this.plugin, s)));
    }
    button(buttonRow(c), 'Close', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/**
 * Owner: new storage keys for every device of a shared folder with members, as after removing someone. The keys are
 * tested against the folder's storage before any device is told.
 */
export class RekeyModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private write = noKeys();
  private read = noKeys();
  private suggest = noKeys();
  /** Members who only read, who need keys that only read; undefined until the member list is read. */
  private readers?: string[];
  /** Members who read and send suggestions, who need keys that may also add them. */
  private suggesters: string[] = [];
  /** What a follow link of this folder leaves a removed member: see `followCaveat`. */
  private caveat = '';
  private error = '';
  private busy = false;
  private done = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.render();
    this.plugin.members(this.share).then(
      (m) => {
        // A follow link's member is handed no keys: it reads the public copy.
        const readers = m.filter((x) => x.role === 'read' && !x.follow);
        this.readers = readers.filter((x) => !x.suggest).map((x) => x.name);
        this.suggesters = readers.filter((x) => x.suggest).map((x) => x.name);
        this.caveat = followCaveat(m);
      },
      (e) => (this.error = `Could not read the members: ${memberError(e)}`),
    ).finally(() => this.render());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    this.setTitle(`New storage keys for “${labelOf(this.share)}”`);
    if (this.done) {
      c.createEl('p', { cls: 'coffer-intro', text: 'The new keys are handed out, and this device uses them from now on. Every other device of this folder switches at its next sync.' });
      message(
        c,
        'Delete the old keys at your storage provider once every member’s device has had time to sync, for example after a week. A device that has not synced by then stops working, and needs a new invite.',
        'coffer-note',
      );
      button(buttonRow(c), 'Done', () => this.close(), 'cta');
      return;
    }
    c.createEl('p', {
      cls: 'coffer-intro',
      text: 'Use this after removing someone, so the storage keys they had stop working. First make new keys for this folder at your storage provider, and keep the old ones for now.',
    });
    const what = c.createEl('ul', { cls: 'coffer-what' });
    what.createEl('li', { text: 'Coffer checks the new keys against this folder, then hands them to every member’s device and to your other devices, each in a message only it can open.' });
    what.createEl('li', { text: 'Each device switches at its next sync, and keeps its old keys if the new ones do not work for it.' });
    what.createEl('li', { text: 'Someone you removed keeps the files they already have. New keys stop them reading and changing the folder from now on.' });
    if (this.caveat) what.createEl('li', { text: this.caveat });
    if (this.readers === undefined && !this.error) {
      c.createEl('p', { cls: 'coffer-progress', text: 'Reading the members…' });
      return;
    }
    policyBox(c, sharePolicy(this.share, 'readWrite'));
    keyFields(c, this.share, this.write, 'New');
    if (this.readers?.length) {
      c.createEl('p', { cls: 'coffer-intro', text: rekeyReadersNote(this.readers) });
      policyBox(c, sharePolicy(this.share, 'readOnly'));
      keyFields(c, this.share, this.read, 'New read-only');
    }
    if (this.suggesters.length) {
      c.createEl('p', { cls: 'coffer-intro', text: rekeySuggestersNote(this.suggesters) });
      policyBox(c, sharePolicy(this.share, 'readAndInbox'));
      keyFields(c, this.share, this.suggest, 'New read-and-suggest');
    }
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    button(row, this.busy ? 'Checking the keys…' : 'Check and hand out', () => this.run(), 'cta').setDisabled(this.busy || this.readers === undefined);
  }

  private async run(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.render();
    try {
      // Read and suggestion keys are used only while someone is named to get them.
      await this.plugin.rekey(this.share, {
        write: trimKeys(this.write),
        read: trimKeys(this.read),
        readers: this.readers ?? [],
        suggest: trimKeys(this.suggest),
        suggesters: this.suggesters,
      });
      this.done = true;
    } catch (e) {
      this.error = memberError(e);
    }
    this.busy = false;
    this.render();
  }
}

/** New storage keys for one shared folder on this device only, checked against its storage before they are kept. */
export class ChangeKeysModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private keys = noKeys();
  private error = '';
  private busy = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const c = this.contentEl;
    const s = this.share;
    c.empty();
    this.setTitle(`Storage keys for “${labelOf(s)}”`);
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'For when the keys for this folder’s storage changed at your provider. This changes them on this device only. ' +
        `They are saved once they reach this folder’s storage${s.readOnly ? '' : ' and may write there'}.`,
    });
    keyFields(c, s, this.keys);
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    button(row, this.busy ? 'Checking…' : 'Check and save', () => this.save(), 'cta').setDisabled(this.busy);
  }

  private async save(): Promise<void> {
    this.error = keysProblem(this.share.storageType, this.keys);
    if (this.error) return this.render();
    this.busy = true;
    this.render();
    try {
      await this.plugin.changeKeys(this.share, trimKeys(this.keys));
    } catch (e) {
      this.busy = false;
      this.error = errorText(e);
      this.render();
      return;
    }
    this.close();
    new Notice(`Storage keys of “${labelOf(this.share)}” changed on this device.`);
    void this.plugin.sync(true);
  }
}

/** A folder shared with a passphrase: how to share it again with members. Nothing is converted. */
class ShareAgainModal extends Modal {
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
    this.setTitle(`Share “${labelOf(s)}” again with members`);
    c.createEl('p', {
      cls: 'coffer-intro',
      text:
        'With members, each person joins with an invite of their own, which you can remove later, and only those who may edit can change the folder. ' +
        'A folder shared with one passphrase can not be turned into that. To share it again with members:',
    });
    const steps = c.createEl('ol', { cls: 'coffer-what' });
    steps.createEl('li', { text: 'Stop sharing it on this device. Its files stay where they are.' });
    steps.createEl('li', { text: 'Add a shared folder → Share a folder, choose this folder again, and storage that holds nothing yet.' });
    steps.createEl('li', { text: 'In Members, invite each person. Each of them stops sharing the old folder, then joins with their invite.' });
    const row = buttonRow(c);
    button(row, 'Close', () => this.close());
    button(row, 'Stop sharing on this device…', () => {
      this.close();
      confirmStopSharing(this.plugin, s);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Owner: before taking out of storage the changes no member who may write made, what that does. */
export class RemoveUnverifiedModal extends Modal {
  private plugin: CofferPlugin;
  private share: Share;
  private error = '';
  private busy = false;

  constructor(app: App, plugin: CofferPlugin, share: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal', 'coffer-share-modal');
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    this.setTitle('Remove changes that were not signed by a member?');
    c.createEl('p', {
      cls: 'coffer-intro',
      text: `The storage of “${labelOf(this.share)}” holds a change that no member who may edit it made. Removing takes that change, and everything after it, out of storage.`,
    });
    const what = c.createEl('ul', { cls: 'coffer-what' });
    what.createEl('li', { text: 'Members’ devices never build on such a change, so nothing a member made is lost.' });
    what.createEl('li', { text: 'If storage was put back from an older copy, changes members made since are kept, signed again by this device.' });
    what.createEl('li', { text: 'The files on this device are untouched. Syncing then carries on, here and on every member’s device.' });
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close()).setDisabled(this.busy);
    button(row, this.busy ? 'Removing…' : 'Remove them', () => this.run(), 'warning').setDisabled(this.busy);
  }

  private async run(): Promise<void> {
    this.busy = true;
    this.error = '';
    this.render();
    try {
      const n = await this.plugin.removeUnverifiable(this.share);
      this.close();
      new Notice(n ? `Removed ${n === 1 ? 'one change' : `${n} changes`} not made by a member from “${labelOf(this.share)}”. Syncing carries on.` : `Nothing needed removing from “${labelOf(this.share)}”. Syncing carries on.`);
    } catch (e) {
      this.busy = false;
      this.error = `Could not remove them: ${errorText(e)}`;
      this.render();
    }
  }
}
