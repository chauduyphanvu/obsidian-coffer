import { ReadOnlyError, type RemoteStore } from '../core/types.ts';
import { fetchHttp, rangeHeader, type Http } from './http.ts';
import { permanentError } from './retry.ts';
import { uriEncode } from './sigv4.ts';

export interface FollowConfig {
  /** Public address of the folder that holds the share's objects, e.g. https://example.com/family. With or without a trailing slash. */
  url: string;
}

/** `withRetry` gives up at once on a permanent error, so a refused write is not repeated with backoff. */
const refused = (): Promise<never> => Promise.reject(Object.assign(new ReadOnlyError(), { permanent: true }));

/**
 * Reads a public copy of a share over plain GET, with no credentials. Nothing can be listed, so a reader has to
 * ask for each object by name; an object that is missing and one that is not public look the same.
 */
export class FollowStore implements RemoteStore {
  readonly noList = true;
  private base: string;
  private http: Http;

  constructor(cfg: FollowConfig, http: Http = fetchHttp) {
    const url = new URL(cfg.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The address for following a folder must start with https://');
    this.base = (url.origin + url.pathname).replace(/\/+$/, '');
    this.http = http;
  }

  private url(key: string): string {
    return `${this.base}/${key.split('/').map(uriEncode).join('/')}`;
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    if (range && range.end <= range.start) return new Uint8Array(0);
    const res = await this.http({ method: 'GET', url: this.url(key), headers: range ? rangeHeader(range) : {} });
    if (res.status === 404 || res.status === 403) return null;
    if (res.status >= 500 || res.status === 429) throw new Error(`Follow link GET ${key} failed with HTTP ${res.status}`);
    if (res.status === 206 || (res.status === 200 && !range)) return res.body;
    // Past the end of the object, or a server without range support that sent everything.
    if (res.status === 416) return new Uint8Array(0);
    if (res.status === 200) return res.body.subarray(range!.start, range!.end);
    throw permanentError(`Follow link GET ${key} failed with HTTP ${res.status}`);
  }

  put: RemoteStore['put'] = refused;

  delete: RemoteStore['delete'] = refused;

  list: RemoteStore['list'] = async () => {
    throw permanentError('A followed folder cannot be listed, only read by name');
  };
}
