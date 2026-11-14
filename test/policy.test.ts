import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keyPolicy, POLICY_KINDS, providerFromEndpoint, type PolicyKind, type PolicyProvider } from '../src/core/policy.ts';

const at = (provider: PolicyProvider, prefix: string, kind: PolicyKind, bucket = 'my-notes') => keyPolicy({ provider, bucket, prefix }, kind);
const doc = (...statements: object[]) => JSON.stringify({ Version: '2012-10-17', Statement: statements }, null, 2);

const AWS_USER = 'In the AWS console, open IAM, make a user with this policy, and make an access key for it.';
const OTHER_USER = 'Make a user in your storage service with this policy, and make an access key for it';
const NOTE = 'Most S3-compatible services accept this policy, but if yours can only limit a key to a whole bucket, keep this folder in a bucket of its own.';

const list = (prefix?: string) => ({
  Effect: 'Allow',
  Action: 's3:ListBucket',
  Resource: 'arn:aws:s3:::my-notes',
  ...(prefix === undefined ? {} : { Condition: { StringLike: { 's3:prefix': prefix } } }),
});
const get = (resource: string) => ({ Effect: 'Allow', Action: 's3:GetObject', Resource: resource });
const readWrite = (resource: string) => ({ Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'], Resource: resource });
const put = (resource: string) => ({ Effect: 'Allow', Action: 's3:PutObject', Resource: resource });
const anyone = (resource: string) => ({ Effect: 'Allow', Principal: '*', Action: 's3:GetObject', Resource: resource });

test('policy: Amazon S3 policies for a folder in a bucket', () => {
  assert.deepEqual(at('aws', 'Notes', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: true,
    steps: `${AWS_USER} The key can read and change this folder and nothing else.`,
    text: doc(list('Notes/*'), readWrite('arn:aws:s3:::my-notes/Notes/*')),
  });
  assert.deepEqual(at('aws', 'Notes', 'readOnly'), {
    kind: 'readOnly',
    title: 'Read only',
    possible: true,
    steps: `${AWS_USER} The key can read this folder but can not change or delete anything.`,
    text: doc(list('Notes/*'), get('arn:aws:s3:::my-notes/Notes/*')),
  });
  assert.deepEqual(at('aws', 'Notes', 'readAndInbox'), {
    kind: 'readAndInbox',
    title: 'Read, and send suggestions',
    possible: true,
    steps: `${AWS_USER} The key can read this folder and add files to its inbox folder, nothing more.`,
    text: doc(list('Notes/*'), get('arn:aws:s3:::my-notes/Notes/*'), put('arn:aws:s3:::my-notes/Notes/inbox/*')),
  });
  assert.deepEqual(at('aws', 'Notes', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: true,
    steps:
      "In the AWS console, open the bucket's Permissions, turn off Block public access, and paste this as the bucket policy. " +
      'Anyone with the address can download files in this folder, but not list or change them.',
    text: doc(anyone('arn:aws:s3:::my-notes/Notes/*')),
  });
});

test('policy: the text is pinned to the byte for one policy', () => {
  assert.equal(
    at('aws', 'Notes', 'readOnly').text,
    `{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::my-notes",
      "Condition": {
        "StringLike": {
          "s3:prefix": "Notes/*"
        }
      }
    },
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::my-notes/Notes/*"
    }
  ]
}`,
  );
});

test('policy: Amazon S3 policies for a whole bucket have no prefix condition', () => {
  assert.deepEqual(at('aws', '', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: true,
    steps: `${AWS_USER} The key can read and change this bucket and nothing else.`,
    text: doc(list(), readWrite('arn:aws:s3:::my-notes/*')),
  });
  assert.equal(at('aws', '', 'readOnly').text, doc(list(), get('arn:aws:s3:::my-notes/*')));
  assert.equal(at('aws', '', 'readAndInbox').text, doc(list(), get('arn:aws:s3:::my-notes/*'), put('arn:aws:s3:::my-notes/inbox/*')));
  assert.equal(at('aws', '', 'publicRead').text, doc(anyone('arn:aws:s3:::my-notes/*')));
  assert.equal(at('aws', '', 'readOnly').steps, `${AWS_USER} The key can read this bucket but can not change or delete anything.`);
});

test('policy: other S3-compatible services get the same policies with their own words', () => {
  for (const prefix of ['Notes', '']) {
    for (const kind of POLICY_KINDS) {
      assert.equal(at('s3', prefix, kind).text, at('aws', prefix, kind).text);
    }
  }
  assert.equal(at('s3', 'Notes', 'readWrite').steps, `${OTHER_USER}; the key can read and change this folder and nothing else. ${NOTE}`);
  assert.equal(at('s3', 'Notes', 'readOnly').steps, `${OTHER_USER}; the key can read this folder but can not change or delete anything. ${NOTE}`);
  assert.equal(at('s3', 'Notes', 'readAndInbox').steps, `${OTHER_USER}; the key can read this folder and add files to its inbox folder, nothing more. ${NOTE}`);
  assert.equal(
    at('s3', 'Notes', 'publicRead').steps,
    'Paste this as the bucket policy in your storage service; anyone with the address can then download files in this folder, but not list or change them. ' +
      'If it has no bucket policies, keep this folder in a bucket of its own and make that bucket public.',
  );
  assert.equal(at('s3', '', 'readOnly').steps, `${OTHER_USER}; the key can read this bucket but can not change or delete anything. ${NOTE}`);
  assert.equal(at('s3', '', 'publicRead').possible, true);
});

const B2_KEY = 'In Backblaze, open Application Keys, add a key with these settings, and enter its key ID and key here.';
const B2_NO_INBOX =
  'Backblaze can not do this: a key has one file name prefix and one type of access, so it can not read this folder and write only to its inbox. ' +
  'Give this person a read only key and leave suggestions off, or a read and write key, which can also change and delete what is stored.';

test('policy: Backblaze B2 application keys', () => {
  assert.deepEqual(at('b2', 'Notes', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: true,
    steps: `${B2_KEY} The key can read and change this folder and nothing else.`,
    text: [
      'Allow access to buckets: my-notes',
      'Type of access: Read and Write',
      'File name prefix: Notes/',
      'Capabilities, if you choose them yourself: listBuckets, listFiles, readFiles, writeFiles, deleteFiles',
    ].join('\n'),
  });
  assert.deepEqual(at('b2', 'Notes', 'readOnly'), {
    kind: 'readOnly',
    title: 'Read only',
    possible: true,
    steps: `${B2_KEY} The key can read this folder but can not change or delete anything.`,
    text: [
      'Allow access to buckets: my-notes',
      'Type of access: Read Only',
      'File name prefix: Notes/',
      'Capabilities, if you choose them yourself: listBuckets, listFiles, readFiles',
    ].join('\n'),
  });
  assert.deepEqual(at('b2', 'Notes', 'readAndInbox'), {
    kind: 'readAndInbox',
    title: 'Read, and send suggestions',
    possible: false,
    steps: B2_NO_INBOX,
    text: '',
  });
  assert.deepEqual(at('b2', 'Notes', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: false,
    steps: "Backblaze makes a whole bucket public, never one folder. Keep this shared folder in a bucket of its own, set to Public, and share the address of that bucket.",
    text: '',
  });
});

test('policy: Backblaze B2 with no folder covers the whole bucket, and a bucket can be public', () => {
  assert.equal(
    at('b2', '', 'readWrite').text,
    [
      'Allow access to buckets: my-notes',
      'Type of access: Read and Write',
      'Capabilities, if you choose them yourself: listBuckets, listFiles, readFiles, writeFiles, deleteFiles',
    ].join('\n'),
  );
  assert.equal(at('b2', '', 'readOnly').steps, `${B2_KEY} The key can read this bucket but can not change or delete anything.`);
  assert.equal(at('b2', '', 'readAndInbox').possible, false);
  assert.deepEqual(at('b2', '', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: true,
    steps:
      'In Backblaze, open the settings of the bucket and set it to Public. Anyone with the address can download every file in the bucket, but not list or change them.',
    text: 'Bucket: my-notes\nFiles in bucket are: Public',
  });
});

const R2_MAKE = 'In Cloudflare, open R2, then Manage API tokens, and create a token with these settings; enter its access key ID and secret here.';
const R2_BUCKET_ONLY =
  'Cloudflare R2 can limit a token to a bucket but not to a folder in it, so the token would reach every folder in the bucket. ' +
  'Keep this shared folder in a bucket of its own and make the token for that bucket.';

test('policy: Cloudflare R2 tokens are per bucket, so a folder needs a bucket of its own', () => {
  assert.deepEqual(at('r2', '', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: true,
    steps: `${R2_MAKE} The token can read and change this bucket and nothing else.`,
    text: 'Permission: Object Read & Write\nBucket: my-notes only',
  });
  assert.deepEqual(at('r2', '', 'readOnly'), {
    kind: 'readOnly',
    title: 'Read only',
    possible: true,
    steps: `${R2_MAKE} The token can read this bucket but can not change or delete anything.`,
    text: 'Permission: Object Read only\nBucket: my-notes only',
  });
  assert.deepEqual(at('r2', 'Notes', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: false,
    steps: R2_BUCKET_ONLY,
    text: 'Permission: Object Read & Write\nBucket: a bucket that holds only this folder',
  });
  assert.deepEqual(at('r2', 'Notes', 'readOnly'), {
    kind: 'readOnly',
    title: 'Read only',
    possible: false,
    steps: R2_BUCKET_ONLY,
    text: 'Permission: Object Read only\nBucket: a bucket that holds only this folder',
  });
});

test('policy: Cloudflare R2 can not read a folder and write only to its inbox', () => {
  const steps =
    'Cloudflare R2 can not do this: a token reads or writes a whole bucket, never one folder in it. ' +
    'Give this person a read only token and leave suggestions off, or a read and write token for a bucket of its own, which can also change and delete what is stored.';
  for (const prefix of ['Notes', '']) {
    assert.deepEqual(at('r2', prefix, 'readAndInbox'), { kind: 'readAndInbox', title: 'Read, and send suggestions', possible: false, steps, text: '' });
  }
});

test('policy: Cloudflare R2 makes a whole bucket public, never one folder', () => {
  assert.deepEqual(at('r2', '', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: true,
    steps:
      'In Cloudflare, open Settings for the bucket and add a custom domain (the r2.dev address works but is only meant for testing). ' +
      'Anyone with the address can download files from the bucket, but not list them.',
    text: 'Bucket: my-notes\nPublic access: custom domain (or the r2.dev address, for testing)',
  });
  assert.deepEqual(at('r2', 'Notes', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: false,
    steps: 'Cloudflare makes a whole bucket public, never one folder. Keep this shared folder in a bucket of its own and make that bucket public.',
    text: '',
  });
});

test('policy: WebDAV uses a separate user, and has no inbox or public link', () => {
  assert.deepEqual(at('webdav', '', 'readWrite'), {
    kind: 'readWrite',
    title: 'Read and write this folder only',
    possible: true,
    steps:
      'A WebDAV login usually reaches everything its user can, so make a separate user for this folder and enter their name and password here. ' +
      'On Nextcloud, add a user, share the folder with them so they can edit, and make an app password for them.',
    text: '',
  });
  assert.deepEqual(at('webdav', '', 'readOnly'), {
    kind: 'readOnly',
    title: 'Read only',
    possible: true,
    steps:
      'Make a separate user who can only read this folder, and enter their name and password here. ' +
      'On Nextcloud, share the folder with a new user as read only and make an app password for them; ' +
      'if your server can not limit a user to reading, the password can still change things, even though their Coffer will not.',
    text: '',
  });
  assert.deepEqual(at('webdav', '', 'readAndInbox'), {
    kind: 'readAndInbox',
    title: 'Read, and send suggestions',
    possible: false,
    steps:
      'A WebDAV login reaches the whole folder it is given, so it can not read the folder and write only to its inbox. ' +
      'Give this person a read only user and leave suggestions off, or a user who can edit the folder, which can also change and delete what is stored.',
    text: '',
  });
  assert.deepEqual(at('webdav', '', 'publicRead'), {
    kind: 'publicRead',
    title: 'Anyone with the link can read',
    possible: false,
    steps:
      'A WebDAV folder can not be made public for plain downloads. ' +
      'Serve this folder from a web server that shows files without a login or a file listing, or keep this shared folder in a bucket that is public.',
    text: '',
  });
});

test('policy: WebDAV has no bucket or prefix to name', () => {
  for (const kind of POLICY_KINDS) {
    assert.deepEqual(keyPolicy({ provider: 'webdav', bucket: '', prefix: 'Notes' }, kind), at('webdav', '', kind, 'other'));
  }
});

test('policy: slashes around the prefix do not change anything', () => {
  for (const provider of ['aws', 'b2'] as const) {
    for (const kind of POLICY_KINDS) {
      const plain = at(provider, 'Notes', kind);
      for (const prefix of ['Notes/', '/Notes', '/Notes/', 'Notes///', '///Notes']) assert.deepEqual(at(provider, prefix, kind), plain, `${provider} ${kind} ${prefix}`);
    }
  }
});

test('policy: a prefix of only slashes is the whole bucket', () => {
  for (const provider of ['aws', 's3', 'b2', 'r2'] as const) {
    for (const kind of POLICY_KINDS) assert.deepEqual(at(provider, '///', kind), at(provider, '', kind));
  }
});

test('policy: a nested folder keeps its slashes inside', () => {
  const policy = at('aws', 'family/shared', 'readAndInbox');
  assert.equal(policy.text, doc(list('family/shared/*'), get('arn:aws:s3:::my-notes/family/shared/*'), put('arn:aws:s3:::my-notes/family/shared/inbox/*')));
  assert.match(at('b2', 'family/shared', 'readWrite').text, /^File name prefix: family\/shared\/$/m);
});

test('policy: characters that mean something in policy language are escaped', () => {
  const policy = JSON.parse(at('aws', 'a$b*c?d', 'readWrite').text);
  assert.equal(policy.Statement[0].Condition.StringLike['s3:prefix'], 'a${$}b${*}c${?}d/*');
  assert.equal(policy.Statement[1].Resource, 'arn:aws:s3:::my-notes/a${$}b${*}c${?}d/*');
  assert.match(at('b2', 'a$b*c?d', 'readWrite').text, /^File name prefix: a\$b\*c\?d\/$/m);
});

test('policy: quotes and non-ASCII names stay valid JSON', () => {
  const policy = JSON.parse(at('aws', 'My "notes" ✓', 'readOnly').text);
  assert.equal(policy.Statement[0].Condition.StringLike['s3:prefix'], 'My "notes" ✓/*');
  assert.equal(policy.Statement[1].Resource, 'arn:aws:s3:::my-notes/My "notes" ✓/*');
});

test('policy: every kind for every provider says what it is and gives one or two sentences', () => {
  for (const provider of ['aws', 's3', 'b2', 'r2', 'webdav'] as const) {
    for (const prefix of ['Notes', '']) {
      POLICY_KINDS.forEach((kind) => {
        const p = at(provider, prefix, kind);
        assert.equal(p.kind, kind);
        assert.ok(p.title);
        // Sentences end with a full stop followed by a capital, or the end of the text.
        const sentences = p.steps.match(/[.!?](\s+[A-Z]|$)/g)!.length;
        assert.ok(sentences >= 1 && sentences <= 2, `${provider} ${kind}: ${p.steps}`);
        if (p.possible && provider !== 'webdav') assert.ok(p.text, `${provider} ${kind} has text to copy`);
      });
    }
  }
});

/** Tells whether the Allow statements of an S3 policy let `action` reach `key` (or list under `key`), as S3 would read them. */
function allows(policyText: string, action: string, key: string): boolean {
  const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);
  const statements: { Action: string | string[]; Resource: string; Condition?: { StringLike: { 's3:prefix': string } } }[] = JSON.parse(policyText).Statement;
  return statements.some((s) => {
    if (![s.Action].flat().includes(action)) return false;
    if (action === 's3:ListBucket') {
      return s.Resource === 'arn:aws:s3:::my-notes' && (!s.Condition || glob(s.Condition.StringLike['s3:prefix']).test(key));
    }
    return glob(s.Resource).test(`arn:aws:s3:::my-notes/${key}`);
  });
}

test('policy: the folder policies grant exactly what a device does there, and no more', () => {
  // What src/stores/s3.ts asks for: GET, PUT, DELETE of one key, and LIST under a prefix that ends with a slash.
  const inside = ['vault.json', 'log/000001', 'snap/000010', 'idx/0a1b', 'pack/ff00', 'pruned', 'inbox/lan-1700000000', 'doctor/x'];
  const outside = ['Notes2/vault.json', 'Note/vault.json', 'Other/log/000001', 'vault.json'];
  const mine = (key: string) => `Notes/${key}`;
  const matrix: [PolicyKind, { get: boolean; put: boolean; putInbox: boolean; del: boolean }][] = [
    ['readWrite', { get: true, put: true, putInbox: true, del: true }],
    ['readOnly', { get: true, put: false, putInbox: false, del: false }],
    ['readAndInbox', { get: true, put: false, putInbox: true, del: false }],
  ];
  for (const [kind, can] of matrix) {
    const text = at('aws', 'Notes', kind).text;
    for (const key of inside) {
      assert.equal(allows(text, 's3:GetObject', mine(key)), can.get, `${kind} GET ${key}`);
      const isInbox = key.startsWith('inbox/');
      assert.equal(allows(text, 's3:PutObject', mine(key)), isInbox ? can.putInbox : can.put, `${kind} PUT ${key}`);
      assert.equal(allows(text, 's3:DeleteObject', mine(key)), can.del, `${kind} DELETE ${key}`);
    }
    for (const key of outside) {
      for (const action of ['s3:GetObject', 's3:PutObject', 's3:DeleteObject']) assert.equal(allows(text, action, key), false, `${kind} ${action} ${key}`);
    }
    for (const prefix of ['Notes/', 'Notes/log/', 'Notes/snap/', 'Notes/doctor/']) assert.equal(allows(text, 's3:ListBucket', prefix), true, `${kind} LIST ${prefix}`);
    for (const prefix of ['', 'Notes2/', 'Other/', 'Notes']) assert.equal(allows(text, 's3:ListBucket', prefix), false, `${kind} LIST ${prefix}`);
    // A missing key answers 404 only to a key that may list it, which is the same rule as listing under it.
    assert.equal(allows(text, 's3:ListBucket', mine('log/000099')), true);
  }
});

test('policy: a policy for a whole bucket lets a key list and read anywhere in it', () => {
  const text = at('aws', '', 'readWrite').text;
  assert.equal(allows(text, 's3:ListBucket', ''), true);
  assert.equal(allows(text, 's3:ListBucket', 'log/'), true);
  assert.equal(allows(text, 's3:GetObject', 'log/000001'), true);
  assert.equal(allows(at('aws', '', 'readAndInbox').text, 's3:PutObject', 'inbox/lan-1'), true);
  assert.equal(allows(at('aws', '', 'readAndInbox').text, 's3:PutObject', 'log/000001'), false);
});

test('policy: public read reads objects of the folder only and never lists', () => {
  const text = at('aws', 'Notes', 'publicRead').text;
  const policy = JSON.parse(text);
  assert.equal(policy.Statement.length, 1);
  assert.equal(policy.Statement[0].Principal, '*');
  assert.equal(allows(text, 's3:GetObject', 'Notes/log/000001'), true);
  assert.equal(allows(text, 's3:GetObject', 'Notes2/log/000001'), false);
  assert.equal(allows(text, 's3:ListBucket', 'Notes/'), false);
  assert.equal(allows(text, 's3:PutObject', 'Notes/log/000001'), false);
});

test('policy: provider from an S3 endpoint', () => {
  const cases: [string, ReturnType<typeof providerFromEndpoint>][] = [
    ['https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com', 'r2'],
    ['https://0123456789abcdef0123456789abcdef.eu.r2.cloudflarestorage.com', 'r2'],
    ['0123456789abcdef.r2.cloudflarestorage.com', 'r2'],
    ['https://my-notes.0123456789abcdef.r2.cloudflarestorage.com/', 'r2'],
    ['https://s3.us-west-004.backblazeb2.com', 'b2'],
    ['s3.us-west-004.backblazeb2.com', 'b2'],
    ['https://my-notes.s3.us-west-004.backblazeb2.com', 'b2'],
    ['https://s3.us-east-1.amazonaws.com', 'aws'],
    ['https://s3.amazonaws.com', 'aws'],
    ['https://my-notes.s3.eu-west-2.amazonaws.com/', 'aws'],
    ['HTTPS://S3.US-EAST-1.AMAZONAWS.COM', 'aws'],
    ['  https://s3.us-east-1.amazonaws.com  ', 'aws'],
    ['https://s3.eu-central-1.wasabisys.com', 's3'],
    ['http://localhost:9000', 's3'],
    ['https://minio.example.com', 's3'],
    ['https://nyc3.digitaloceanspaces.com', 's3'],
    ['https://amazonaws.com.example.com', 's3'],
    ['https://notamazonaws.com', 's3'],
    ['', 's3'],
    ['not a url at all', 's3'],
  ];
  for (const [endpoint, provider] of cases) assert.equal(providerFromEndpoint(endpoint), provider, endpoint);
});
