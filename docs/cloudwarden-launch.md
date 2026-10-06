# Cloudwarden launch proposal

This file records the locally prepared settings. None of these names imply that
the matching Cloudflare resources, domain routes, GitHub repository, or mail
sender have been created or verified.

| Setting      | Production                                    | Staging                                               |
| ------------ | --------------------------------------------- | ----------------------------------------------------- |
| Worker       | `cloudwarden`                                 | `cloudwarden-staging`                                 |
| Origin       | `https://cloudwarden.thecomputerplumbers.com` | `https://cloudwarden-staging.thecomputerplumbers.com` |
| D1 database  | `cloudwarden`                                 | `cloudwarden-staging`                                 |
| R2 bucket    | `cloudwarden-attachments`                     | `cloudwarden-attachments-staging`                     |
| Email sender | `cloudwarden@thecomputerplumbers.com`         | Same sender                                           |

The proposed GitHub repository is `thecomputerplumbers/cloudwarden`, private.
The Wrangler configuration targets Cloudflare account
`865d0c927a18e87c0a0701b8d1f18ee9`. D1 IDs remain placeholders. The first
owner email address is still undecided; it is needed only for owner signup.

## Before a hosted release

1. Confirm the origins, sender, repository visibility, and owner email. Check
   that the sender is permitted by Cloudflare Email Sending. Create the GitHub
   repository, D1 databases, and R2 buckets, then replace the D1 placeholders.
2. Set distinct `BETTER_AUTH_SECRET` Worker secrets and scoped deployment
   credentials for staging and production. Configure the required GitHub check.
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

## First staging bootstrap

For a first staging release, create its D1 database and R2 bucket, insert the
returned D1 ID in `apps/web/wrangler.jsonc`, then set `BETTER_AUTH_SECRET` with
`wrangler secret put BETTER_AUTH_SECRET --env staging`. [Wrangler creates the
Worker](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-put)
when setting its first secret; that operation deploys a placeholder version.
Then `pnpm doctor staging` can inspect the secret inventory and
`pnpm deploy staging` can migrate and deploy the built application. A local
preflight on 2026-10-06 found the GitHub repository, D1 ID, staging Worker, and
Worker secret absent; it did not mutate remote state.

References: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Durable Object SQLite recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 bucket deletion](https://developers.cloudflare.com/r2/buckets/delete-buckets/).
