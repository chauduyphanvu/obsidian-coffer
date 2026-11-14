import { Modal, Notice, PluginSettingTab, type App, type ButtonComponent, type Setting, type SettingDefinitionItem, type SettingGroupItem } from 'obsidian';
import { PassphraseUnknownError } from '../core/engine.ts';
import { conflictOriginal } from '../core/paths.ts';
import { errorText } from '../core/text.ts';
import { chooseDeferred } from './deferred.ts';
import type CofferPlugin from './main.ts';
import { resolveConflict } from './resolve.ts';
import { describeStorage, hasStorageAddress, labelOf, parseNumberSetting, passphraseProblem, siteAtVaultStorage, type Share } from './settings.ts';
import { WhatsSharedModal } from './byproperty-ui.ts';
import { PublishModal } from './publish-ui.ts';
import { momentLabel } from './restore.ts';
import { SetupModal } from './setup.ts';
import { renderDevices } from './devices.ts';
import { RemoveUnverifiedModal } from './people.ts';
import { confirmStopSharing, downloadAgain, renderShares } from './sharing.ts';
import { SendSuggestionModal } from './inbox.ts';
import { sentNote } from './suggestions.ts';
import { isConflictProblem, isUnsentProblem, leftInStorage, passphraseFailure, quietText, type Problem } from './status.ts';
import { button, buttonRow, field, message, openLink, passphraseFields, statusLine } from './ui.ts';

type SecretKey = 'accessKeySecret' | 'secretKeySecret' | 'passphraseSecret' | 'webdavPasswordSecret';
type TextKey = 'endpoint' | 'region' | 'bucket' | 'prefix' | 'deviceName' | 'webdavUrl' | 'webdavUser';
type NumberKey = 'intervalMinutes' | 'changeDelaySeconds' | 'pollSeconds' | 'autoCleanDays' | 'retentionDays' | 'maxFileSizeMB' | 'deferAboveMB' | 'concurrency';
type ToggleKey = 'pathStyle' | 'syncOnStart' | 'syncConfigDir' | 'compression' | 'readOnly';
type SiteTextKey = 'endpoint' | 'region' | 'bucket' | 'prefix' | 'webdavUrl' | 'webdavUser' | 'title' | 'home' | 'url';
type SiteSecretKey = 'accessKeySecret' | 'secretKeySecret' | 'webdavPasswordSecret';

const TRIMMED = new Set<string>(['endpoint', 'region', 'bucket', 'prefix', 'deviceName', 'webdavUrl', 'webdavUser']);

export class SettingsTab extends PluginSettingTab {
  private plugin: CofferPlugin;

  constructor(app: App, plugin: CofferPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    Object.assign(this.plugin.settings, { [key]: typeof value === 'string' && TRIMMED.has(key) ? value.trim() : value });
    await this.plugin.saveSettings();
    if (key === 'storageType') this.refreshDomState();
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    const plugin = this.plugin;
    const s = plugin.settings;
    const webdav = () => s.storageType === 'webdav';
    const s3 = () => s.storageType !== 'webdav';

    const text = (name: string, desc: string, key: TextKey, placeholder = '', visible?: () => boolean): SettingGroupItem => ({
      name,
      desc,
      visible,
      control: { type: 'text', key, placeholder },
    });
    const toggle = (name: string, desc: string, key: ToggleKey, visible?: () => boolean): SettingGroupItem => ({ name, desc, visible, control: { type: 'toggle', key } });
    // A plain password box: typing replaces the stored secret; the value itself is never shown.
    const secret = (name: string, desc: string, key: SecretKey, id: string, visible?: () => boolean): SettingGroupItem => ({
      name,
      desc,
      visible,
      render: (setting) => {
        setting.addText((t) => {
          t.inputEl.type = 'password';
          t.inputEl.setAttrs({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false' });
          t.setPlaceholder(plugin.secret(s[key]) ? 'Saved on this device' : 'Not set');
          t.onChange((v) => v && void plugin.setSecret(key, id, v));
        });
      },
    });
    // Not Obsidian's number control, which stores 0 when the box is cleared: here a cleared or invalid entry changes nothing.
    const number = (name: string, desc: string, key: NumberKey, min: number, aliases?: string[]): SettingGroupItem => ({
      name,
      desc,
      aliases,
      render: (setting) => {
        setting.addText((t) => {
          t.inputEl.type = 'number';
          t.inputEl.inputMode = 'numeric';
          t.setValue(String(s[key])).onChange((v) => {
            const n = parseNumberSetting(v, min);
            if (n === null) return;
            s[key] = n;
            void plugin.saveSettings();
            this.refreshDomState();
          });
        });
      },
    });
    const action = (name: string, desc: string, label: string, run: () => unknown, disabled?: () => boolean): SettingGroupItem => ({
      name,
      desc,
      render: (setting) => {
        let button!: ButtonComponent;
        setting.addButton((b) => (button = b.setButtonText(label).setDisabled(disabled?.() ?? false).onClick(() => void run())));
        // What disables it can change while this page is open, as with the toggle on it.
        if (disabled) return plugin.onChange(() => button.setDisabled(disabled()));
      },
    });

    // The website's settings are one object of their own, so these read and write it rather than going through `setControlValue`.
    const site = () => plugin.settings.site;
    const siteWebdav = () => site().storageType === 'webdav';
    const siteS3 = () => !siteWebdav();
    const siteText = (name: string, desc: string, key: SiteTextKey, placeholder = '', visible?: () => boolean, aliases: string[] = []): SettingGroupItem => ({
      name,
      desc,
      visible,
      aliases: ['website', 'publish', ...aliases],
      render: (setting) => {
        setting.addText((t) => {
          t.inputEl.setAttrs({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' });
          t.setPlaceholder(placeholder)
            .setValue(site()[key])
            .onChange((v) => {
              site()[key] = v.trim();
              void plugin.saveSettings();
              // The warning about the location follows what is typed.
              this.refreshDomState();
            });
        });
      },
    });
    const siteToggle = (name: string, desc: string, key: 'pathStyle', visible?: () => boolean): SettingGroupItem => ({
      name,
      desc,
      visible,
      aliases: ['website', 'publish'],
      render: (setting) => {
        setting.addToggle((t) =>
          t.setValue(site()[key]).onChange((v) => {
            site()[key] = v;
            void plugin.saveSettings();
          }),
        );
      },
    });
    const siteSecret = (name: string, key: SiteSecretKey, id: string, visible?: () => boolean): SettingGroupItem => ({
      name,
      visible,
      aliases: ['website', 'publish'],
      render: (setting) => {
        setting.addText((t) => {
          t.inputEl.type = 'password';
          t.inputEl.setAttrs({ autocapitalize: 'off', autocorrect: 'off', autocomplete: 'off', spellcheck: 'false' });
          t.setPlaceholder(plugin.secret(site()[key]) ? 'Saved on this device' : 'Not set');
          t.onChange((v) => v && void plugin.setSiteSecret(key, id, v));
        });
      },
    });
    const lastPublished = (at: number) => (at ? `Last published ${momentLabel(at, Date.now())}.` : 'Not published yet.');

    return [
      { name: 'Sync status', searchable: false, render: (setting) => this.renderCard(setting) },
      {
        name: 'Add another device',
        desc: 'Install Coffer there, choose "I already sync another device", and paste this link. It is encrypted with your passphrase.',
        aliases: ['setup link', 'new device'],
        visible: () => plugin.configured(),
        render: (setting) => {
          // Made before the tap: making it takes a moment, and a phone only lets the tap itself write to the clipboard.
          const link = plugin.setupLink();
          setting.addButton((b) => {
            const ready = () => void b.setButtonText('Copy setup link').setDisabled(false);
            b.setButtonText('Preparing…').setDisabled(true).onClick(async () => {
              try {
                // Settings can be their own window, and only the focused window may write to the clipboard.
                await activeWindow.navigator.clipboard.writeText(await link);
                new Notice('Setup link copied.');
              } catch (e) {
                new Notice(`Could not copy the setup link: ${errorText(e)}`, 8000);
              }
            });
            link.then(ready, ready);
          });
        },
      },
      {
        type: 'group',
        heading: 'Devices',
        items: [{ name: 'Devices', aliases: ['forget a device'], render: (setting) => renderDevices(block(setting), plugin) }],
      },
      {
        type: 'group',
        heading: 'Shared folders',
        visible: () => plugin.configured(),
        items: [
          {
            name: 'Shared folders',
            aliases: ['share a folder', 'invite link'],
            render: (setting) => plugin.onChange(renderShares(block(setting), plugin)),
          },
        ],
      },
      {
        type: 'group',
        items: [
          {
            type: 'page',
            name: 'Storage and passphrase',
            displayValue: () => (hasStorageAddress(s) ? describeStorage(s) : 'Not set up'),
            items: [
              {
                name: 'Storage type',
                aliases: ['S3', 'WebDAV', 'bucket'],
                control: { type: 'dropdown', key: 'storageType', options: { s3: 'S3-compatible bucket', webdav: 'WebDAV folder' } },
              },
              text('Folder address', 'Created if missing.', 'webdavUrl', 'https://cloud.example.com/remote.php/dav/files/me/obsidian', webdav),
              text('User name', '', 'webdavUser', '', webdav),
              secret('Password', '', 'webdavPasswordSecret', 'coffer-webdav-password', webdav),
              text('Endpoint', '', 'endpoint', 'https://<account>.r2.cloudflarestorage.com', s3),
              text('Region', '"auto" for Cloudflare R2.', 'region', 'auto', s3),
              text('Bucket', '', 'bucket', '', s3),
              text('Folder in bucket', 'Every device syncing this vault must use the same folder.', 'prefix', '', s3),
              secret('Access key ID', '', 'accessKeySecret', 'coffer-access-key', s3),
              secret('Secret access key', '', 'secretKeySecret', 'coffer-secret-key', s3),
              toggle('Path-style addresses', 'On for R2, B2, MinIO and most others; off for Amazon S3.', 'pathStyle', s3),
              secret('Passphrase', 'The one every device uses. Typing here only changes it on this device.', 'passphraseSecret', 'coffer-passphrase'),
              {
                ...toggle(
                  'Only receive changes',
                  'This device never writes to storage, so keys that may only read are enough. What you change or add here stays here and is listed as not sent. A file you delete comes back from storage. If storage changes a file you changed, the two are merged here, or kept side by side.',
                  'readOnly',
                ),
                aliases: ['read-only'],
              },
              action('Check the connection', 'Writes, reads and deletes a small test object.', 'Check', () => plugin.checkStorage()),
              action(
                'Change the passphrase on all devices',
                'Nothing is re-uploaded. Other devices ask for the new one.',
                'Change',
                () => new PassphraseModal(this.app, plugin).open(),
                () => !plugin.configured() || s.readOnly,
              ),
              action('Set up again', 'Walks through connecting storage, or joining with a setup link.', 'Start', () => new SetupModal(this.app, plugin, 'start').open()),
            ],
          },
          {
            type: 'page',
            name: 'When to sync',
            displayValue: () => (s.intervalMinutes ? `on changes, every ${s.intervalMinutes} min` : 'on changes'),
            items: [
              toggle('When Obsidian starts', '', 'syncOnStart'),
              number('After an edit (seconds)', 'Waits this long after the last edit.', 'changeDelaySeconds', 2, ['delay']),
              number('Every (minutes)', '0 turns the timer off.', 'intervalMinutes', 0, ['interval', 'timer']),
              number(
                'Look for other devices\' changes every (seconds)',
                'Only while Obsidian is on screen, six times as often (no faster than every 5 seconds) for two minutes after you switch to it or changes arrive, and half as often after ten minutes without either; 0 turns it off.',
                'pollSeconds',
                0,
                ['poll'],
              ),
            ],
          },
          {
            type: 'page',
            name: 'What to sync',
            displayValue: () => `files up to ${s.maxFileSizeMB || 'any'} MB`,
            items: [
              toggle(
                'Settings, themes and plugins',
                `The ${this.app.vault.configDir} folder, except the workspace layout. Settings changed on two devices are combined; where both changed the same one, the device that synced first wins.`,
                'syncConfigDir',
              ),
              number('Largest file (MB)', 'Larger files stay on this device and are listed as problems. 0 means no limit.', 'maxFileSizeMB', 0, ['size limit']),
              number(
                'Download only when asked: files larger than (MB)',
                'Larger files stay in storage and take no room here until you choose them from the list below. 0 downloads every file. Files this device already has keep syncing.',
                'deferAboveMB',
                0,
                ['attachments', 'large files', 'defer'],
              ),
              {
                name: 'Files left in storage',
                desc: 'Choosing one downloads it and opens it.',
                aliases: ['download', 'attachments'],
                visible: () => s.deferAboveMB > 0,
                render: (setting) => {
                  setting.addButton((b) => b.setButtonText('Choose…').onClick(() => void chooseDeferred(plugin)));
                  const draw = () => setting.setName(leftInStorage(plugin.deferredCounts()));
                  draw();
                  return plugin.onChange(draw);
                },
              },
              {
                name: 'Leave out',
                desc:
                  'One pattern per line. * matches within a folder, ** across folders, a trailing / a whole folder. ' +
                  'Files and folders whose name starts with a dot, which Obsidian does not show, are always left out on this device; the settings folder has its own switch above.',
                aliases: ['exclude', 'ignore'],
                control: { type: 'textarea', key: 'exclude', placeholder: 'Private/\n*.tmp' },
              },
            ],
          },
          {
            type: 'page',
            name: 'Conflicts and history',
            displayValue: () => `versions kept ${s.retentionDays} days`,
            items: [
              {
                name: 'A note edited on two devices',
                desc: 'Overlapping edits and non-text files always keep both versions.',
                aliases: ['conflict', 'merge'],
                control: { type: 'dropdown', key: 'conflictStrategy', options: { merge: 'Merge the edits', copy: 'Keep both versions' } },
              },
              number('Keep old versions (days)', 'Any synced version can be restored for this long.', 'retentionDays', 1, ['retention', 'version history']),
              number('Remove expired versions every (days)', '0 leaves it to the command.', 'autoCleanDays', 0, ['cleanup']),
            ],
          },
          {
            type: 'page',
            name: 'Website',
            displayValue: () => (plugin.siteConfigured() ? 'Set up' : 'Not set up'),
            items: [
              {
                name: 'Publish notes as a website',
                desc:
                  'Notes whose properties say publish: true become web pages, with the pictures and files they show, and are uploaded to the place below. They are not encrypted: anyone with the address can read them. ' +
                  'Use a bucket or folder of its own, never the one this vault syncs to. If you use Obsidian Publish, the notes it publishes carry the same property and will be published here too.',
                aliases: ['publish', 'static site', 'website', 'web page'],
              },
              {
                name: 'Storage type',
                aliases: ['website', 'publish', 'S3', 'WebDAV', 'bucket'],
                render: (setting) => {
                  setting.addDropdown((d) =>
                    d
                      .addOptions({ s3: 'S3-compatible', webdav: 'WebDAV' })
                      .setValue(site().storageType)
                      .onChange((v) => {
                        site().storageType = v === 'webdav' ? 'webdav' : 's3';
                        void plugin.saveSettings();
                        this.refreshDomState();
                      }),
                  );
                },
              },
              siteText('Endpoint', '', 'endpoint', 'https://<account>.r2.cloudflarestorage.com', siteS3),
              siteText('Region', '"auto" for Cloudflare R2.', 'region', 'auto', siteS3),
              siteText('Bucket', '', 'bucket', '', siteS3),
              siteText('Folder in the bucket', 'Can be empty, for the top of the bucket.', 'prefix', '', siteS3),
              siteToggle('Path-style addresses', 'On for R2, B2, MinIO and most others; off for Amazon S3.', 'pathStyle', siteS3),
              siteSecret('Access key', 'accessKeySecret', 'coffer-access-key', siteS3),
              siteSecret('Secret key', 'secretKeySecret', 'coffer-secret-key', siteS3),
              siteText('Address', 'Created if missing.', 'webdavUrl', 'https://cloud.example.com/remote.php/dav/files/me/website', siteWebdav),
              siteText('User name', '', 'webdavUser', '', siteWebdav),
              siteSecret('Password', 'webdavPasswordSecret', 'coffer-webdav-password', siteWebdav),
              {
                name: 'This is where the vault or a shared folder is stored, or a folder that holds it or is inside it.',
                desc: 'Choose another bucket or folder for the website.',
                searchable: false,
                visible: () => siteAtVaultStorage(site(), plugin.settings),
                render: (setting) => setting.settingEl.addClass('coffer-publish-warning'),
              },
              siteText('Website title', 'Shown at the top of every page.', 'title', 'Notes', undefined, ['name']),
              siteText(
                'Front page',
                'The note shown first, as its path in the vault, for example Home.md. Leave empty for a list of the pages.',
                'home',
                '',
                undefined,
                ['home page', 'index'],
              ),
              siteText(
                'Public address',
                'Where people open the website, for example https://notes.example.com. Only used for the link Coffer shows after publishing.',
                'url',
                'https://notes.example.com',
                undefined,
                ['url', 'link'],
              ),
              {
                name: 'Publish',
                aliases: ['website', 'publish', 'upload'],
                render: (setting) => {
                  let publish!: ButtonComponent;
                  const draw = () => {
                    setting.setDesc(lastPublished(site().lastPublished));
                    publish.setDisabled(!plugin.siteConfigured() || siteAtVaultStorage(site(), plugin.settings));
                  };
                  setting.addButton((b) => (publish = b.setButtonText('Publish…').onClick(() => new PublishModal(this.app, plugin).open())));
                  draw();
                  // Keys typed on this page, and a publish finishing, change both.
                  return plugin.onChange(draw);
                },
              },
            ],
          },
          {
            type: 'page',
            name: 'Advanced',
            items: [
              text('Device name', 'Shown in version history and conflict copies.', 'deviceName'),
              number('Parallel transfers', '', 'concurrency', 1, ['concurrency']),
              toggle('Compress text before encrypting', '', 'compression'),
            ],
          },
        ],
      },
    ];
  }

  /** The status card at the top: what sync is doing, and the buttons that matter right now. */
  private renderCard(setting: Setting): () => void {
    const plugin = this.plugin;
    const card = block(setting);
    card.addClass('coffer-card');
    const draw = () => {
      card.empty();
      const configured = plugin.configured();
      const { text, tone } = plugin.statusLine();
      statusLine(card, text, tone);
      if (configured) card.createDiv({ cls: 'coffer-sub', text: describeStorage(plugin.settings) });
      if (!configured) {
        card.createEl('p', {
          cls: 'coffer-intro',
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
    draw();
    return plugin.onChange(() => {
      draw();
      // Finishing setup while this tab is open shows the parts that need a configured vault.
      this.refreshDomState();
    });
  }
}

/** A settings row emptied to hold one of Coffer's own blocks, laid out as a block rather than a name and a control. */
function block(setting: Setting): HTMLElement {
  setting.settingEl.empty();
  setting.settingEl.addClass('coffer-block');
  return setting.settingEl;
}

/** Every open problem with what can be done about it, or "all good". */
export class ProblemsModal extends Modal {
  private plugin: CofferPlugin;
  private unsubscribe?: () => void;

  constructor(app: App, plugin: CofferPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
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
    if (!problems.length && !plugin.running) c.createEl('p', { cls: 'coffer-intro', text: quietText(plugin.offline(), plugin.waiting()) });
    for (const p of problems) this.problem(c, p);
    button(buttonRow(c), plugin.running ? 'Syncing…' : 'Sync now', () => plugin.sync(true), problems.length ? 'plain' : 'cta').setDisabled(plugin.running);
  }

  private problem(parent: HTMLElement, p: Problem): void {
    const plugin = this.plugin;
    // Its actions act on the shared folder it is about, or on the vault.
    const share = p.share ? plugin.settings.shares.find((s) => s.id === p.share) : undefined;
    if (p.share && !share) return;
    const card = parent.createDiv({ cls: `coffer-problem is-${p.severity}` });
    card.createDiv({ cls: 'coffer-problem-title', text: p.title });
    card.createDiv({ cls: 'coffer-problem-detail', text: p.detail });
    if (p.files?.length) {
      const list = card.createDiv({ cls: 'coffer-files' });
      const close = () => this.close();
      for (const path of p.files.slice(0, 20)) {
        const row = list.createDiv({ cls: 'coffer-file' });
        row.createSpan({ text: path });
        if (isConflictProblem(p)) {
          openLink(row, this.app, 'Original', conflictOriginal(path), close);
          openLink(row, this.app, 'Copy', path, close);
          button(row, 'Resolve', () => resolveConflict(plugin, path), 'cta');
        } else openLink(row, this.app, 'Open', path, close);
      }
      if (p.files.length > 20) list.createDiv({ cls: 'coffer-hint', text: `…and ${p.files.length - 20} more` });
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
        // Notes shared by a property only send: keeping the files keeps them for the others, not here.
        button(row, share?.property ? `Keep them in “${share.property}”` : 'Keep all files', () => plugin.keepAllFiles(share), 'cta');
        button(row, share?.property ? `Delete them from “${share.property}” too` : 'Delete them everywhere', () => plugin.sync(true, share ? share.id : true), 'warning');
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
      case 'remove-unverified':
        if (!share) break;
        button(row, 'Remove changes that were not signed by a member…', () => new RemoveUnverifiedModal(this.app, plugin, share).open(), 'warning');
        break;
      case 'stop-sharing':
        if (!share) break;
        button(row, 'Stop sharing on this device', () => confirmStopSharing(plugin, share));
        break;
      case 'whats-shared':
        if (!share) break;
        button(row, "What's shared", () => new WhatsSharedModal(this.app, plugin, share).open(), 'cta');
        break;
    }
    if (share && isUnsentProblem(p) && plugin.canSuggest(share)) {
      message(card, sentNote(share, plugin.unsentOf(share), plugin.standingOf(share)?.owner ?? ''), 'coffer-hint');
      // Below the note, which says what was sent before.
      card.appendChild(row);
      button(row, 'Send as a suggestion…', () => new SendSuggestionModal(this.app, plugin, share).open(), 'cta');
    }
  }
}

/** After the history in storage turned out not to be the one this device saw: what carrying on means, and a confirmation. */
class AcceptStorageModal extends Modal {
  private plugin: CofferPlugin;
  private share?: Share;
  private busy = false;
  private error = '';

  constructor(app: App, plugin: CofferPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    this.setTitle(this.share ? `Carry on with “${labelOf(this.share)}” from storage as it is?` : 'Carry on from storage as it is?');
    c.createEl('p', {
      cls: 'coffer-intro',
      text: 'What storage holds is not what this device last saw there: part of the sync history was taken back or replaced.',
    });
    const what = c.createEl('ul', { cls: 'coffer-what' });
    what.createEl('li', { text: 'That is expected right after storage was restored from a backup or an older copy on purpose. Then carry on.' });
    what.createEl('li', { text: 'If nobody did that, someone else may have changed what is stored. Cancel, leave sync stopped, and find out who can reach your storage.' });
    what.createEl('li', {
      text: this.share?.property
        ? 'Carrying on, storage is taken as it is now and your notes are sent again where they differ. Nothing is deleted, and nothing is written into your vault.'
        : "Carrying on, this device takes storage as it is now and syncs with it. Nothing is deleted. Where a file differs, both versions are kept: storage's under the name, this device's beside it with “(conflict …)” in its name. Settings are combined instead.",
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
  private plugin: CofferPlugin;
  private share?: Share;
  private value = '';
  private error = '';

  constructor(app: App, plugin: CofferPlugin, share?: Share) {
    super(app);
    this.plugin = plugin;
    this.share = share;
  }

  onOpen(): void {
    this.modalEl.addClass('coffer-modal');
    this.render();
  }

  private render(): void {
    const c = this.contentEl;
    c.empty();
    const share = this.share;
    this.setTitle(share ? `Passphrase of “${share.folder}”` : 'Enter the passphrase');
    c.createEl('p', {
      cls: 'coffer-intro',
      text: share
        ? 'Use the passphrase this shared folder was shared with. Whoever shared it can tell you.'
        : 'Use the passphrase your other devices use now. If it was changed elsewhere, that is the new one.',
    });
    field(c, 'Passphrase', { value: this.value, password: true }, (v) => (this.value = v));
    message(c, this.error);
    button(buttonRow(c), 'Save and sync', async () => {
      if (!this.value) return;
      await this.plugin.setSecret('passphraseSecret', 'coffer-passphrase', this.value, share);
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
  private plugin: CofferPlugin;

  constructor(app: App, plugin: CofferPlugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen(): void {
    const entry = { passphrase: '', repeat: '' };
    const c = this.contentEl;
    this.modalEl.addClass('coffer-modal');
    this.setTitle('Change the passphrase');
    c.createEl('p', { cls: 'coffer-intro', text: 'Nothing is re-uploaded. Each other device asks for the new passphrase once.' });
    passphraseFields(c, entry, { label: 'New passphrase' });
    button(buttonRow(c), 'Change passphrase', async () => {
      const problem = passphraseProblem(entry.passphrase, entry.repeat);
      if (problem) {
        new Notice(problem);
        return;
      }
      try {
        await this.plugin.changePassphrase(entry.passphrase);
        this.close();
        new Notice('Passphrase changed. Enter the new one on your other devices.');
      } catch (e) {
        if (!(e instanceof PassphraseUnknownError)) {
          new Notice(passphraseFailure(e), 10_000);
          return;
        }
        this.close();
        new Notice(
          this.plugin.fragment(
            'The passphrase may have changed',
            'The connection failed before storage said whether it took the new one. This device finds out at its next sync and keeps whichever works. If your other devices ask for a passphrase, try the new one.',
          ),
          0,
        );
      }
    }, 'cta');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
