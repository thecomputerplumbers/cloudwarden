# Start a project

Use this repository as a GitHub template or copy it into a new repository.
Install the toolchain and dependencies, then run the initializer **in the copy**:

```sh
mise install
mise run setup
pnpm project:init
mise run format
pnpm cf:typegen
pnpm db:seed
pnpm doctor
mise run dev
```

The initializer asks for the product name, slug, production and staging origins,
Cloudflare account ID and verified email sender. It updates only package identity,
public product configuration and Wrangler configuration. It generates a unique
local auth secret if `.dev.vars` does not exist, and preserves an existing file.
It prints the commands to create the two D1 databases; it never provisions or
deploys resources automatically. Paste the returned IDs into the matching config.

Review `apps/web/config/product.json`: name, description, support address,
navigation and plan presentation. Stripe price IDs stay in server secrets.
Update `apps/web/app/favicon.ico` and the shared theme in
`packages/ui/src/styles/globals.css` for the product's visual identity.

## Local data

`pnpm db:seed` applies local migrations and adds two organizations, six users
(owner/admin/member in each), and 25 projects per organization. It is repeatable:
existing rows and edits are preserved. It creates no subscriptions or entitlements
and sends no mail. No fixture endpoint is deployed.

Sign in as `owner@example.test`, `admin@example.test` or `member@example.test`.
Use `owner2@example.test` (and similarly for the other roles) for the second team.
The **local-only** password is `Local-demo-only-2026!`.

Stop the dev server before `pnpm db:reset --yes`. This removes only
`apps/web/.wrangler/state`, including local D1 and Durable Objects, then reapplies
migrations. It cannot target a remote database and rejects extra flags. Run the
seed command again to restore fixtures. Isolated smoke-test state is separate.

`pnpm doctor` checks local bindings, configuration and migrated tables.
`pnpm doctor staging` or `pnpm doctor production` checks the target configuration
and remote secret names, without printing values. Email-domain verification is
still checked in the Cloudflare dashboard.

## Removing capabilities

Set `features.billing`, `features.mcp` or `features.projects` to false in product
configuration to disable their routes/tools and hide their navigation. Rebuild
and deploy after changing a flag. These are product-level choices, not customer
entitlements. Disabling a capability preserves existing data.

For permanent removal, delete its app routes, operation/tool registration and
workspace dependency, then remove its TypeScript paths and transpilePackages
entry if unused. For Projects, its schema module is also listed in
`drizzle.config.ts`. Generate a new migration if intentionally dropping tables;
never remove historical migrations. MCP OAuth plugins/tables are owned by auth;
remove them together and regenerate the plugin schema before db:generate.
Update the corresponding smoke tests when removing a capability. They deliberately
exercise all enabled-by-default features of this starter.
