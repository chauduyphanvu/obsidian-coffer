import { toHex, utf8 } from '../core/bytes.ts';

const bs = (u: Uint8Array) => u as unknown as BufferSource;

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', bs(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, bs(utf8.encode(msg))));
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bs(data))));
}

export const uriEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignInput {
  method: string;
  host: string;
  /** Already URI-encoded, starting with `/`. */
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKey: string;
  secretKey: string;
  date: Date;
}

/** AWS Signature Version 4 for S3. Returns the headers to send (without `host`, which the HTTP client sets). */
export async function sign(i: SignInput): Promise<Record<string, string>> {
  const amzDate = i.date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': amzDate };
  const signed: Record<string, string> = { host: i.host };
  for (const [k, v] of Object.entries(headers)) signed[k.toLowerCase()] = v.trim();
  const names = Object.keys(signed).sort();
  const query = Object.keys(i.query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(i.query[k])}`)
    .join('&');
  const canonical = [
    i.method,
    i.path,
    query,
    ...names.map((n) => `${n}:${signed[n]}`),
    '',
    names.join(';'),
    i.payloadHash,
  ].join('\n');
  const scope = `${day}/${i.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(utf8.encode(canonical))].join('\n');
  let key = await hmac(utf8.encode(`AWS4${i.secretKey}`), day);
  for (const part of [i.region, 's3', 'aws4_request']) key = await hmac(key, part);
  const signature = toHex(await hmac(key, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  return headers;
}
