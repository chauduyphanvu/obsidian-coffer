export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  body: Uint8Array;
}

/** Injected so the same store runs on `fetch` (Node, desktop) and on Obsidian's `requestUrl` (mobile, no CORS). */
export type Http = (req: HttpRequest) => Promise<HttpResponse>;

export const fetchHttp: Http = async (req) => {
  const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body as unknown as BodyInit });
  return { status: r.status, body: new Uint8Array(await r.arrayBuffer()) };
};

/**
 * iOS keeps GET responses in its URL cache and then adds `If-Modified-Since` to a later DELETE of the same URL,
 * which S3 rejects with 501; `no-store` keeps responses out of it. Desktop Obsidian answers a GET from Chromium's
 * cache whenever a stored copy still looks fresh, whatever the credentials, and `no-store` does not stop that;
 * `no-cache` makes Chromium go to the server, so a passphrase changed elsewhere is seen at once.
 */
export const uncachedHeaders = (req: HttpRequest): Record<string, string> =>
  req.method === 'GET' ? { ...req.headers, 'cache-control': 'no-store, no-cache' } : req.headers;

export const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e as string]!);

/** Store ranges end before `end`; an HTTP range names its last byte. */
export const rangeHeader = (range: { start: number; end: number }): Record<string, string> => ({ range: `bytes=${range.start}-${range.end - 1}` });
