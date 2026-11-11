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

export const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e as string]!);

/** Store ranges end before `end`; an HTTP range names its last byte. */
export const rangeHeader = (range: { start: number; end: number }): Record<string, string> => ({ range: `bytes=${range.start}-${range.end - 1}` });
