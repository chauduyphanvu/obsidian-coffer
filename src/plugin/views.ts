import { Modal, Notice, PluginSettingTab, Setting, type App } from 'obsidian';
import { conflictOriginal } from '../core/paths.ts';
import { errorText } from '../core/text.ts';
import type SelfSyncPlugin from './main.ts';
import { resolveConflict } from './resolve.ts';
import { describeStorage, hasStorageAddress, parseNumberSetting, type Settings, type Share } from './settings.ts';
import { SetupModal } from './setup.ts';
import { renderDevices } from './devices.ts';
import { confirmStopSharing, downloadAgain, renderShares } from './sharing.ts';
import type { Problem } from './status.ts';
import { button, buttonRow, field, message, openLink, statusLine } from './ui.ts';

type SecretKey = 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret';

export class SettingsTab extends PluginSettingTab {
  private plugin: SelfSyncPlugin;
  private unsubscribe?: () => void;
  private openSections = new Set<string>();

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  hide(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  display(): void {
    const { containerEl } = this;
    const plugin = this.plugin;
    const s = plugin.settings;
    const save = () => void plugin.saveSettings();
    this.hide();
    containerEl.empty();
    containerEl.addClass('self-sync-settings');

    const card = containerEl.createDiv({ cls: 'self-sync-card' });
    const renderCard = () => {
      card.empty();
      const configured = plugin.configured();
      const { text, tone } = plugin.statusLine();
      statusLine(card, text, tone);
      if (configured) card.createDiv({ cls: 'self-sync-sub', text: describeStorage(s) });
      if (!configured) {
        card.createEl('p', {
          cls: 'self-sync-intro',
          text: 'Sync this vault across your devices through storage you own. Files are encrypted on this device before they leave it.',
        });
        const setup = buttonRow(card);
        button(setup, 'This is my first device', () => new SetupModal(this.app, plugin, 'new').open(), 'cta');
        button(setup, 'I already sync another device', () => new SetupModal(this.app, plugin, 'join').open());
        return;
      }
      const row = buttonRow(card);
      button(row, plugin.running ? 'Syncing…' : 'Sync now', () => plugin.sync(true), 'cta').setDisabled(plugin.running);
      const problems = plugin.problems();
      if (problems.length) {
        const critical = problems.some((p) => p.severity === 'critical');
        button(row, critical ? (problems.length === 1 ? 'See the problem' : `See ${problems.length} problems`) : 'Review', () => plugin.openStatus(), critical ? 'warning' : 'plain');
      }
    };
    renderCard();
    let drawShares: (() => void) | undefined;
    this.unsubscribe = plugin.onChange(() => {
      renderCard();
      drawShares?.();
    });

    const section = (id: string, title: string, summary = '') => {
      const d = containerEl.createEl('details', { cls: 'self-sync-section' });
      d.open = this.openSections.has(id);
      d.addEventListener('toggle', () => (d.open ? this.openSections.add(id) : this.openSections.delete(id)));
      const sum = d.createEl('summary');
      sum.createSpan({ cls: 'self-sync-section-title', text: title });
      if (summary) sum.createSpan({ cls: 'self-sync-section-summary', text: summary });
      return d;
    };
    const text = (el: HTMLElement, name: string, desc: string, key: 'endpoint' | 'region' | 'bucket' | 'prefix' | 'deviceName' | 'webdavUrl' | 'webdavUser', placeholder = '') =>
      new Setting(el).setName(name).setDesc(desc).addText((t) =>
        t.setPlaceholder(placeholder).setValue(s[key]).onChange((v) => {
          s[key] = v.trim();
          save();
        }),
      );
    // A plain password box: typing replaces the stored secret; the value itself is never shown.
    const secret = (el: HTMLElement, name: string, desc: string, key: SecretKey, id: string) =>
      new Setting(el).setName(name).setDesc(desc).addText((t) => {
        t.inputEl.type = 'password';
        t.inputEl.setAttrs({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false' });
        t.setPlaceholder(plugin.secret(s[key]) ? 'Saved on this device' : 'Not set');
        t.onChange((v) => v && void plugin.setSecret(key, id, v));
      });
    const number = (el: HTMLElement, name: string, desc: string, key: 'intervalMinutes' | 'changeDelaySeconds' | 'pollSeconds' | 'autoCleanDays' | 'retentionDays' | 'maxFileSizeMB' | 'concurrency', min: number) =>
      new Setting(el).setName(name).setDesc(desc).addText((t) => {
        t.inputEl.type = 'number';
        t.inputEl.inputMode = 'numeric';
        t.setValue(String(s[key])).onChange((v) => {
          const n = parseNumberSetting(v, min);
          if (n === null) return;
          s[key] = n;
          save();
        });
      });
    const toggle = (el: HTMLElement, name: string, desc: string, key: 'pathStyle' | 'syncOnStart' | 'syncConfigDir' | 'compression') =>
      new Setting(el).setName(name).setDesc(desc).addToggle((t) =>
        t.setValue(s[key]).onChange((v) => {
          s[key] = v;
          save();
        }),
      );

    if (plugin.configured()) {
      new Setting(containerEl)
        .setName('Add another device')
        .setDesc('Install Self Sync there, choose "I already sync another device", and paste this link. It is encrypted with your passphrase.')
        .addButton((b) =>
          b.setButtonText('Copy setup link').onClick(async () => {
            try {
              // Settings can be their own window, and only the focused window may write to the clipboard.
              await activeWindow.navigator.clipboard.writeText(await plugin.setupLink());
              new Notice('Setup link copied.');
            } catch (e) {
              new Notice(`Could not copy the setup link: ${errorText(e)}`, 8000);
            }
          }),
        );
    }
    renderDevices(containerEl, plugin);
    if (plugin.configured()) drawShares = renderShares(containerEl, plugin);

    const storage = section('storage', 'Storage and passphrase', hasStorageAddress(s) ? describeStorage(s) : 'Not set up');
    new Setting(storage)
      .setName('Storage type')
      .addDropdown((d) =>
        d
          .addOption('s3', 'S3-compatible bucket')
          .addOption('webdav', 'WebDAV folder')
          .setValue(s.storageType)
          .onChange((v) => {
            s.storageType = v as Settings['storageType'];
            save();
            this.display();
          }),
      );
    if (s.storageType === 'webdav') {
      text(storage, 'Folder address', 'Created if missing.', 'webdavUrl', 'https://cloud.example.com/remote.php/dav/files/me/obsidian');
      text(storage, 'User name', '', 'webdavUser');
      secret(storage, 'Password', '', 'webdavPasswordSecret', 'self-sync-webdav-password');
    } else {
      text(storage, 'Endpoint', '', 'endpoint', 'https://<account>.r2.cloudflarestorage.com');
      text(storage, 'Region', '"auto" for Cloudflare R2.', 'region', 'auto');
      text(storage, 'Bucket', '', 'bucket');
      text(storage, 'Folder in bucket', 'Every device syncing this vault must use the same folder.', 'prefix');
      secret(storage, 'Access key ID', '', 'accessKeySecret', 'self-sync-access-key');
      secret(storage, 'Secret access key', '', 'secretKeySecret', 'self-sync-secret-key');
      toggle(storage, 'Path-style addresses', 'On for R2, B2, MinIO and most others; off for Amazon S3.', 'pathStyle');
    }
    secret(storage, 'Passphrase', 'The one every device uses. Typing here only changes it on this device.', 'passphraseSecret', 'self-sync-passphrase');
    new Setting(storage)
      .setName('Check the connection')
      .setDesc('Writes, reads and deletes a small test object.')
      .addButton((b) => b.setButtonText('Check').onClick(() => void plugin.checkStorage()));
    new Setting(storage)
      .setName('Change the passphrase on all devices')
      .setDesc('Nothing is re-uploaded. Other devices ask for the new one.')
      .addButton((b) => b.setButtonText('Change').setDisabled(!plugin.configured()).onClick(() => new PassphraseModal(this.app, plugin).open()));
    new Setting(storage)
      .setName('Set up again')
      .setDesc('Walks through connecting storage, or joining with a setup link.')
      .addButton((b) => b.setButtonText('Start').onClick(() => new SetupModal(this.app, plugin, 'start').open()));

    const when = section('when', 'When to sync', s.intervalMinutes ? `on changes, every ${s.intervalMinutes} min` : 'on changes');
    toggle(when, 'When Obsidian starts', '', 'syncOnStart');
    number(when, 'After an edit (seconds)', 'Waits this long after the last edit.', 'changeDelaySeconds', 2);
    number(when, 'Every (minutes)', '0 turns the timer off.', 'intervalMinutes', 0);
    number(when, 'Look for other devices\' changes every (seconds)', 'Only while Obsidian is on screen, six times as often (no faster than every 5 seconds) for two minutes after you switch to it or changes arrive, and half as often after ten minutes without either; 0 turns it off.', 'pollSeconds', 0);

    const what = section('what', 'What to sync', `files up to ${s.maxFileSizeMB || 'any'} MB`);
    toggle(
      what,
      'Settings, themes and plugins',
      `The ${this.app.vault.configDir} folder, except the workspace layout. Settings changed on two devices are combined; where both changed the same one, the device that synced first wins.`,
      'syncConfigDir',
    );
    number(what, 'Largest file (MB)', 'Larger files stay on this device and are listed as problems. 0 means no limit.', 'maxFileSizeMB', 0);
    new Setting(what)
      .setName('Leave out')
      .setDesc(
        'One pattern per line. * matches within a folder, ** across folders, a trailing / a whole folder. ' +
          'Files and folders whose name starts with a dot, which Obsidian does not show, are always left out on this device; the settings folder has its own switch above.',
      )
      .addTextArea((t) =>
        t.setPlaceholder('Private/\n*.tmp').setValue(s.exclude).onChange((v) => {
          s.exclude = v;
          save();
        }),
      );

    const history = section('history', 'Conflicts and history', `versions kept ${s.retentionDays} days`);
    new Setting(history)
      .setName('A note edited on two devices')
      .setDesc('Overlapping edits and non-text files always keep both versions.')
      .addDropdown((d) =>
        d
          .addOption('merge', 'Merge the edits')
          .addOption('copy', 'Keep both versions')
          .setValue(s.conflictStrategy)
          .onChange((v) => {
            s.conflictStrategy = v as Settings['conflictStrategy'];
            save();
          }),
      );
    number(history, 'Keep old versions (days)', 'Any synced version can be restored for this long.', 'retentionDays', 1);
    number(history, 'Remove expired versions every (days)', '0 leaves it to the command.', 'autoCleanDays', 0);

    const advanced = section('advanced', 'Advanced');
    text(advanced, 'Device name', 'Shown in version history and conflict copies.', 'deviceName');
    number(advanced, 'Parallel transfers', '', 'concurrency', 1);
    toggle(advanced, 'Compress text before encrypting', '', 'compression');
  }
}

/** Every open problem with what can be done about it, or "all good". */
export class ProblemsModal extends Modal {
  private plugin: SelfSyncPlugin;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: SelfSyncPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal');
    this.unsubscribe = this.plugin.onChange(() => this.render());
    this.render();
  }

  onClose(): void {
    this.unsubscribe?.();
    this.contentEl.empty();
  }

  private render(): void {
    const c = this.contentEl;
    const plugin = this.plugin;
    c.empty();
    const problems = plugin.problems();
    this.setTitle(problems.some((p) => p.severity === 'critical') ? 'Sync needs your attention' : 'Sync');
    const { text, tone } = plugin.statusLine();
    statusLine(c, text, tone);
    if (!plugin.configured()) {
      button(buttonRow(c), 'Set up sync', () => {
        this.close();
        new SetupModal(this.app, plugin, 'start').open();
      }, 'cta');
      return;
    }
    if (!problems.length) c.createEl('p', { cls: 'self-sync-intro', text: 'Everything is in sync.' });
    for (const p of problems) this.problem(c, p);
    button(buttonRow(c), plugin.running ? 'Syncing…' : 'Sync now', () => plugin.sync(true), problems.length ? 'plain' : 'cta').setDisabled(plugin.running);
  }

  private problem(parent: HTMLElement, p: Problem): void {
    const plugin = this.plugin;
    // Its actions act on the shared folder it is about, or on the vault.
    const share = p.share ? plugin.settings.shares.find((s) => s.id === p.share) : undefined;
    if (p.share && !share) return;
    const card = parent.createDiv({ cls: `self-sync-problem is-${p.severity}` });
    card.createDiv({ cls: 'self-sync-problem-title', text: p.title });
    card.createDiv({ cls: 'self-sync-problem-detail', text: p.detail });
    if (p.files?.length) {
      const list = card.createDiv({ cls: 'self-sync-files' });
      const close = () => this.close();
      for (const path of p.files.slice(0, 20)) {
        const row = list.createDiv({ cls: 'self-sync-file' });
        row.createSpan({ text: path });
        if (p.id.startsWith('conflicts')) {
          openLink(row, this.app, 'Original', conflictOriginal(path), close);
          openLink(row, this.app, 'Copy', path, close);
          button(row, 'Resolve', () => resolveConflict(plugin, path), 'cta');
        } else openLink(row, this.app, 'Open', path, close);
      }
      if (p.files.length > 20) list.createDiv({ cls: 'self-sync-hint', text: `…and ${p.files.length - 20} more` });
    }
    const row = buttonRow(card);
    switch (p.action) {
      case 'settings':
        button(row, 'Open settings', () => {
          this.close();
          const setting = (this.app as unknown as { setting: { open(): void; openTabById(id: string): void } }).setting;
          setting.open();
          setting.openTabById(plugin.manifest.id);
        });
        break;
      case 'passphrase':
        button(row, 'Enter the passphrase', () => new EnterPassphraseModal(this.app, plugin, share).open(), 'cta');
        break;
      case 'resolve-deletes':
        button(row, 'Keep all files', () => plugin.keepAllFiles(share), 'cta');
        button(row, 'Delete them everywhere', () => plugin.sync(true, share ? share.id : true), 'warning');
        break;
      case 'missing-folder':
        if (!share) break;
        button(row, 'Download it again', () => downloadAgain(plugin, share), 'cta');
        button(row, 'Stop sharing on this device', () => confirmStopSharing(plugin, share));
        break;
      case 'retry':
        button(row, 'Try again', () => plugin.sync(true));
        break;
      case 'accept-storage':
        button(row, 'Carry on from storage as it is…', () => new AcceptStorageModal(this.app, plugin, share).open(), 'warning');
        break;
    }
  }
}

/** After the history in storage turned out not to be the one this device saw: what carrying on means, and a confirmation. */
class AcceptStorageModal extends Modal {
  private plugin: SelfSyncPlugin;
  private share?: Share;
  private busy = false;
  private error = '';

  constructor(app: App, plugin: SelfSyncPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal');
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    this.setTitle(this.share ? `Carry on with “${this.share.folder}” from storage as it is?` : 'Carry on from storage as it is?');
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: 'What storage holds is not what this device last saw there: part of the sync history was taken back or replaced.',
    });
    const what = c.createEl('ul', { cls: 'self-sync-what' });
    what.createEl('li', { text: 'That is expected right after storage was restored from a backup or an older copy on purpose. Then carry on.' });
    what.createEl('li', { text: 'If nobody did that, someone else may have changed what is stored. Cancel, leave sync stopped, and find out who can reach your storage.' });
    what.createEl('li', {
      text: "Carrying on, this device takes storage as it is now and syncs with it. Nothing is deleted. Where a file differs, both versions are kept: storage's under the name, this device's beside it with “(conflict …)” in its name. Settings are combined instead.",
    });
    message(c, this.error);
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    button(row, this.busy ? 'Carrying on…' : 'Carry on from storage', () => this.accept(), 'warning').setDisabled(this.busy);
  }

  private async accept(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error = '';
    this.render();
    try {
      await this.plugin.acceptStorage(this.share);
      this.close();
    } catch (e) {
      this.busy = false;
      this.error = `Could not carry on: ${errorText(e)}`;
      this.render();
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** After "wrong passphrase": the one this device should use, for the vault or for one shared folder. */
class EnterPassphraseModal extends Modal {
  private plugin: SelfSyncPlugin;
  private share?: Share;
  private value = '';
  private error = '';

  constructor(app: App, plugin: SelfSyncPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('self-sync-modal');
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    const share = this.share;
    this.setTitle(share ? `Passphrase of “${share.folder}”` : 'Enter the passphrase');
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: share
        ? 'Use the passphrase this shared folder was shared with. Whoever shared it can tell you.'
        : 'Use the passphrase your other devices use now. If it was changed elsewhere, that is the new one.',
    });
    field(c, 'Passphrase', { value: this.value, password: true }, (v) => (this.value = v));
    message(c, this.error);
    button(buttonRow(c), 'Save and sync', async () => {
      if (!this.value) return;
      await this.plugin.setSecret('passphraseSecret', 'self-sync-passphrase', this.value, share);
      const out = await this.plugin.sync(true, false, true);
      if ((share ? out.shares?.get(share.id) : out)?.problem?.id === 'passphrase') {
        this.error = 'That is not it either.';
        this.render();
      } else this.close();
    }, 'cta');
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
    const c = this.contentEl;
    this.modalEl.addClass('self-sync-modal');
    this.setTitle('Change the passphrase');
    c.createEl('p', { cls: 'self-sync-intro', text: 'Nothing is re-uploaded. Each other device asks for the new passphrase once.' });
    field(c, 'New passphrase', { password: true }, (v) => (first = v));
    field(c, 'Repeat it', { password: true }, (v) => (second = v));
    button(buttonRow(c), 'Change passphrase', async () => {
      if (!first || first !== second) {
        new Notice('The two entries do not match.');
        return;
      }
      try {
        await this.plugin.changePassphrase(first);
        this.close();
        new Notice('Passphrase changed. Enter the new one on your other devices.');
      } catch (e) {
        new Notice(`Could not change the passphrase: ${errorText(e)}`, 10_000);
      }
    }, 'cta');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
