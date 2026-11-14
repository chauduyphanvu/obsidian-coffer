import type { ObjectInfo, RemoteStore } from '../core/types.ts';
import { fetchHttp, rangeHeader, unescapeXml, type Http, type HttpResponse } from './http.ts';
import { permanentError } from './retry.ts';
import { sha256Hex, sign, uriEncode } from './sigv4.ts';

export interface S3Config {
  /** e.g. https://<account>.r2.cloudflarestorage.com or https://s3.us-east-1.amazonaws.com */
  endpoint: string;
  region: string;
  bucket: string;
  /** Folder inside the bucket, so one bucket can hold several vaults. */
  prefix: string;
  accessKey: string;
  secretKey: string;
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. */
  pathStyle: boolean;
}

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export class S3Store implements RemoteStore {
  private cfg: S3Config;
  private http: Http;
  private host: string;
  private origin: string;
  private basePath: string;
  private prefix: string;

  constructor(cfg: S3Config, http: Http = fetchHttp) {
    this.cfg = cfg;
    this.http = http;
    const url = new URL(cfg.endpoint);
    this.host = cfg.pathStyle ? url.host : `${cfg.bucket}.${url.host}`;
    this.origin = `${url.protocol}//${this.host}`;
    this.basePath = cfg.pathStyle ? `/${uriEncode(cfg.bucket)}` : '';
    this.prefix = cfg.prefix.replace(/^\/+|\/+$/g, '');
    if (this.prefix) this.prefix += '/';
  }

  private async request(method: string, key: string | null, query: Record<string, string>, headers: Record<string, string>, body?: Uint8Array): Promise<HttpResponse> {
    const path = this.basePath + (key === null ? '/' : `/${(this.prefix + key).split('/').map(uriEncode).join('/')}`);
    const signed = await sign({
      method,
      host: this.host,
      path,
      query,
      headers,
      payloadHash: body ? await sha256Hex(body) : EMPTY_HASH,
      region: this.cfg.region,
      accessKey: this.cfg.accessKey,
      secretKey: this.cfg.secretKey,
      date: new Date(),
    });
    const qs = Object.keys(query).length ? `?${Object.entries(query).map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`).join('&')}` : '';
    const res = await this.http({ method, url: this.origin + path + qs, headers: signed, body });
    if (res.status >= 500 || res.status === 429 || res.status === 409) {
      throw new Error(`S3 ${method} ${key ?? ''} failed with HTTP ${res.status}`);
    }
    return res;
  }

  private fail(res: HttpResponse, what: string): never {
    const text = new TextDecoder().decode(res.body.subarray(0, 600));
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
    throw permanentError(`S3 ${what} failed with HTTP ${res.status}${code ? ` (${code})` : ''}`);
  }

  async get(key: string, range?: { start: number; end: number }): Promise<Uint8Array | null> {
    if (range && range.end <= range.start) return new Uint8Array(0);
    const headers = range ? rangeHeader(range) : {};
    const res = await this.request('GET', key, {}, headers);
    if (res.status === 404) return null;
    if (res.status !== 200 && res.status !== 206) this.fail(res, `GET ${key}`);
    return res.body;
  }

  async put(key: string, data: Uint8Array, opts?: { ifNoneMatch?: boolean; contentType?: string }): Promise<boolean> {
    const headers: Record<string, string> = opts?.ifNoneMatch ? { 'if-none-match': '*' } : {};
    if (opts?.contentType) headers['content-type'] = opts.contentType;
    const res = await this.request('PUT', key, {}, headers, data);
    if (res.status === 412) return false;
    if (res.status !== 200) this.fail(res, `PUT ${key}`);
    return true;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request('DELETE', key, {}, {});
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) this.fail(res, `DELETE ${key}`);
  }

  async list(prefix: string, startAfter?: string): Promise<ObjectInfo[]> {
    const out: ObjectInfo[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix: this.prefix + prefix };
      if (token) query['continuation-token'] = token;
      else if (startAfter) query['start-after'] = this.prefix + startAfter;
      const res = await this.request('GET', null, query, {});
      if (res.status !== 200) this.fail(res, `LIST ${prefix}`);
      const xml = new TextDecoder().decode(res.body);
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const field = (name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(m[1])?.[1] ?? '';
        out.push({
          key: unescapeXml(field('Key')).slice(this.prefix.length),
          size: Number(field('Size')),
          modified: Date.parse(field('LastModified')),
        });
      }
      token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unescapeXml(/<NextContinuationToken>([^<]*)</.exec(xml)?.[1] ?? '') : undefined;
    } while (token);
    return out;
  }
}
