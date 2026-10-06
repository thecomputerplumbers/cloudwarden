# Checks and deployment

`.github/workflows/check.yml` runs on main pushes and pull requests: lint,
formatting, typecheck, regression tests, production build and an isolated Worker
smoke test. Tests need no Cloudflare account credentials and send no real email.
Configure the `check` job as a required branch check in each new repository.

## Configure each environment

Run `pnpm project:init` first. Production uses the root Wrangler configuration;
staging uses `env.staging`. They must have different Worker names, D1 database
IDs and canonical origins. Durable Object and email bindings are declared again
for staging because bindings are not inherited. The same object class belongs
to a different Worker namespace in each deployment.

1. Run the printed D1 creation commands and save each returned ID in its own
   environment. Keep database names unique to the new project.
2. Configure the matching custom domain for each Worker, or set APP_URL to its
   actual workers.dev origin. The post-deploy check uses this URL.
3. Verify a sending domain in Cloudflare Email Service and set EMAIL_FROM.
4. Set BETTER_AUTH_SECRET separately for each Worker. If billing is enabled,
   set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and the plan price secrets too.
   Use test Stripe credentials for staging, live credentials for production.

```sh
pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET --env staging
pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET
pnpm run doctor staging
pnpm run doctor production
```

Create GitHub environments named `staging` and `production`. Each needs a
`CLOUDFLARE_API_TOKEN` secret and `CLOUDFLARE_ACCOUNT_ID` variable. Scope the token
to the intended account and required Worker/D1 operations. Application secrets
belong in the Worker, not in committed files. Configure a production environment
approval rule if the project requires release approval.

## Release

The Deploy workflow is manually dispatched from main and selects exactly one
environment. It runs the isolated smoke tests first. You can run the same release
command locally from a clean, committed checkout:

```sh
pnpm deploy staging
pnpm deploy production
```

The command validates target configuration/secret inventory, code checks, and
the isolated Wrangler Worker smoke test. It builds with the selected
CLOUDFLARE_ENV and verifies the generated artifact's Worker and D1 identities.
It then applies D1 migrations, deploys that exact built artifact, and checks
the canonical HTTPS health endpoint for the expected commit marker and
configured dependencies. It also checks the Bitwarden config route and bundled
web vault page. No production deploy occurs on a plain push.

Use backward-compatible migrations: the old Worker can still serve requests
between migration and deployment. Split destructive schema changes across
releases. Rollback the Worker separately; applied D1 migrations do not roll back
with code. A failed post-deploy health check means the upload may have succeeded:
inspect the deployment before retrying. Keep tested recovery procedures for each
product's data before destructive migrations.

The template's real domains, sending service and credentials are deliberately
unconfigured. This repository's local checks do not certify an actual deployment.

References: [Wrangler environments](https://developers.cloudflare.com/workers/wrangler/environments/)
and [GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/).
