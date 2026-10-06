# This app runs on vinext and Cloudflare Workers

Vinext implements the Next.js 16 API surface on Vite. Before changing runtime, routing, or build behavior, inspect the installed `vinext` documentation and source instead of assuming standard Next.js behavior. Server code runs in workerd and may use bindings from `cloudflare:workers`.

## Two databases, on purpose

|              | D1 (`env.DB`)                       | Durable Object (`APP_DATABASE`) |
| ------------ | ----------------------------------- | ------------------------------- |
| Reached from | the request handler                 | inside the object only          |
| Shape        | async                               | sync                            |
| Holds        | users, organizations, subscriptions | counters, rate limits, leases   |

Anything you would write a `WHERE` against belongs in D1. Anything where two concurrent requests must not both read the old value belongs in the object. Better Auth _cannot_ use the Durable Object — it awaits every query from the request handler, and `durable-sqlite` is synchronous and unreachable from there.

Drizzle 1.x RC drives both, with one config each:

- `apps/web/drizzle.config.ts` → D1 modules in `db/schema/`, out to `migrations/`, applied with `wrangler d1 migrations apply`.
- `apps/web/drizzle.do.config.ts` → Durable Object modules in `worker/schema/`, out to `drizzle/`, replayed by `AppDatabase` on construction.

Each config lists its schema modules individually. Do not point one at the folder's `index.ts` as well — that barrel exists for the runtime, and drizzle-kit reading both would discover every table twice. `wrangler.jsonc` sets `migrations_pattern` because drizzle-kit writes a folder per migration rather than flat `.sql` files.

After changing a schema module run `pnpm db:generate` (both configs) and commit the generated migration. Never hand-edit an existing migration that may have been deployed.

## Packages

Put a component in the narrowest package that fits:

- `@workspace/ui` — primitives, managed by the shadcn CLI (`pnpm dlx shadcn@latest add <name> --cwd packages/ui`). Do not hand-write components here that the registry already ships.
- `@workspace/ui-shell` — app chrome: shells, siderails, headers, footers, page furniture. Imports nothing from a router; anything link-shaped takes Base UI's `render` prop.
- `@workspace/ui-data` — stat cards, tables, timelines, status, empty states, `Intl` formatting.
- `@workspace/ui-forms` — fields and server-action form plumbing around one `FormState` shape.
- `@workspace/auth` — Better Auth on D1. See its README before touching it.
- `@workspace/mcp` — transport only; app tools delegate to `apps/web/operations`.
- `@workspace/email` — native Cloudflare Email Service; local sends stay simulated.
- `@workspace/stripe` — billing. See its README before touching it.

New packages need their `src` added to `transpilePackages` in `apps/web/next.config.ts` and to `paths` in `apps/web/tsconfig.json`. Tailwind already scans `packages/*/src/**` via `@source` in `packages/ui/src/styles/globals.css`.

## Auth

Never construct Better Auth at module scope — it starts plugin setup, including D1 queries, on construction, and workerd forbids I/O outside a request handler. Use `lazyAuth`.

`session.activeOrganizationId` is not an authorization decision. It is whatever the session was last pointed at and goes stale when a member is removed. Re-check membership against the database with `requireMembership` on every write.

Adding a Better Auth plugin means adding its tables. Better Auth validates the schema on construction and names what is missing.

## Stripe

There is no `stripe` SDK — the API is reached with `fetch` and webhooks are verified with `crypto.subtle`, because workerd will not host the SDK's Node built-ins. Keep it that way.

Entitlements are granted from verified webhook events only, never from a Checkout redirect. Prices are resolved on the server from a plan key; a route must never accept a price id or an amount from the browser. Billing keys on the organization, not the user.

## Vite

`optimizeDeps.exclude` in `apps/web/vite.config.ts` lists `@base-ui/react` and `lucide-react`. Both ship `"use client"` files, and pre-bundling drops the directive, which makes the RSC environment evaluate them as server modules and throw on `createContext`. Add any other dependency that ships client components to that list.

## Checks

`mise run check` runs oxlint, `oxfmt --check`, `turbo typecheck`, regression tests and a production build. All must pass.

## MCP and account lifecycle

MCP and browser mutations share app operations. Enforce scopes and current membership there. OAuth grants bind to the organization selected at consent; never derive an agent organization from the mutable browser session. Recheck grant and consent on every request so revocation invalidates existing JWTs.

After auth, OAuth, mail or tool changes, run `pnpm test:worker` in addition to `mise run check`. This uses fresh local state and Cloudflare simulated mail. Never enable remote email bindings in tests.

## Product setup and feature examples

Public product settings live in `apps/web/config/product.json`; secrets never belong there. Feature flags gate routes/tools as well as navigation. New organization-owned resources should follow `apps/web/operations/projects.ts`: scoped queries, current membership checks, bounded pagination, and optimistic concurrency. Use AppError for expected failures and the diagnostics allowlist for logs; never serialize credentials, raw requests, or unknown errors.

Run project initialization only in a new project copy. `db:seed` and `db:reset` are local-only; never add a remote option. Deployment builds the selected environment, verifies the artifact identity, applies migrations and then uploads, followed by a commit-marker health check. Keep migrations compatible with the previously deployed Worker.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
