/**
 * Copy-ready access rules for the storage key that goes into an invite: what to paste into the provider's console so a
 * key reaches only the shared folder, and what to do instead where the provider can not limit a key that way.
 *
 * The S3 operations Coffer uses (src/stores/s3.ts) are GET (with ranges), PUT (with If-None-Match), DELETE, and
 * ListObjectsV2 under the folder, so a key needs exactly those and nothing else.
 */

export type PolicyProvider = 'aws' | 'b2' | 'r2' | 's3' | 'webdav';

/**
 * readWrite: a device that syncs. readOnly: a device that only receives. readAndInbox: receives, and may add files
 * under inbox/ for suggestions. publicRead: anyone with the address may download files, for a follow link.
 */
export type PolicyKind = 'readWrite' | 'readOnly' | 'readAndInbox' | 'publicRead';

export const POLICY_KINDS: readonly PolicyKind[] = ['readWrite', 'readOnly', 'readAndInbox', 'publicRead'];

export interface PolicyTarget {
  provider: PolicyProvider;
  bucket: string;
  /** The folder in the bucket, as in the storage settings; slashes at the ends do not matter. Ignored for WebDAV. */
  prefix: string;
}

export interface Policy {
  kind: PolicyKind;
  title: string;
  /**
   * False when the provider can not do this. `steps` then says what to do instead, and `text` holds the settings for
   * the nearest thing that works, or is empty.
   */
  possible: boolean;
  /** One or two plain sentences: where to paste `text`, or what to do instead. */
  steps: string;
  /** What to copy: a policy in JSON, or the settings to pick in the provider's console. Empty when there is nothing. */
  text: string;
}

/** The provider an S3 endpoint belongs to, from its host name. Anything not recognised is another S3-compatible service. */
export function providerFromEndpoint(endpoint: string): Exclude<PolicyProvider, 'webdav'> {
  let host: string;
  try {
    host = new URL(/^https?:\/\//i.test(endpoint.trim()) ? endpoint.trim() : `https://${endpoint.trim()}`).hostname.toLowerCase();
  } catch {
    return 's3';
  }
  const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (under('r2.cloudflarestorage.com')) return 'r2';
  if (under('backblazeb2.com')) return 'b2';
  if (under('amazonaws.com')) return 'aws';
  return 's3';
}

const TITLES: Record<PolicyKind, string> = {
  readWrite: 'Read and write this folder only',
  readOnly: 'Read only',
  readAndInbox: 'Read, and send suggestions',
  publicRead: 'Anyone with the link can read',
};

export function keyPolicy(target: PolicyTarget, kind: PolicyKind): Policy {
  const { provider, bucket } = target;
  const folder = target.prefix.replace(/^\/+|\/+$/g, '');
  const made = provider === 'b2' ? b2(bucket, folder, kind) : provider === 'r2' ? r2(bucket, folder, kind) : provider === 'webdav' ? webdav(kind) : s3(provider === 'aws', bucket, folder, kind);
  return { kind, title: TITLES[kind], ...made };
}

type Made = Pick<Policy, 'possible' | 'steps' | 'text'>;

const yes = (steps: string, text: string): Made => ({ possible: true, steps, text });
const no = (steps: string, text = ''): Made => ({ possible: false, steps, text });

/** Policy language treats these three characters as wildcards or variables, so a folder named with one must escape it. */
const literal = (s: string) => s.replace(/[$*?]/g, (c) => `\${${c}}`);

const json = (v: unknown) => JSON.stringify(v, null, 2);

/** The bucket, or the folder in it, as the user words it. */
const where = (folder: string) => (folder ? 'this folder' : 'this bucket');

/** Amazon S3, and the services that read the same policy language. */
function s3(aws: boolean, bucket: string, folder: string, kind: PolicyKind): Made {
  const bucketArn = `arn:aws:s3:::${bucket}`;
  const objects = (inside = '') => `${bucketArn}/${folder ? `${literal(folder)}/` : ''}${inside}*`;
  const list = {
    Effect: 'Allow',
    Action: 's3:ListBucket',
    Resource: bucketArn,
    ...(folder ? { Condition: { StringLike: { 's3:prefix': `${literal(folder)}/*` } } } : {}),
  };
  const policy = (...statements: object[]) => json({ Version: '2012-10-17', Statement: statements });
  const lead = aws
    ? 'In the AWS console, open IAM, make a user with this policy, and make an access key for it.'
    : 'Make a user in your storage service with this policy, and make an access key for it';
  const steps = (can: string) =>
    aws
      ? `${lead} The key can ${can}.`
      : `${lead}; the key can ${can}. Most S3-compatible services accept this policy, but if yours can only limit a key to a whole bucket, keep this folder in a bucket of its own.`;

  switch (kind) {
    case 'readWrite':
      return yes(
        steps(`read and change ${where(folder)} and nothing else`),
        policy(list, { Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: objects() }),
      );
    case 'readOnly':
      return yes(
        steps(`read ${where(folder)} but can not change or delete anything`),
        policy(list, { Effect: 'Allow', Action: 's3:GetObject', Resource: objects() }),
      );
    case 'readAndInbox':
      return yes(
        steps(`read ${where(folder)} and add files to its inbox folder, nothing more`),
        policy(list, { Effect: 'Allow', Action: 's3:GetObject', Resource: objects() }, { Effect: 'Allow', Action: 's3:PutObject', Resource: objects('inbox/') }),
      );
    case 'publicRead':
      return yes(
        aws
          ? `In the AWS console, open the bucket's Permissions, turn off Block public access, and paste this as the bucket policy. Anyone with the address can download files in ${where(folder)}, but not list or change them.`
          : `Paste this as the bucket policy in your storage service; anyone with the address can then download files in ${where(folder)}, but not list or change them. If it has no bucket policies, keep this folder in a bucket of its own and make that bucket public.`,
        json({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: objects() }] }),
      );
  }
}

function b2(bucket: string, folder: string, kind: PolicyKind): Made {
  const form = (access: string, capabilities: string) =>
    [
      `Allow access to buckets: ${bucket}`,
      `Type of access: ${access}`,
      ...(folder ? [`File name prefix: ${folder}/`] : []),
      `Capabilities, if you choose them yourself: ${capabilities}`,
    ].join('\n');
  const key = 'In Backblaze, open Application Keys, add a key with these settings, and enter its key ID and key here.';

  switch (kind) {
    case 'readWrite':
      return yes(`${key} The key can read and change ${where(folder)} and nothing else.`, form('Read and Write', 'listBuckets, listFiles, readFiles, writeFiles, deleteFiles'));
    case 'readOnly':
      return yes(`${key} The key can read ${where(folder)} but can not change or delete anything.`, form('Read Only', 'listBuckets, listFiles, readFiles'));
    case 'readAndInbox':
      return no(
        'Backblaze can not do this: a key has one file name prefix and one type of access, so it can not read this folder and write only to its inbox. ' +
          'Give this person a read only key and leave suggestions off, or a read and write key, which can also change and delete what is stored.',
      );
    case 'publicRead':
      return folder
        ? no('Backblaze makes a whole bucket public, never one folder. Keep this shared folder in a bucket of its own, set to Public, and share the address of that bucket.')
        : yes(
            'In Backblaze, open the settings of the bucket and set it to Public. Anyone with the address can download every file in the bucket, but not list or change them.',
            `Bucket: ${bucket}\nFiles in bucket are: Public`,
          );
  }
}

function r2(bucket: string, folder: string, kind: PolicyKind): Made {
  const token = (permission: string) => `Permission: ${permission}\nBucket: ${folder ? 'a bucket that holds only this folder' : `${bucket} only`}`;
  const bucketOnly = 'Cloudflare R2 can limit a token to a bucket but not to a folder in it, so the token would reach every folder in the bucket. Keep this shared folder in a bucket of its own and make the token for that bucket.';
  const make = 'In Cloudflare, open R2, then Manage API tokens, and create a token with these settings; enter its access key ID and secret here.';

  switch (kind) {
    case 'readWrite':
      return folder ? no(bucketOnly, token('Object Read & Write')) : yes(`${make} The token can read and change this bucket and nothing else.`, token('Object Read & Write'));
    case 'readOnly':
      return folder ? no(bucketOnly, token('Object Read only')) : yes(`${make} The token can read this bucket but can not change or delete anything.`, token('Object Read only'));
    case 'readAndInbox':
      return no(
        'Cloudflare R2 can not do this: a token reads or writes a whole bucket, never one folder in it. ' +
          'Give this person a read only token and leave suggestions off, or a read and write token for a bucket of its own, which can also change and delete what is stored.',
      );
    case 'publicRead':
      return folder
        ? no('Cloudflare makes a whole bucket public, never one folder. Keep this shared folder in a bucket of its own and make that bucket public.')
        : yes(
            'In Cloudflare, open Settings for the bucket and add a custom domain (the r2.dev address works but is only meant for testing). Anyone with the address can download files from the bucket, but not list them.',
            `Bucket: ${bucket}\nPublic access: custom domain (or the r2.dev address, for testing)`,
          );
  }
}

function webdav(kind: PolicyKind): Made {
  switch (kind) {
    case 'readWrite':
      return yes(
        'A WebDAV login usually reaches everything its user can, so make a separate user for this folder and enter their name and password here. On Nextcloud, add a user, share the folder with them so they can edit, and make an app password for them.',
        '',
      );
    case 'readOnly':
      return yes(
        'Make a separate user who can only read this folder, and enter their name and password here. On Nextcloud, share the folder with a new user as read only and make an app password for them; if your server can not limit a user to reading, the password can still change things, even though their Coffer will not.',
        '',
      );
    case 'readAndInbox':
      return no(
        'A WebDAV login reaches the whole folder it is given, so it can not read the folder and write only to its inbox. ' +
          'Give this person a read only user and leave suggestions off, or a user who can edit the folder, which can also change and delete what is stored.',
      );
    case 'publicRead':
      return no(
        'A WebDAV folder can not be made public for plain downloads. Serve this folder from a web server that shows files without a login or a file listing, or keep this shared folder in a bucket that is public.',
      );
  }
}
