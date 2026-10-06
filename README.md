# Cloudwarden

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/thecomputerplumbers/cloudwarden)

Cloudflare's deploy button does not fully support monorepos. Cloudwarden is
public but uses workspace packages and keeps its Wrangler configuration in
`apps/web`; follow the [deployment procedure](docs/deployment.md) for a working
deployment.

Cloudwarden is based on the vinext and Cloudflare Workers monorepo starter generated from the shadcn `b0` preset:

```sh
pnpm dlx shadcn@latest init --preset b0 --template next --monorepo --pointer
```

The workspace uses vinext, React, Tailwind CSS, shadcn/ui, Turborepo, and TypeScript. It is ready for Cloudflare Workers deployment with a SQLite-backed Durable Object and Drizzle `1.0.0-rc.5-5935859`. The toolchain is managed by mise and tracks Node 26.x and pnpm 12.x.

The Bitwarden-compatible server API is under development. Personal and shared
vault flows work in local Worker tests. Production builds install a pinned
Vaultwarden web vault release at `/`; it still needs end-to-end validation over
trusted HTTPS. See [API status](docs/bitwarden-api.md) for supported routes,
verification, and remaining work.

The starter's billing, MCP, sample Projects, and Better Auth pages remain in
the source but are not served by the Cloudwarden Worker. vinext builds the
Worker and serves its health route; the bundled Vaultwarden web vault serves
the client at `/`. Production does not require Stripe credentials.

## Get started

```sh
mise install
mise run setup
mise run check
pnpm test:worker
```

The Worker smoke test creates disposable local D1, Durable Object, and R2
state. For a hosted instance, review the [Cloudwarden launch proposal](docs/cloudwarden-launch.md)
and [deployment procedure](docs/deployment.md). Vault accounts are separate
from the starter's demo accounts.

The original starter setup and fixtures remain documented in
[new-project setup](docs/new-project.md) for reuse in another project.
Cloudwarden's proposed environment configuration is already recorded in
`apps/web/wrangler.jsonc`; its D1 IDs and remote resources are not provisioned.

## Commands

```sh
mise run dev    # Start the development server
mise run check  # oxlint, oxfmt --check, type checking, regression tests, and a production build
mise run format # Format the workspace with oxfmt
pnpm test:worker # Isolated local Bitwarden Worker smoke test
pnpm test:cli    # Optional native Bitwarden CLI check with a disposable account
pnpm project:init # Configure Cloudflare account and environments
pnpm run doctor  # Check local setup; also accepts staging or production
pnpm db:seed     # Repeatable local demo users, organizations and projects
pnpm db:reset --yes # Reset local state; stop the dev server first
pnpm cf:typegen # Regenerate Cloudflare binding and runtime types
```

## Packages

The UI is broken up so you reach for one piece at a time rather than one
package that holds everything.

| Package               | What it holds                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `@workspace/ui`       | Primitives — button, card, input, sidebar, dialog, table, field. Managed by the shadcn CLI. |
| `@workspace/ui-shell` | App chrome — shells, siderails, headers, footers, page headers, nav, ornaments.             |
| `@workspace/ui-data`  | Stat cards, data tables, timelines, status tones, empty states, `Intl` formatting.          |
| `@workspace/ui-forms` | Fields and server-action form plumbing around one `FormState` shape.                        |
| `@workspace/auth`     | Accounts, organizations, OAuth provider and organization grants.                            |
| `@workspace/mcp`      | Native Worker MCP transport; application tools call shared operations.                      |
| `@workspace/email`    | Cloudflare Email Service for verification, recovery and invitations.                        |
| `@workspace/stripe`   | Checkout, billing portal, verified webhooks, Drizzle tables, React controls.                |

Each has its own README. `/dashboard` and `/billing` are working pages built
from them. `/projects` is the complete database-backed feature to copy.

A new package needs three lines of wiring: `transpilePackages` in
`apps/web/next.config.ts`, `paths` in `apps/web/tsconfig.json`, and a
`workspace:*` dependency. Tailwind already scans `packages/*/src/**`.

## Databases

Two stores, and the split is deliberate:

|              | D1 (`env.DB`)                       | Durable Object (`APP_DATABASE`) |
| ------------ | ----------------------------------- | ------------------------------- |
| Reached from | the request handler                 | inside the object only          |
| Shape        | async                               | sync                            |
| Holds        | users, organizations, subscriptions | counters, rate limits, leases   |

Anything you would write a `WHERE` against goes in D1. Anything where two
concurrent requests must not both read the old value goes in the object.
Better Auth _cannot_ use the Durable Object: it awaits every query from the
request handler, and `durable-sqlite` is synchronous and unreachable there.

Each store has its own schema modules and its own Drizzle config:

```
apps/web/db/schema/        D1        auth.ts, billing.ts   → drizzle.config.ts
apps/web/worker/schema/    Durable   app.ts                → drizzle.do.config.ts
```

A package contributes tables by getting a one-line module:

```ts
// apps/web/db/schema/auth.ts
export * from "@workspace/auth/schema"
```

Each config lists its modules individually. Do not also point one at the
folder's `index.ts` — that barrel is for the runtime, and drizzle-kit reading
both would discover every table twice.

```sh
wrangler d1 create cloudwarden     # paste the id into wrangler.jsonc
pnpm db:generate                    # both configs
pnpm --filter web db:migrate:local  # or db:migrate for remote
```

Drizzle is deliberately pinned to the 1.x release candidate in both
`drizzle-orm` and `drizzle-kit`. It writes one folder per migration rather
than flat `.sql` files, which is why `wrangler.jsonc` sets
`migrations_pattern`.

## Auth

`@workspace/auth` is Better Auth with email/password, sessions and the
organization plugin.

```sh
pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET
# openssl rand -base64 32
```

Sign-up requires email verification, then sends the user to `/onboarding`.
`/account` manages profile, password and sessions; `/team` manages members and
invitations; `/connections` revokes agent access. `/settings` redirects to the
real account screen. Recovery and invitation links use Cloudflare Email Service.
Local Wrangler prints simulated email file paths; production needs a verified
sending domain and `EMAIL_FROM`. See [email setup](packages/email/README.md).

The instance is built lazily because workerd forbids I/O outside a request.
See [auth](packages/auth/README.md) for schema and authorization rules.

## MCP

`/mcp` is a first-class Worker endpoint with OAuth discovery, PKCE, organization
consent, scoped tools and immediate revocation. Browser routes and tools call
shared operations in `apps/web/operations`. Start with the authenticated reads
and audited, idempotent organization rename. See [MCP architecture and client
setup](packages/mcp/README.md).

## Billing

`@workspace/stripe` talks to Stripe with `fetch` and verifies webhooks with
`crypto.subtle` — no SDK, because workerd will not host its Node built-ins.

```sh
pnpm --filter web exec wrangler secret put STRIPE_SECRET_KEY
pnpm --filter web exec wrangler secret put STRIPE_WEBHOOK_SECRET
pnpm --filter web exec wrangler secret put STRIPE_PRICE_PRO_MONTHLY

stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Use separate deployments and D1 databases for test and live Stripe accounts;
there is no runtime mode switch.

Routes are in `apps/web/app/api/stripe/`. Access is granted from verified
webhook events, never from the Checkout redirect, and prices are resolved on
the server from a plan key — see `packages/stripe/README.md`.

Billing belongs to the organization, and only an owner or admin can change
it. Membership is re-checked against the database on every billing write —
`session.activeOrganizationId` goes stale when a member is removed, so it is
never an authorization decision on its own.

## Cloudflare deployment

The project enables `workers.dev`, preview URLs, source maps, and Worker observability. Before the first deployment, authenticate Wrangler and configure the Worker in `apps/web/wrangler.jsonc`:

```sh
pnpm --filter web exec wrangler login
pnpm --filter web db:migrate    # apply D1 migrations to the remote database
pnpm run deploy staging # or production, after configuring both environments
```

The first deployment creates the `AppDatabase` Durable Object class with SQLite storage through Wrangler's declarative `exports` configuration. D1 migrations are applied separately, with Wrangler, before the deploy — the Durable Object replays its own on construction.

Set `APP_URL` to the canonical HTTPS origin and `EMAIL_FROM` to a verified
Cloudflare Email Service sender. Set the secrets before the first real request:

```sh
pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET
```

Stripe secrets are needed only if billing is enabled in the product configuration.

`/api/health` reports what is bound, migrated and configured — without ever echoing a key.

## Add shadcn components

Run the shadcn CLI from the repository root and target the web app:

```sh
pnpm dlx shadcn@latest add button -c apps/web
```

Components are added to `packages/ui/src/components` and can be imported through the shared UI package:

```tsx
import { Button } from "@workspace/ui/components/button"
```

Run it against `packages/ui` directly when you are only adding primitives:

```sh
pnpm dlx shadcn@latest add dialog --cwd packages/ui
```

Composed components — anything that arranges primitives rather than wrapping a
Base UI part — belong in `ui-shell`, `ui-data` or `ui-forms` instead.
