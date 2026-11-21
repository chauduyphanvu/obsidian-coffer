Coffer works with any S3-compatible bucket and with WebDAV servers. It needs no CORS configuration. Use a key that can reach only one bucket. A read-only device can use a read-only key.

| Provider | Setup details |
| --- | --- |
| Cloudflare R2 | Account ID, bucket, and an R2 API token with read and write access to that bucket |
| Backblaze B2 | Bucket endpoint (for example, `s3.us-west-004.backblazeb2.com`), bucket, and a key limited to that bucket |
| Amazon S3 | Bucket region, bucket, and an access key |
| Other S3-compatible (MinIO, Wasabi, and others) | Endpoint, region if necessary, bucket, keys, and the path-style setting (necessary for MinIO and most self-hosted servers) |
| WebDAV (Nextcloud or a NAS) | Folder address, user name, and password. Use an app password for Nextcloud. Coffer makes the folder if it is not there |

With **Folder in bucket**, one bucket can hold more than one vault.

## At setup

Coffer tests your storage before it saves anything. One of the tests checks that the storage refuses to overwrite an object that already exists. Coffer needs that to keep two devices from writing over each other.

## Amazon S3 key

This IAM policy is enough (replace `my-notes` with your bucket):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::my-notes" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::my-notes/*" }
  ]
}
```

Turn on bucket versioning with a 30-day rule as a second backup.

Next: [[Get started]].
