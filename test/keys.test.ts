import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { fromB64, toB64 } from '../src/core/bytes.ts';
import {
  MAX_CODE_ITERATIONS,
  WrongPassphraseError,
  createKeys,
  generatePassphrase,
  open,
  openWithPassphrase,
  rewrapKeys,
  seal,
  sealWithPassphrase,
  unlockKeys,
} from '../src/core/crypto.ts';
import { SyncEngine } from '../src/core/engine.ts';
import { MemoryStore } from '../src/stores/memory.ts';
import { SimStore } from '../src/testing/netsim.ts';
import {
  codeIterations,
  codeKind,
  decodeInvite,
  decodeSetupCode,
  defaultSettings,
  encodeSetupCode,
  secretName,
  setupCodeFrom,
  setupLink,
  shareSecretName,
} from '../src/plugin/settings.ts';
import { Device } from './helpers.ts';

// Made by the code of 0.1 and 0.2 before this format existed, from invented storage details and throwaway passphrases:
// endpoint https://fixture.example.com, bucket fixture-bucket, keys AKIDFIXTURE and SECRETFIXTURE. They must keep opening.
const V1_VAULT =
  'coffer1.PznSoX36qbsP8SRDSE44wM_U4DV9h53WCBYyF38VrsziljbAeryZ1GfE3YroaI7zMJ_JJmX_9juHNK_DnN83czmvfKhMgwg-fUZVme2Ge1WTB60zGVkoIAEAV_jwoQQG2IT7svunErNQ8o-KZIoRUYC_mvS9Zld1GWQJdsVLJ90jAAGOuLxcCejUjRGGP3C66AKH6LHOyfC-24PBFJ8RW_-pvZ1c5XxLR_9G2yPvN6e783BYDDWEeG_DXW0rm2QEPiNLU7sfhYJWzx7SjekL0YZag9wiLLFVC3_SSeSUcgPS80RvSC_Pws8eEjKmX-gXUpiHZmhM2zHLRkCEK8Y8-JuE7Xfabljluw5W2VxerkRoXGelVwOEx39Y-JLYllIzK4fU-22vog';
const V1_INVITE =
  'coffershare1._yLeH6WicSYKnRB7W6oGIJGAWKL0WQCnoB50C4LNWeXx69MSM-q7CwngbGpYyfMOxP8g7R-p74NuWGsh2S5RPiT3OiPuzF4OawOgngbkszGNBx5G_68A5lOrkT44Bh6vYi-hSAOtZ2gifd5__qOKbnz7vsA3VDw1xVXxugzGsFz2PyxjtkK3jGtgPx93KhTKajLbGbP7UBsXitFErTqS3o9w5E4ka9qvNQDuEXv9IQlCIKG3uAPa6hIfgIINEK09UuduffzSU-yLNpRc9CONCPV6ySCii9qDSkfT7d79WqAzAmLXqAZj7zlzBOKAOvHD88gNpQWJDY_ysINubDnLXFJRlBMdmuMggJnNf_p2bvIYwiNHPffux5HtgqKRAgXfGag6eJlSbDYP290RTXTYELe10TcUZzjlCA';

const lookup = (n: string) => ({ ak: 'AKID', sk: 'SECRET', sp: 'share pass', pp: 'vault pass' })[n] ?? '';
const vaultStorage = () => ({ ...defaultSettings(false), endpoint: 'https://s3.example.com', bucket: 'bkt', prefix: 'v', accessKeySecret: 'ak', secretKeySecret: 'sk', passphraseSecret: 'pp' });
const shareStorage = () => ({ ...vaultStorage(), prefix: 'team', passphraseSecret: 'sp' });

/** The iteration count a code carries in its first four bytes. */
const countOf = (code: string) => new DataView(fromB64(code.slice(code.indexOf('.') + 1)).buffer).getUint32(0);
const withCount = (sealed: string, n: number) => {
  const raw = fromB64(sealed);
  new DataView(raw.buffer).setUint32(0, n);
  return toB64(raw);
};

test('codes made by 0.1 and 0.2 still open', async () => {
  assert.equal(codeKind(V1_VAULT), 'vault');
  assert.equal(codeKind(V1_INVITE), 'share');
  const id = (base: string) => secretName(base, 'Fixture Vault');
  const { settings, secrets } = await decodeSetupCode(V1_VAULT, 'fixture vault pass', 'Fixture Vault');
  assert.deepEqual(settings, {
    storageType: 's3', endpoint: 'https://fixture.example.com', region: 'auto', bucket: 'fixture-bucket', prefix: 'fixture-prefix', pathStyle: true,
    webdavUrl: '', webdavUser: '',
    accessKeySecret: id('coffer-access-key'), secretKeySecret: id('coffer-secret-key'), webdavPasswordSecret: '', passphraseSecret: id('coffer-passphrase'),
  });
  assert.deepEqual(secrets, [[id('coffer-access-key'), 'AKIDFIXTURE'], [id('coffer-secret-key'), 'SECRETFIXTURE'], [id('coffer-passphrase'), 'fixture vault pass']]);
  await assert.rejects(decodeSetupCode(V1_VAULT, 'fixture share pass', 'Fixture Vault'), WrongPassphraseError);
  assert.equal((await decodeSetupCode(V1_VAULT.slice('coffer1.'.length), 'fixture vault pass', 'Fixture Vault')).secrets.length, 3, 'a code pasted without its prefix opens as before');

  const sid = (base: string) => shareSecretName(base, 'Fixture Vault', 'f1');
  const invite = await decodeInvite(`${V1_INVITE}\n`, 'fixture share pass', 'Fixture Vault', 'f1');
  assert.equal(invite.folder, 'Fixture');
  assert.deepEqual([invite.storage.endpoint, invite.storage.bucket, invite.storage.prefix, invite.storage.accessKeySecret, invite.storage.passphraseSecret], ['https://fixture.example.com', 'fixture-bucket', 'fixture-share', sid('coffer-access-key'), sid('coffer-passphrase')]);
  assert.deepEqual(invite.secrets, [[sid('coffer-access-key'), 'AKIDFIXTURE'], [sid('coffer-secret-key'), 'SECRETFIXTURE'], [sid('coffer-passphrase'), 'fixture share pass']]);
  await assert.rejects(decodeInvite(V1_INVITE, 'fixture vault pass', 'Fixture Vault', 'f1'), WrongPassphraseError);
  await assert.rejects(decodeInvite(V1_VAULT, 'fixture vault pass', 'Fixture Vault', 'f1'), /setup link for a whole vault/);
  await assert.rejects(decodeSetupCode(V1_INVITE, 'fixture share pass', 'Fixture Vault'), /invite link to a shared folder/);
});

test('a new setup code names its own cost, and opens with the right passphrase only', async () => {
  const code = await encodeSetupCode(vaultStorage(), lookup, undefined, 1500);
  assert.match(code, /^coffer2\./);
  assert.equal(countOf(code), 1500);
  assert.ok(!code.includes('SECRET'));
  const { settings, secrets } = await decodeSetupCode(` ${code}\n`, 'vault pass', 'My Notes');
  assert.equal(settings.bucket, 'bkt');
  assert.deepEqual(secrets.map(([, v]) => v), ['AKID', 'SECRET', 'vault pass']);
  await assert.rejects(decodeSetupCode(code, 'wrong', 'My Notes'), WrongPassphraseError);

  const invite = await encodeSetupCode(shareStorage(), lookup, 'Work', 1500);
  assert.match(invite, /^coffershare2\./);
  assert.equal(countOf(invite), 1500);
  const opened = await decodeInvite(invite, 'share pass', 'My Notes', 'j9');
  assert.equal(opened.folder, 'Work');
  assert.equal(opened.storage.prefix, 'team');
  await assert.rejects(decodeInvite(invite, 'vault pass', 'My Notes', 'j9'), WrongPassphraseError);
  await assert.rejects(decodeInvite(code, 'vault pass', 'My Notes', 'j9'), /setup link for a whole vault/);
  await assert.rejects(decodeSetupCode(invite, 'share pass', 'My Notes'), /invite link to a shared folder/);
});

/** Runs `f` and says how many keys it derived from a passphrase. */
async function derivations<T>(f: () => Promise<T>): Promise<{ result: PromiseSettledResult<T>; derived: number }> {
  const spy = mock.method(crypto.subtle, 'deriveKey');
  try {
    const [result] = await Promise.allSettled([f()]);
    return { result, derived: spy.mock.calls.filter((c) => (c.arguments[0] as { name: string }).name === 'PBKDF2').length };
  } finally {
    spy.mock.restore();
  }
}

test('a code pasted without its prefix opens as whichever version it is, and a prefixed one only as its own', async () => {
  const bare = (code: string) => code.slice(code.indexOf('.') + 1);
  const fresh = await encodeSetupCode(vaultStorage(), lookup, undefined, 1500);
  const opens = async (code: string, pass: string) => derivations(() => decodeSetupCode(code, pass, 'V'));

  // A new code: the first guess is right.
  let r = await opens(bare(fresh), 'vault pass');
  assert.equal(r.result.status === 'fulfilled' && r.result.value.settings.bucket, 'bkt');
  assert.equal(r.derived, 1);
  // An old one: its first four bytes are no plausible count for the new layout, which fails before any key is made, so the old layout costs the only derivation.
  r = await opens(bare(V1_VAULT), 'fixture vault pass');
  assert.equal(r.result.status === 'fulfilled' && r.result.value.settings.bucket, 'fixture-bucket');
  assert.equal(r.derived, 1);

  // A wrong passphrase is a wrong passphrase, whichever layout the code has.
  r = await opens(bare(V1_VAULT), 'nope');
  assert.ok(r.result.status === 'rejected' && r.result.reason instanceof WrongPassphraseError);
  assert.equal(r.derived, 1, 'an old code fails on its layout for free, then once on its passphrase');
  r = await opens(bare(fresh), 'nope');
  assert.ok(r.result.status === 'rejected' && r.result.reason instanceof WrongPassphraseError);
  assert.ok(r.derived <= 2, 'a new code cannot be told from an old one before a key is made');
  r = await opens('not a code!', 'vault pass');
  assert.ok(r.result.status === 'rejected' && /not a valid setup code/.test((r.result.reason as Error).message));
  assert.equal(r.derived, 0);

  // With a prefix there is nothing to guess: each is opened as its own version, once.
  r = await opens(`coffer2.${bare(V1_VAULT)}`, 'fixture vault pass');
  assert.ok(r.result.status === 'rejected' && /not a valid setup code/.test((r.result.reason as Error).message));
  assert.equal(r.derived, 0);
  r = await opens(`coffer1.${bare(fresh)}`, 'vault pass');
  assert.ok(r.result.status === 'rejected' && r.result.reason instanceof WrongPassphraseError);
  assert.equal(r.derived, 1);
  r = await opens(fresh, 'nope');
  assert.ok(r.result.status === 'rejected' && r.result.reason instanceof WrongPassphraseError);
  assert.equal(r.derived, 1);
  r = await opens(V1_VAULT, 'fixture vault pass');
  assert.equal(r.result.status, 'fulfilled');
  assert.equal(r.derived, 1);
});

test('a link is sealed at no less than a new vault gets, and at the vault\'s own cost when that is higher', async () => {
  assert.equal(codeIterations(), 600_000);
  assert.equal(codeIterations(1000), 600_000, 'a vault made cheaply still gets a link that costs a guesser the full price');
  assert.equal(codeIterations(900_000), 900_000);
  const code = await encodeSetupCode(vaultStorage(), lookup);
  assert.equal(countOf(code), codeIterations());
  assert.equal((await decodeSetupCode(code, 'vault pass', 'V')).settings.bucket, 'bkt');
});

test('sealed text rejects counts that are zero, absurd or tampered with, and codes that are cut short', async () => {
  const sealed = await sealWithPassphrase('{"a":1}', 'pass', 1000);
  assert.equal(await openWithPassphrase(sealed, 'pass'), '{"a":1}');
  await assert.rejects(openWithPassphrase(sealed, 'nope'), WrongPassphraseError);
  assert.equal(await openWithPassphrase(await sealWithPassphrase('x', 'pass', 1000), 'pass'), 'x', 'the shortest text there is');

  await assert.rejects(openWithPassphrase(withCount(sealed, MAX_CODE_ITERATIONS + 1), 'pass'), /not a valid setup code/);
  await assert.rejects(openWithPassphrase(withCount(sealed, 0), 'pass'), /not a valid setup code/);
  await assert.rejects(openWithPassphrase(withCount(sealed, 0xffffffff), 'pass'), /not a valid setup code/);
  await assert.rejects(openWithPassphrase(withCount(sealed, 1001), 'pass'), WrongPassphraseError, 'a changed count only derives another key');

  const raw = fromB64(sealed);
  await assert.rejects(openWithPassphrase(toB64(raw.subarray(0, 48)), 'pass'), /not a valid setup code/);
  await assert.rejects(openWithPassphrase(toB64(raw.subarray(0, raw.length - 1)), 'pass'), WrongPassphraseError);
  await assert.rejects(openWithPassphrase('not a code!', 'pass'), /not a valid setup code/);
  await assert.rejects(openWithPassphrase(sealed, 'pass', true), WrongPassphraseError, 'the old layout cannot be mistaken for the new one');
});

test('links and invites of both versions round-trip through setupLink and setupCodeFrom', async () => {
  const codes = [V1_VAULT, V1_INVITE, await encodeSetupCode(vaultStorage(), lookup, undefined, 1000), await encodeSetupCode(shareStorage(), lookup, 'Work', 1000)];
  const kinds = ['vault', 'share', 'vault', 'share'];
  codes.forEach((code, i) => {
    assert.equal(codeKind(code), kinds[i]);
    assert.equal(codeKind(`  ${code}\n`), kinds[i]);
    const link = setupLink(code);
    assert.match(link, new RegExp(`^obsidian://coffer\\?${kinds[i] === 'share' ? 'share' : 'setup'}=coffer`));
    assert.equal(setupCodeFrom(link), code);
    assert.equal(setupCodeFrom(`  ${code}\n`), code);
  });
  assert.equal(codeKind('coffer3.abc'), undefined);
  assert.equal(codeKind('coffershare.abc'), undefined);
  assert.equal(codeKind('hello'), undefined);
});

test('a generated passphrase has 100 bits in a fixed shape, without look-alike characters', () => {
  const seen = new Set<string>();
  const all = new Set<string>();
  for (let i = 0; i < 2000; i++) {
    const p = generatePassphrase();
    assert.match(p, /^[a-kmnp-z2-9]{4}(-[a-kmnp-z2-9]{4}){4}$/);
    seen.add(p);
    for (const ch of p.replaceAll('-', '')) all.add(ch);
  }
  assert.equal(seen.size, 2000, 'no two alike');
  assert.equal(all.size, 32, 'every symbol is used');
  for (const ch of 'l1o0') assert.ok(!all.has(ch));
});

test('re-wrapping keys can raise the cost and never lowers it', async () => {
  const { header, keys } = await createKeys('old', 1000);
  assert.equal(header.iter, 1000);
  const sealed = await seal(keys, new Uint8Array([1, 2, 3]), 'x');

  const raised = await rewrapKeys(header, 'old', 'new', 2000);
  assert.equal(raised.iter, 2000);
  assert.deepEqual((await open(await unlockKeys(raised, 'new'), sealed, 'x')).plain, new Uint8Array([1, 2, 3]), 'the same master key');
  await assert.rejects(unlockKeys(raised, 'old'), WrongPassphraseError);

  assert.equal((await rewrapKeys(header, 'old', 'new', 500)).iter, 1000);
  assert.equal((await rewrapKeys(header, 'old', 'new')).iter, 1000);
  assert.equal((await rewrapKeys(raised, 'new', 'newer', 1000)).iter, 2000);
  await assert.rejects(rewrapKeys(header, 'wrong', 'new', 2000), WrongPassphraseError);
});

test('changing the passphrase raises the vault to the configured cost, which a link then carries', async () => {
  const clock = { now: 1_800_000_000_000 };
  const mem = new MemoryStore(() => clock.now);
  const net = new SimStore(mem);
  const stored = async () => (JSON.parse(new TextDecoder().decode((await mem.get('vault.json'))!)) as { kdf: { iter: number } }).kdf.iter;
  const device = (passphrase: string, config = {}) => {
    const d = new Device('C', net, clock, config);
    d.engine = new SyncEngine({ fs: d.fs, store: net, stateStore: d.state, passphrase, config: d.config });
    return d;
  };

  const a = new Device('A', net, clock);
  const b = new Device('B', net, clock);
  a.fs.put('n.md', 'x\n');
  await a.sync();
  await b.sync();
  assert.equal(await stored(), 1000);
  assert.equal(await a.engine.kdfIterations(), 1000);

  const strong = device('test passphrase', { kdfIterations: 3000 });
  await strong.engine.changePassphrase('new passphrase');
  assert.equal(await stored(), 3000);
  assert.equal(await strong.engine.kdfIterations(), 3000);

  await assert.rejects(device('test passphrase').sync(), /Wrong passphrase/);
  const restarted = device('new passphrase');
  await restarted.sync();
  assert.equal(restarted.fs.text('n.md'), 'x\n');
  assert.equal(await restarted.engine.kdfIterations(), 3000, 'a device that opens the vault later reads the new cost');

  b.fs.put('n.md', 'x\ny\n');
  await b.sync();
  await restarted.sync();
  assert.equal(restarted.fs.text('n.md'), 'x\ny\n', 'a device that was already running keeps working with the key it holds');

  await device('new passphrase').engine.changePassphrase('newer passphrase');
  assert.equal(await stored(), 3000, 'a device set to a lower cost leaves it where it is');

  const link = await encodeSetupCode(vaultStorage(), lookup, undefined, codeIterations(await restarted.engine.kdfIterations()));
  assert.ok(countOf(link) >= 3000);
  assert.equal(countOf(link), codeIterations(3000));
});
