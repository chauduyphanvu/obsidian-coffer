import { concat, fromB64, randomBytes, toB64, utf8 } from './bytes.ts';

const subtle = crypto.subtle;
const bs = (u: Uint8Array) => u as unknown as BufferSource;

export interface Keys {
  enc: CryptoKey;
  id: CryptoKey;
}

export interface KeyHeader {
  iter: number;
  salt: string;
  wrapped: string;
}

/** The fewest characters a passphrase may have for a new vault or a new passphrase; an existing one opens whatever its length. */
export const MIN_PASSPHRASE = 8;

export class WrongPassphraseError extends Error {
  constructor() {
    super('Wrong passphrase');
  }
}

async function kek(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await subtle.importKey('raw', bs(utf8.encode(passphrase.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: bs(salt), iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function expand(master: Uint8Array): Promise<Keys> {
  const base = await subtle.importKey('raw', bs(master), 'HKDF', false, ['deriveKey']);
  const derive = (info: string, alg: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
    subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: bs(utf8.encode(info)) }, base, alg, false, usages);
  // These labels keep the plugin's first name: they are part of every stored vault's keys, so changing them would make
  // all existing vaults unreadable.
  return {
    enc: await derive('self-sync/enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    id: await derive('self-sync/id', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  };
}

const gcm = (iv: Uint8Array, aad?: string): AesGcmParams => ({ name: 'AES-GCM', iv: bs(iv), ...(aad !== undefined && { additionalData: bs(utf8.encode(aad)) }) });

/** `aad`, when given, is bound into the wrapping: unwrapping with another one fails like a wrong passphrase. */
async function wrap(master: Uint8Array, passphrase: string, iterations: number, aad?: string): Promise<KeyHeader> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt(gcm(nonce, aad), await kek(passphrase, salt, iterations), bs(master)));
  return { iter: iterations, salt: toB64(salt), wrapped: toB64(concat([nonce, ct])) };
}

async function unwrap(header: KeyHeader, passphrase: string, aad?: string): Promise<Uint8Array> {
  const wrapped = fromB64(header.wrapped);
  const key = await kek(passphrase, fromB64(header.salt), header.iter);
  try {
    return new Uint8Array(await subtle.decrypt(gcm(wrapped.subarray(0, 12), aad), key, bs(wrapped.subarray(12))));
  } catch {
    throw new WrongPassphraseError();
  }
}

/** A random master key, wrapped by a passphrase-derived key so the passphrase can change without re-encrypting data. */
export async function createKeys(passphrase: string, iterations: number): Promise<{ header: KeyHeader; keys: Keys }> {
  const master = randomBytes(32);
  return { header: await wrap(master, passphrase, iterations), keys: await expand(master) };
}

export async function unlockKeys(header: KeyHeader, passphrase: string): Promise<Keys> {
  return expand(await unwrap(header, passphrase));
}

/** The keys of a master key held as it is, as by a device that joined a shared folder with members. */
export function keysFromMaster(master: Uint8Array): Promise<Keys> {
  return expand(master);
}

/** The master key itself under a passphrase or another secret, for a header or an invite. See `wrap`. */
export function wrapMaster(master: Uint8Array, secret: string, iterations: number, aad?: string): Promise<KeyHeader> {
  return wrap(master, secret, iterations, aad);
}

export function unwrapMaster(header: KeyHeader, secret: string, aad?: string): Promise<Uint8Array> {
  return unwrap(header, secret, aad);
}

/** The same master key under a new passphrase: stored data stays valid, only the header changes. It never lowers the cost. */
export async function rewrapKeys(header: KeyHeader, oldPassphrase: string, newPassphrase: string, iterations = header.iter): Promise<KeyHeader> {
  return wrap(await unwrap(header, oldPassphrase), newPassphrase, Math.max(header.iter, iterations));
}

const PASSPHRASE_SYMBOLS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** 100 bits from 32 symbols without look-alikes (`byte & 31` keeps them unbiased), as xxxx-xxxx-xxxx-xxxx-xxxx. */
export function generatePassphrase(): string {
  const bytes = randomBytes(20);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (i && i % 4 === 0 ? '-' : '') + PASSPHRASE_SYMBOLS[bytes[i] & 31];
  return out;
}

/** What a setup code from 0.1 and 0.2 used, since its layout does not say. */
export const LEGACY_CODE_ITERATIONS = 200_000;
/** The most a setup code may ask for, so a crafted link cannot keep a device busy for minutes. */
export const MAX_CODE_ITERATIONS = 10_000_000;
const CODE_HEADER = 4;

/** Encrypts a small text under a passphrase alone, for moving settings between devices. Layout: iterations (u32 BE) | salt (16) | nonce (12) | ciphertext+tag. */
export async function sealWithPassphrase(text: string, passphrase: string, iterations: number): Promise<string> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, await kek(passphrase, salt, iterations), bs(utf8.encode(text))));
  const head = new Uint8Array(CODE_HEADER);
  new DataView(head.buffer).setUint32(0, iterations);
  return toB64(concat([head, salt, nonce, ct]));
}

/** With `legacy`, the layout of 0.1 and 0.2, which has no iterations field: salt (16) | nonce (12) | ciphertext+tag. */
export async function openWithPassphrase(sealed: string, passphrase: string, legacy = false): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = fromB64(sealed);
  } catch {
    throw new Error('That is not a valid setup code');
  }
  const head = legacy ? 0 : CODE_HEADER;
  if (raw.length < head + 45) throw new Error('That is not a valid setup code');
  const iterations = legacy ? LEGACY_CODE_ITERATIONS : new DataView(raw.buffer, raw.byteOffset).getUint32(0);
  if (iterations < 1 || iterations > MAX_CODE_ITERATIONS) throw new Error('That is not a valid setup code');
  const body = raw.subarray(head);
  try {
    const key = await kek(passphrase, body.subarray(0, 16), iterations);
    return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: bs(body.subarray(16, 28)) }, key, bs(body.subarray(28))));
  } catch {
    throw new WrongPassphraseError();
  }
}

/** Layout: flag (1) | nonce (12) | ciphertext+tag. The flag is authenticated together with `aad`. */
export async function seal(keys: Keys, plain: Uint8Array, aad: string, flag = 0): Promise<Uint8Array> {
  const out = new Uint8Array(13 + plain.length + 16);
  out[0] = flag;
  crypto.getRandomValues(out.subarray(1, 13));
  const ct = await subtle.encrypt(
    { name: 'AES-GCM', iv: bs(out.subarray(1, 13)), additionalData: bs(utf8.encode(aad + flag)) },
    keys.enc,
    bs(plain),
  );
  out.set(new Uint8Array(ct), 13);
  return out;
}

export async function open(keys: Keys, sealed: Uint8Array, aad: string): Promise<{ plain: Uint8Array; flag: number }> {
  const flag = sealed[0];
  let plain: ArrayBuffer;
  try {
    plain = await subtle.decrypt(
      { name: 'AES-GCM', iv: bs(sealed.subarray(1, 13)), additionalData: bs(utf8.encode(aad + flag)) },
      keys.enc,
      bs(sealed.subarray(13)),
    );
  } catch {
    throw new Error(`Remote data failed authentication (${aad}): corrupted or tampered with`);
  }
  return { plain: new Uint8Array(plain), flag };
}

/** Names an object by its stored bytes, so two devices can tell whether storage showed them the same one. */
export async function digest(data: Uint8Array): Promise<string> {
  return toB64(new Uint8Array(await subtle.digest('SHA-256', bs(data)), 0, 16));
}

/** Keyed, so the storage provider cannot test whether a known file is in the vault. */
export async function chunkId(keys: Keys, data: Uint8Array): Promise<string> {
  const mac = await subtle.sign('HMAC', keys.id, bs(data));
  return toB64(new Uint8Array(mac, 0, 16));
}

/** 32 bytes derived from `secret` for one purpose, named by `info`. */
export async function hkdf(secret: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await subtle.importKey('raw', bs(secret), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: bs(utf8.encode(info)) }, base, 256));
}

/** AES-GCM under a raw 32-byte key. Layout: nonce (12) | ciphertext+tag. */
export async function sealWithKey(key: Uint8Array, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', bs(key), 'AES-GCM', false, ['encrypt']);
  const nonce = randomBytes(12);
  return concat([nonce, new Uint8Array(await subtle.encrypt(gcm(nonce, aad), k, bs(plain)))]);
}

export async function openWithKey(key: Uint8Array, sealed: Uint8Array, aad: string): Promise<Uint8Array> {
  const k = await subtle.importKey('raw', bs(key), 'AES-GCM', false, ['decrypt']);
  try {
    return new Uint8Array(await subtle.decrypt(gcm(sealed.subarray(0, 12), aad), k, bs(sealed.subarray(12))));
  } catch {
    throw new Error(`Remote data failed authentication (${aad}): corrupted, tampered with, or sealed for someone else`);
  }
}

/**
 * A private ECDSA P-256 key as stored: only these fields, since an import that finds `ext` or `key_ops` disagreeing
 * with its own arguments throws on some platforms.
 */
export interface SigningKey {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
  d: string;
}

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const ECDSA_SHA256 = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** A new key pair: the private key to keep, and the public key as uncompressed raw bytes (65), base64url. */
export async function newSigningKey(): Promise<{ key: SigningKey; pub: string }> {
  const pair = await subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  const key: SigningKey = { kty: 'EC', crv: 'P-256', x: jwk.x!, y: jwk.y!, d: jwk.d! };
  return { key, pub: publicKeyOf(key) };
}

/** The raw public key (0x04 | x | y), base64url, of a private key. */
export function publicKeyOf(key: SigningKey): string {
  return toB64(concat([new Uint8Array([4]), fromB64(key.x), fromB64(key.y)]));
}

export function importSigningKey(key: SigningKey): Promise<CryptoKey> {
  const { kty, crv, x, y, d } = key;
  return subtle.importKey('jwk', { kty, crv, x, y, d }, ECDSA, false, ['sign']);
}

/** Only an uncompressed point: WebKit does not take compressed ones. */
export function importVerifyKey(pub: string): Promise<CryptoKey> {
  const raw = fromB64(pub);
  if (raw.length !== 65 || raw[0] !== 4) return Promise.reject(new Error('Not a public key'));
  return subtle.importKey('raw', bs(raw), ECDSA, false, ['verify']);
}

/** A 64-byte signature (r | s), base64url. */
export async function signWith(key: CryptoKey, data: Uint8Array): Promise<string> {
  return toB64(new Uint8Array(await subtle.sign(ECDSA_SHA256, key, bs(data))));
}

/** A signature that cannot even be checked counts as wrong. */
export async function verifyWith(key: CryptoKey, sig: string, data: Uint8Array): Promise<boolean> {
  try {
    return await subtle.verify(ECDSA_SHA256, key, bs(fromB64(sig)), bs(data));
  } catch {
    return false;
  }
}
