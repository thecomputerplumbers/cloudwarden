# Storage snapshots and recovery

Cloudwarden stores account and organization metadata in D1, encrypted vault
records in per-account SQLite Durable Objects, and encrypted attachment and
file Send bytes in private R2. These stores need a coordinated recovery point.

## R2 snapshot

Install the AWS CLI and use a read-only R2 access key scoped to the selected
attachment bucket. Provide `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from
the operator's secret manager; do not commit them. To stop new Worker requests
and scheduled jobs, set the `MAINTENANCE_MODE` Worker secret to `true` for the
selected environment. For staging:

```sh
printf true | pnpm --filter web exec wrangler secret put MAINTENANCE_MODE --env staging
```

Omit `--env staging` for production. Wrangler deploys a new Worker version
immediately when a secret is added or removed, so treat these as live release
operations. Confirm that `/api/config` returns HTTP 503, and allow in-flight
requests to drain. Then run:

```sh
pnpm r2:snapshot staging /secure/offsite/cloudwarden-staging-2026-10-06
pnpm r2:snapshot verify /secure/offsite/cloudwarden-staging-2026-10-06
```

Use `production` to snapshot production. The command lists every application
R2 key, downloads each object, lists again, and refuses to publish the snapshot
if the listing changed. Its manifest records object keys, sizes, SHA-256 hashes,
source bucket, and capture time. The snapshot directory is private to the
operator. Keep a copy outside the Cloudflare account and test it regularly.
An R2 snapshot is not atomic with D1 or Durable Object writes. It also cannot
guarantee that an object did not change twice between the listings. Pause writes
with maintenance mode before treating it as a coordinated recovery point. Keep
the vault in maintenance mode throughout a restore drill. After a snapshot or
restore, remove the secret and verify a normal request succeeds again:

```sh
pnpm --filter web exec wrangler secret delete MAINTENANCE_MODE --env staging
```

## Restore drill

1. Record the recovery timestamp and verify the R2 snapshot manifest. Do not
   overwrite a live bucket while clients are writing. Use a fresh staging
   environment or a maintenance window.
2. Retrieve the D1 bookmark for that timestamp with
   `wrangler d1 time-travel info DB --timestamp=... --env staging` and review
   the rows it would restore. D1 Time Travel restoration overwrites the
   database in place, so obtain approval for that specific restore.
3. Restore each affected account or organization Durable Object to a matching
   point using its SQLite point-in-time bookmark. **The project does not yet
   expose an operator path for this step**, so a full coordinated restore drill
   remains open. Local Durable Objects cannot exercise Cloudflare's PITR log.
4. Copy the verified snapshot objects into the target R2 bucket using a scoped
   operator credential, then compare object count, keys, and sizes with the
   manifest. Test a Bitwarden client login, encrypted item sync, and attachment
   download against the recovered staging deployment.

R2 object deletion has no built-in rollback through D1 or Durable Object PITR.
The snapshot includes file Sends and may preserve data after a user deletes it;
set a retention period and access controls appropriate to the vault's deletion
policy. A snapshot without a tested offsite copy and restore is not a proven
backup.

References: [Cloudflare R2 AWS CLI](https://developers.cloudflare.com/r2/examples/aws/aws-cli/),
[D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[SQLite Durable Object PITR](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).
