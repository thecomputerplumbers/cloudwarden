# Cloudwarden launch proposal

This file tracks the configured targets and the remaining release work. Staging
exists in Cloudflare; the production Cloudwarden resources are not provisioned.

| Setting      | Production                              | Staging                                               |
| ------------ | --------------------------------------- | ----------------------------------------------------- |
| Worker       | `cloudwarden`                           | `cloudwarden-staging`                                 |
| Origin       | `https://vault.thecomputerplumbers.com` | `https://cloudwarden-staging.thecomputerplumbers.com` |
| D1 database  | `cloudwarden`                           | `cloudwarden-staging`                                 |
| R2 bucket    | `cloudwarden-attachments`               | `cloudwarden-attachments-staging`                     |
| Email sender | `cloudwarden@thecomputerplumbers.com`   | Same sender                                           |

The GitHub repository is `thecomputerplumbers/cloudwarden`, public.
The Wrangler configuration targets Cloudflare account
`865d0c927a18e87c0a0701b8d1f18ee9`. The production D1 ID remains a
placeholder. The first owner email address is still undecided; it is needed
only for owner signup.

`vault.thecomputerplumbers.com` currently serves the separate, active
Vaultwarden Container with an organization and R2 checkpoints. Do not attach
Cloudwarden to that hostname until the existing vault data has a verified
migration or the owner explicitly chooses to discard it. Cloudwarden's mobile
and desktop client coverage is also incomplete.

On 2026-10-06, `cloudwarden-staging` was deployed with its own D1 database,
R2 bucket, Durable Object, and Worker secret. Public DNS resolved its custom
domain, and HTTPS `/api/health`, `/api/config`, and `/` passed via a public
resolver. The local network's DNS cache still returned NXDOMAIN immediately
after the deploy, so the release script's final origin check failed. Hosted
browser and native-client flows remain to be tested.

## Before a hosted release

1. Confirm the production cutover and existing data migration plan. Confirm the
   owner email and test real delivery from the configured sender. Create the
   production D1 database and R2 bucket, then replace its D1 placeholder.
2. Set a distinct production `BETTER_AUTH_SECRET` and scoped deployment
   credentials. Configure the required GitHub check.
3. Deploy staging on a trusted HTTPS origin. Verify the health endpoint and
   Bitwarden configuration route. In the bundled web vault, create a disposable
   account and test encrypted item creation and reading, organization creation,
   a collection and member, TOTP and WebAuthn enrollment, signup email verification
   and an authenticated master password change, an attachment and file Send.
   Test lost-password account deletion separately; encrypted vault data cannot be
   reset or recovered through email. Test a native client login
   and vault sync. Promote the same commit to production only after the staging
   checks pass. The web vault rejected local HTTP signup with "Insecure URL not
   allowed". A disposable account was created through isolated Chrome on
   local HTTPS with a self-signed certificate; the listed full browser flows
   remain unverified on trusted staging HTTPS.
4. Prove recovery before relying on the service for real vault data. D1 Time
   Travel and SQLite Durable Object point-in-time recovery cover their
   respective stores. Run the [R2 snapshot procedure](recovery.md) on a quiet
   vault and store the result outside the Cloudflare account. Exercise restore
   on staging, including an attachment and encrypted vault record, and document
   the recovery point and operator steps.

## Staging bootstrap

The first staging release created its D1 database and R2 bucket, inserted the
returned D1 ID in `apps/web/wrangler.jsonc`, then set `BETTER_AUTH_SECRET` with
`wrangler secret put BETTER_AUTH_SECRET --env staging`. [Wrangler creates the
Worker](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put)
when setting its first secret; that operation deployed a placeholder version.
`pnpm run doctor staging` then passed, and `pnpm run deploy staging` migrated
and uploaded the Worker. Its final health check failed only because this Mac's
resolver still cached NXDOMAIN for the new hostname. Real mail delivery from
the configured sender has not been tested.

References: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Durable Object SQLite recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 bucket deletion](https://developers.cloudflare.com/r2/buckets/delete-buckets/).
