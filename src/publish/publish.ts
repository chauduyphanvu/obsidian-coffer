// Publishing the website in two steps, as the plugin's screen and the command line both do it: build the site and
// compare it with what is at its location, show the person what would change, then upload and delete as shown.
import { plural } from '../core/text.ts';
import type { RemoteStore } from '../core/types.ts';
import { sizeLabel } from '../plugin/restore.ts';
import { deploy, planDeploy, type DeployOptions, type Planned } from './deploy.ts';
import { buildSite, type LeftOutWhy, type Site, type SiteOptions, type VaultReader } from './site.ts';

/** A built site and what publishing it would change at its location. */
export interface Prepared {
  site: Site;
  planned: Planned;
}

/** Builds the site and compares it with the location. Writes nothing. Throws what `planDeploy` throws. */
export async function preparePublish(vault: VaultReader, store: RemoteStore, o: SiteOptions): Promise<Prepared> {
  const site = await buildSite(vault, o);
  return { site, planned: await planDeploy(store, site.files) };
}

/** What a publish would change, in words a person reads: page titles and file paths rather than site keys. Each list sorted. */
export interface Changes {
  newPages: string[];
  /** The new pages but the front page, each with its address on the site, sorted as `newPages`: the address shows the note's path, which its title may not. */
  newPageKeys: { title: string; key: string }[];
  changedPages: string[];
  removedPages: string[];
  newFiles: string[];
  changedFiles: string[];
  removedFiles: string[];
  /** Nothing would be uploaded or deleted. */
  nothing: boolean;
}

const byName = (a: string, b: string) => {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x < y ? -1 : x > y ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** What publishing `p` would change: a page by its title ("Front page" for `index.html`), a removed page by its address without `.html`, other files by their path ("Page style" for `site.css`). */
export function changesOf(p: Prepared): Changes {
  const { report } = p.site;
  const { added, changed, removed } = p.planned.plan;
  const titles = new Map(report.pages.map((page) => [page.key, page.title]));
  const paths = new Map(report.attachments.map((a) => [a.key, a.path]));
  const name = (key: string) => {
    if (key === 'index.html') return 'Front page';
    if (key === 'site.css') return 'Page style';
    return titles.get(key) ?? paths.get(key) ?? (key.endsWith('.html') ? key.slice(0, -5) : key);
  };
  const isPage = (key: string) => key.endsWith('.html');
  const names = (keys: string[], page: boolean) => keys.filter((k) => isPage(k) === page).map(name).sort(byName);
  return {
    newPages: names(added, true),
    newPageKeys: added
      .filter((k) => isPage(k) && k !== 'index.html')
      .map((key) => ({ title: name(key), key }))
      .sort((a, b) => byName(a.title, b.title) || byName(a.key, b.key)),
    changedPages: names(changed, true),
    removedPages: names(removed, true),
    newFiles: names(added, false),
    changedFiles: names(changed, false),
    removedFiles: names(removed, false),
    nothing: !added.length && !changed.length && !removed.length,
  };
}

const WHY: Record<LeftOutWhy, string> = {
  excluded: 'it is left out of sync on this device, or is in a hidden folder',
  conflict: 'it is a conflict copy of another file',
  name: 'its name can not be used on a website',
  clash: 'another file of the website has this name, in the same or other letter case',
  ambiguous: 'more than one file in the vault has this name; link it with its folder, as in [[Folder/name.png]]',
};

/** The preview as plain lines of text, for the command line and for a screen: counts first, then names, then what was left out and why. */
export function summaryLines(p: Prepared): string[] {
  const { report } = p.site;
  const { plan } = p.planned;
  const c = changesOf(p);
  // Counted as the changes below count them: the front page is a page, the style sheet a file.
  const keys = [...p.site.files.keys()];
  const pageCount = keys.filter((k) => k.endsWith('.html')).length;
  const lines = [`The website has ${plural(pageCount, 'page')} and ${plural(keys.length - pageCount, 'other file')}${plan.first ? ', published here for the first time' : ''}.`];
  if (c.nothing) lines.push('Nothing to upload or delete: the website at this location is up to date.');
  else {
    const counts = [
      [c.newPages.length, 'new page'],
      [c.changedPages.length, 'changed page'],
      [c.removedPages.length, 'removed page'],
      [c.newFiles.length, 'new file'],
      [c.changedFiles.length, 'changed file'],
      [c.removedFiles.length, 'removed file'],
    ] as const;
    const upload = plan.added.length + plan.changed.length;
    lines.push(`${counts.filter(([n]) => n).map(([n, what]) => plural(n, what)).join(', ')}.${upload ? ` ${sizeLabel(plan.bytes)} to upload.` : ''}`);
  }
  // A new page's address is named when it says more than the title does: a folder, or a file name other than the title.
  const added = [...(p.planned.plan.added.includes('index.html') ? [{ title: 'Front page', key: 'index.html' }] : []), ...c.newPageKeys];
  added.sort((a, b) => byName(a.title, b.title) || byName(a.key, b.key));
  for (const { title, key } of added) lines.push(key === 'index.html' || key === `${title}.html` ? `New page: ${title}` : `New page: ${title} (at ${key})`);
  const named = [
    ['Changed page', c.changedPages],
    ['Removed page', c.removedPages],
    ['New file', c.newFiles],
    ['Changed file', c.changedFiles],
    ['Removed file', c.removedFiles],
  ] as const;
  for (const [label, list] of named) for (const n of list) lines.push(`${label}: ${n}`);
  for (const l of report.leftOut) lines.push(`Left out: ${l.path}, because ${WHY[l.why]}.`);
  for (const u of report.unpublished) lines.push(`Not linked: “${u.link}” in ${u.from} leads to a note that is not published, so its text is shown without a link.`);
  if (report.homeNotFound) lines.push(`Not found: the front page “${report.homeNotFound}” is not a published note, so the front page is the list of pages. Give its path in the vault, as in Folder/Home.md.`);
  for (const m of report.missing) lines.push(`Not found: “${m.link}” in ${m.from} leads to no file in the vault.`);
  return lines;
}

/** Uploads and deletes as prepared. */
export function publishPrepared(store: RemoteStore, p: Prepared, opts?: DeployOptions): Promise<void> {
  return deploy(store, p.site.files, p.planned, opts);
}
