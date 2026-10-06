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
3. Deploy staging. Verify the health endpoint, Bitwarden configuration route,
   web vault, email verification and password reset, and a native client login
   and vault sync. Promote the same commit to production only after the staging
   checks pass.
4. Prove recovery before relying on the service for real vault data. D1 Time
   Travel and SQLite Durable Object point-in-time recovery cover their
   respective stores. R2 objects need a separate backup or retention process:
   deleting an R2 object cannot be undone through D1 or Durable Object recovery.
   Exercise restore on staging, including an attachment and encrypted vault
   record, and document the recovery point and operator steps.

References: [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/),
[Durable Object SQLite recovery](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/),
[R2 bucket deletion](https://developers.cloudflare.com/r2/buckets/delete-buckets/).
