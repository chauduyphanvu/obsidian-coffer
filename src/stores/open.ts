import type { RemoteStore } from '../core/types.ts';
import type { Http } from './http.ts';
import { withRetry } from './retry.ts';
import { S3Store, type S3Config } from './s3.ts';
import { WebDavStore, type WebDavConfig } from './webdav.ts';

/** A network store and everything needed to reach it, credentials included. */
export type RemoteSpec = ({ type: 's3' } & S3Config) | ({ type: 'webdav' } & WebDavConfig);

/** Every network store retries transient failures. `http` defaults to `fetch`. */
export function openRemote(spec: RemoteSpec, http?: Http): RemoteStore {
  return withRetry(spec.type === 'webdav' ? new WebDavStore(spec, http) : new S3Store(spec, http));
}
