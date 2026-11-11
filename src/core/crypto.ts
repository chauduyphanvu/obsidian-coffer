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
  return {
    enc: await derive('self-sync/enc', { name: 'AES-GCM', length: 256 }, ['encrypt', 'decrypt']),
    id: await derive('self-sync/id', { name: 'HMAC', hash: 'SHA-256', length: 256 }, ['sign']),
  };
}

async function wrap(master: Uint8Array, passphrase: string, iterations: number): Promise<KeyHeader> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, await kek(passphrase, salt, iterations), bs(master)));
  return { iter: iterations, salt: toB64(salt), wrapped: toB64(concat([nonce, ct])) };
}

async function unwrap(header: KeyHeader, passphrase: string): Promise<Uint8Array> {
  const wrapped = fromB64(header.wrapped);
  const key = await kek(passphrase, fromB64(header.salt), header.iter);
  try {
    return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: bs(wrapped.subarray(0, 12)) }, key, bs(wrapped.subarray(12))));
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

/** The same master key under a new passphrase: stored data stays valid, only the header changes. */
export async function rewrapKeys(header: KeyHeader, oldPassphrase: string, newPassphrase: string): Promise<KeyHeader> {
  return wrap(await unwrap(header, oldPassphrase), newPassphrase, header.iter);
}

/** Encrypts a small text under a passphrase alone, for moving settings between devices. */
export async function sealWithPassphrase(text: string, passphrase: string, iterations = 200_000): Promise<string> {
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, await kek(passphrase, salt, iterations), bs(utf8.encode(text))));
  return toB64(concat([salt, nonce, ct]));
}

export async function openWithPassphrase(sealed: string, passphrase: string, iterations = 200_000): Promise<string> {
  let raw: Uint8Array;
  try {
    raw = fromB64(sealed);
  } catch {
    throw new Error('That is not a valid setup code');
  }
  if (raw.length < 45) throw new Error('That is not a valid setup code');
  try {
    const key = await kek(passphrase, raw.subarray(0, 16), iterations);
    return new TextDecoder().decode(await subtle.decrypt({ name: 'AES-GCM', iv: bs(raw.subarray(16, 28)) }, key, bs(raw.subarray(28))));
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

/** Keyed, so the storage provider cannot test whether a known file is in the vault. */
export async function chunkId(keys: Keys, data: Uint8Array): Promise<string> {
  const mac = await subtle.sign('HMAC', keys.id, bs(data));
  return toB64(new Uint8Array(mac, 0, 16));
}
