import type { MemFS } from '../src/testing/memfs.ts';
import { rng } from '../src/testing/netsim.ts';

export interface VaultSpec {
  notes: number;
  seed: number;
  /** One image per this many notes. 0 for none. */
  imageEvery: number;
  /** Size in bytes of one large binary (a video, a big PDF). 0 for none. */
  largeFile: number;
}

/**
 * A vault shaped like a real one: mostly small Markdown notes with a long tail of big ones,
 * nested folders (some with Vietnamese names), frontmatter, wikilinks, tags, images, config files.
 */
export function generateVault(fs: MemFS, spec: VaultSpec): { notes: string[]; bytes: number } {
  const rand = rng(spec.seed);
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const pick = (n: number) => (rand() * n) | 0;
  const syll = 'ka to mi ra shi no en ve lu po da gri sta mor quin bel thu ong anh uyen'.split(' ');
  const vocab = Array.from({ length: 4000 }, () => Array.from({ length: 1 + pick(3) }, () => syll[pick(syll.length)]).join(''));
  // Zipf-like: low ranks are far more common, which gives natural-language compressibility.
  const word = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.exp(rand() * Math.log(vocab.length))) - 1)];
  const sentence = () => {
    const n = 4 + pick(18);
    let s = '';
    for (let i = 0; i < n; i++) s += (i ? ' ' : '') + word();
    return `${s[0].toUpperCase()}${s.slice(1)}.`;
  };

  const top = ['Daily', 'Projects', 'Areas', 'Reference', 'Ghi chú', 'Archive', 'Inbox'];
  const folders: string[] = [];
  for (const t of top) {
    folders.push(t);
    for (let i = 0; i < 6; i++) {
      const sub = `${t}/${word()} ${word()}`;
      folders.push(sub);
      if (pick(3) === 0) folders.push(`${sub}/${word()}`);
    }
  }

  const names: string[] = [];
  for (let i = 0; i < spec.notes; i++) {
    const folder = folders[Math.min(folders.length - 1, Math.floor(Math.abs(gauss()) * folders.length * 0.4))];
    names.push(`${folder}/${word()} ${word()} ${i}`);
  }

  let bytes = 0;
  const put = (path: string, data: string | Uint8Array) => {
    fs.put(path, data);
    bytes += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
  };
  const random = (n: number) => {
    const u = new Uint8Array(n);
    for (let i = 0; i < n; i += 65536) crypto.getRandomValues(u.subarray(i, Math.min(n, i + 65536)));
    return u;
  };

  const notes: string[] = [];
  for (let i = 0; i < spec.notes; i++) {
    const target = Math.min(150_000, Math.max(60, Math.exp(Math.log(1200) + 1.1 * gauss())));
    let body = `---\ncreated: 2026-${String(1 + pick(12)).padStart(2, '0')}-${String(1 + pick(28)).padStart(2, '0')}\ntags: [${word()}, ${word()}]\n---\n\n# ${names[i].slice(names[i].lastIndexOf('/') + 1)}\n\n`;
    while (body.length < target) {
      const kind = pick(10);
      if (kind === 0) body += `## ${word()} ${word()}\n\n`;
      else if (kind === 1) body += `- [ ] ${sentence()}\n- ${sentence()} [[${names[pick(names.length)].split('/').pop()}]]\n\n`;
      else if (kind === 2) body += `> ${sentence()} #${word()}\n\n`;
      else body += `${sentence()} ${sentence()} ${sentence()}\n\n`;
    }
    const path = `${names[i]}.md`;
    put(path, body);
    notes.push(path);
    if (spec.imageEvery && i % spec.imageEvery === 0) {
      put(`Attachments/img ${i}.png`, random(Math.floor(Math.min(4e6, Math.exp(Math.log(150_000) + 0.9 * gauss())))));
    }
  }
  if (spec.largeFile) put('Attachments/recording.mp4', random(spec.largeFile));
  for (const f of ['app', 'appearance', 'core-plugins', 'community-plugins', 'hotkeys', 'graph']) {
    put(`.obsidian/${f}.json`, JSON.stringify(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${word()}${i}`, pick(100)])), null, 2));
  }
  put('.obsidian/workspace.json', '{"main":{}}');
  return { notes, bytes };
}
