# @workspace/auth

Better Auth on Cloudflare D1: email and password, sessions, organizations,
OAuth grants, and the Drizzle schema they live in.

## Why D1 and not the Durable Object

Better Auth runs inside the request handler and awaits every query. D1 is
async and reachable from there. The Durable Object's `durable-sqlite` is
synchronous and only exists _inside_ the object, so the adapter cannot reach
it at all.

So the app has two stores, and the split is a real one rather than a
compromise:

|              | D1 (`env.DB`)                       | Durable Object (`APP_DATABASE`) |
| ------------ | ----------------------------------- | ------------------------------- |
| Reached from | the request handler                 | inside the object               |
| Shape        | async                               | sync                            |
| Holds        | users, organizations, subscriptions | counters, rate limits, leases   |
| Good at      | querying across rows                | one writer, no races            |

Anything you would write a `WHERE` against belongs in D1. Anything where two
concurrent requests must not both read the old value belongs in the object.

## Entry points

| Import                    | What it holds                                                   |
| ------------------------- | --------------------------------------------------------------- |
| `@workspace/auth`         | `createAuth`, `lazyAuth`, `resolveSecret`, organization helpers |
| `@workspace/auth/schema`  | Drizzle tables                                                  |
| `@workspace/auth/client`  | the browser client (`"use client"`)                             |
| `@workspace/auth/react/*` | `AuthForm`, `SignOutButton`                                     |

The browser client is a separate entry point on purpose: importing it from a
server module would drag `"use client"` code into the RSC graph.

## Setup

```sh
wrangler d1 create cloudwarden     # paste the id into wrangler.jsonc
pnpm db:generate                    # D1 + Durable Object migrations
pnpm --filter web db:migrate:local  # or db:migrate for remote

pnpm --filter web exec wrangler secret put BETTER_AUTH_SECRET
# openssl rand -base64 32
```

`resolveSecret` refuses to fall back to the bundled development secret
unless `APP_URL` explicitly names localhost, and throws instead. Missing
`APP_URL` is not evidence of local development. A shared default secret in
production means anyone who has read this repository can mint a session
cookie for any account.

## Building the instance

```ts
export const auth = lazyAuth(() =>
  createAuth({
    db: createAuthDb(env.DB),
    secret: resolveSecret(env.BETTER_AUTH_SECRET, env.APP_URL),
    baseURL: env.APP_URL,
    sendVerificationEmail,
    sendResetPassword,
    sendInvitationEmail,
  })
)
```

`lazyAuth` is not decoration. Better Auth starts plugin setup — including D1
queries — the moment it is constructed, and workerd forbids I/O outside a
request handler. Constructing it at module scope crashes the Worker on the
first request. The proxy defers construction to the first property access,
which is always inside a request.

## The schema

Column _property_ names must match what Better Auth expects — it addresses
fields by property, not by SQL column — so `emailVerified` stays camelCase
even though the column is `email_verified`. Renaming a property breaks
sign-in at runtime, not at compile time.

Tables include accounts, sessions, organizations, invitations, OAuth clients,
consents, tokens and signing keys, plus `agent_grant` and `audit_event`.
`oauth-schema.ts` is generated from the installed OAuth/JWT plugin schemas.

Adding a plugin means adding its tables. Better Auth validates the schema on
construction and names what is missing, e.g.:

```
Drizzle schema mismatch
  Missing tables
    rateLimit
```

Regenerate rather than guess:

```sh
node scripts/generate-auth-schema.mjs
pnpm db:generate
```

## Organizations

Billing keys on the organization, not the user — the account pays, and
someone who leaves should not take the subscription with them. `sign-up`
therefore verifies the email before landing on `/onboarding`, because an account with no organization
cannot subscribe.

**`activeOrganizationId` is not an authorization decision.** It is whatever
the session was last pointed at, and a user removed from an organization
keeps the stale value until their session refreshes. Every write re-checks
membership against the database:

```ts
await requireMembership(db, {
  organizationId,
  userId: session.user.id,
  role: "admin",
})
```

Roles are ranked (`member` < `admin` < `owner`), so `role: "admin"` means "at
least admin" rather than "exactly admin".

## Rate limiting

`storage: "database"` rather than the in-memory default, which is
per-isolate: an attacker spread across isolates would get a fresh budget from
each one. The counters live in `rate_limit`.

## Worth knowing

- **CSRF is on.** Better Auth rejects requests with no `Origin` header
  (`MISSING_OR_NULL_ORIGIN`). If you are testing with `curl`, send one.
- **Sign-in errors are deliberately vague.** A failed sign-in does not say
  whether the address exists; telling an attacker which emails have accounts
  is the whole of an enumeration attack.
- **Sign-in and sign-out do a full navigation**, not a router push. The
  session cookie has just changed and every server component needs to render
  again with it.
- **Cloudflare Email Service is wired in the app.** Verification expires in an
  hour; password reset expires in 30 minutes, is single-use and revokes browser
  sessions. Resend and reset endpoints are rate limited. See `packages/email`.
- **Session cookie caching is disabled.** Verification and revocation are read
  from D1 on every request.
- **Organization grants are immutable selections.** The consent route carries
  its selection in request-local AsyncLocalStorage, never a mutable active-org
  session field. Every MCP request rechecks consent and membership. See
  `packages/mcp/README.md`.
- **Relations.** Better Auth's Drizzle adapter can use relations for joins.
  This schema does not declare them, which matches what the plugins here
  need; if you add a plugin that joins, add the relations too.
