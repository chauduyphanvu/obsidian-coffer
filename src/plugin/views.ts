import { Modal, Notice, PluginSettingTab, SecretComponent, Setting, SuggestModal, type App } from 'obsidian';
import type { Version } from '../core/types.ts';
import type SelfSyncPlugin from './main.ts';
import type { Settings } from './settings.ts';

export class HistoryModal extends SuggestModal<Version> {
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

export class SettingsTab extends PluginSettingTab {
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
