// The Devices block of the settings screen: who else syncs this vault, and whether they keep up.
import { Modal, Notice, Setting, type App } from 'obsidian';
import { agoText, forgetDevice, listDevices, statusText, statusTone, type DeviceStatus } from '../core/devices.ts';
import type { RepoView } from '../core/engine.ts';
import { errorText } from '../core/text.ts';
import type SelfSyncPlugin from './main.ts';
import { button, buttonRow, message } from './ui.ts';

/** Adds the block and fills it in the background, so the rest of the screen is not held up. */
export function renderDevices(containerEl: HTMLElement, plugin: SelfSyncPlugin): void {
  new Setting(containerEl).setName('Devices').setHeading();
  void load(containerEl.createDiv({ cls: 'self-sync-devices' }), plugin);
}

async function load(box: HTMLElement, plugin: SelfSyncPlugin): Promise<void> {
  box.empty();
  const note = (text: string) => message(box, text, 'self-sync-hint');
  if (!plugin.configured()) {
    note('Set up sync to see the devices that share this vault.');
    return;
  }
  note('Loading devices…');
  try {
    const view = await plugin.getEngine().view();
    const devices = await listDevices(view);
    box.empty();
    if (!devices.length) note('No device has reported yet. Each one appears after its next sync.');
    for (const d of devices) row(box, d, view, () => confirmForget(plugin, box, view, d.name));
  } catch (e) {
    box.empty();
    note(`Could not load the devices: ${errorText(e)}`);
  }
}

function row(box: HTMLElement, d: DeviceStatus, view: RepoView, forget: () => void): void {
  const el = box.createDiv({ cls: `self-sync-device is-${statusTone(d)}` });
  const text = el.createDiv({ cls: 'self-sync-device-text' });
  const name = text.createDiv({ cls: 'self-sync-device-name', text: d.name });
  if (d.isSelf) name.createSpan({ cls: 'self-sync-device-tag', text: 'This device' });
  const about = [d.platform, d.version && `v${d.version}`].filter(Boolean).join(' · ');
  if (about) text.createDiv({ cls: 'self-sync-device-meta', text: about });
  text.createDiv({ cls: 'self-sync-device-meta', text: `Last synced ${agoText(view.now - d.lastSeen)}` });
  const status = text.createDiv({ cls: 'self-sync-device-status' });
  status.createSpan({ cls: 'self-sync-device-dot' });
  status.createSpan({ text: statusText(d, view.now) });
  if (!d.isSelf) button(el, 'Forget', forget).buttonEl.setAttribute('aria-label', `Forget ${d.name}`);
}

function confirmForget(plugin: SelfSyncPlugin, box: HTMLElement, view: RepoView, name: string): void {
  new ForgetModal(plugin.app, name, async () => {
    try {
      await forgetDevice(view, name);
      new Notice(`Forgot ${name}.`);
    } catch (e) {
      new Notice(`Could not forget ${name}: ${errorText(e)}`, 8000);
    }
    await load(box, plugin);
  }).open();
}

class ForgetModal extends Modal {
  private name: string;
  private confirmed: () => Promise<void>;

  constructor(app: App, name: string, confirmed: () => Promise<void>) {
    super(app);
    this.name = name;
    this.confirmed = confirmed;
  }

  onOpen(): void {
    const c = this.contentEl;
    this.modalEl.addClass('self-sync-modal');
    this.setTitle(`Forget ${this.name}?`);
    c.createEl('p', {
      cls: 'self-sync-intro',
      text: 'It leaves this list. Use this for a device you no longer sync; if it syncs again it shows up again. Nothing in your vault changes.',
    });
    const row = buttonRow(c);
    button(row, 'Cancel', () => this.close());
    button(row, 'Forget', () => {
      this.close();
      return this.confirmed();
    }, 'warning');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
