import type { ObjectInfo, RemoteStore } from '../core/types.ts';
import { fetchHttp, rangeHeader, unescapeXml, type Http, type HttpResponse } from './http.ts';
import { permanentError } from './retry.ts';

export interface WebDavConfig {
  /** Folder URL that will hold the vault data, e.g. https://cloud.example.com/remote.php/dav/files/me/obsidian */
  url: string;
  username: string;
  password: string;
}

/**
 * WebDAV (Nextcloud, a NAS, many hosting providers). The server must honour `If-None-Match: *`
 * on PUT, which the connection check verifies.
 */
export class WebDavStore implements RemoteStore {
  private base: string;
  private auth: string;
  private http: Http;
  private madeDirs = new Map<string, Promise<void>>();

  constructor(cfg: WebDavConfig, http: Http = fetchHttp) {
    this.base = cfg.url.replace(/\/+$/, '');
    this.auth = `Basic ${btoa(String.fromCharCode(...new TextEncoder().encode(`${cfg.username}:${cfg.password}`)))}`;
    this.http = http;
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private async request(method: string, url: string, headers: Record<string, string> = {}, body?: Uint8Array): Promise<HttpResponse> {
    const res = await this.http({ method, url, headers: { authorization: this.auth, ...headers }, body });
    if (res.status >= 500 || res.status === 429 || res.status === 423) throw new Error(`WebDAV ${method} failed with HTTP ${res.status}`);
    return res;
  }

  private fail(res: HttpResponse, what: string): never {
    const denied = res.status === 401 || res.status === 403;
    throw permanentError(denied ? `WebDAV refused the login or the folder (HTTP ${res.status})` : `WebDAV ${what} failed with HTTP ${res.status}`);
  }

  private async mkcol(url: string): Promise<void> {
    let res = await this.request('MKCOL', url);
    if (res.status === 409) {
      // The parent is missing too. Stop at the server root.
      const parent = url.slice(0, url.lastIndexOf('/'));
      if (parent.length <= new URL(url).origin.length) this.fail(res, 'MKCOL');
      await this.mkcol(parent);
      res = await this.request('MKCOL', url);
    }
    // 405 and 301: already there.
    if (![201, 200, 405, 301].includes(res.status)) this.fail(res, 'MKCOL');
  }

  private async mkdirs(key: string): Promise<void> {
    const parts = key.split('/').slice(0, -1);
    for (let i = 0; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      // One attempt per folder, shared by every upload that is waiting for it.
      let made = this.madeDirs.get(dir);
      if (!made) {
        made = this.mkcol(dir ? this.url(dir) : this.base);
        this.madeDirs.set(dir, made);
        made.catch(() => this.madeDirs.delete(dir));
      }
      await made;
    }
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    if (range && range.end <= range.start) return new Uint8Array(0);
    const res = await this.request('GET', this.url(key), range ? rangeHeader(range) : {});
    if (res.status === 404) return null;
    if (res.status === 206 || (res.status === 200 && !range)) return res.body;
    // Past the end of the object, or a server without range support that sent everything.
    if (res.status === 416) return new Uint8Array(0);
    if (res.status === 200) return res.body.subarray(range!.start, range!.end);
    this.fail(res, `GET ${key}`);
  }

  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean }): Promise<boolean> {
    const headers: Record<string, string> = opts?.ifNoneMatch ? { 'if-none-match': '*' } : {};
    let res = await this.request('PUT', this.url(key), headers, data);
    if (res.status === 409 || res.status === 404 || res.status === 403) {
      // A parent folder is missing (servers disagree on which of these codes says so).
      await this.mkdirs(key);
      res = await this.request('PUT', this.url(key), headers, data);
    }
    if (res.status === 412) return false;
    if (res.status !== 201 && res.status !== 204 && res.status !== 200) this.fail(res, `PUT ${key}`);
    return true;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', this.url(key));
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) this.fail(res, `DELETE ${key}`);
  }

  async list(prefix: string, startAfter = ''): Promise<ObjectInfo[]> {
    const dir = prefix.replace(/\/$/, '');
    const body = new TextEncoder().encode(
      '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:resourcetype/></d:prop></d:propfind>',
    );
    const res = await this.request('PROPFIND', `${this.url(dir)}/`, { depth: '1', 'content-type': 'application/xml' }, body);
    if (res.status === 404) return [];
    if (res.status !== 207) this.fail(res, `PROPFIND ${dir}`);
    const xml = new TextDecoder().decode(res.body);
    const out: ObjectInfo[] = [];
    // Servers differ in namespace prefix (d:, D:, none), so tags are matched by local name.
    for (const m of xml.matchAll(/<(?:\w+:)?response[\s>][\s\S]*?<\/(?:\w+:)?response>/g)) {
      const field = (name: string) => new RegExp(`<(?:\\w+:)?${name}[^>]*>([^<]*)</(?:\\w+:)?${name}>`).exec(m[0])?.[1] ?? '';
      if (/<(?:\w+:)?collection[\s/>]/.test(m[0])) continue;
      const href = decodeURIComponent(unescapeXml(field('href')));
      const key = `${dir}/${href.slice(href.lastIndexOf('/') + 1)}`;
      if (key > startAfter) out.push({ key, size: Number(field('getcontentlength')), modified: Date.parse(field('getlastmodified')) || 0 });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : 1));
  }
}
