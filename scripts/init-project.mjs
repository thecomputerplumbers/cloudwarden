import { existsSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { randomBytes } from "node:crypto"
import { pathToFileURL } from "node:url"
import { root, readJson, editJson, validOrigin } from "./project-lib.mjs"
export function initialize(directory, options) {
  const {
    name,
    slug,
    origin,
    stagingOrigin,
    accountId,
    emailFrom,
    productionDbId = "REPLACE_WITH_YOUR_PRODUCTION_D1_DATABASE_ID",
    stagingDbId = "REPLACE_WITH_YOUR_STAGING_D1_DATABASE_ID",
  } = options
  if (!name?.trim() || name.length > 80 || !/^[a-z][a-z0-9-]{1,40}$/.test(slug))
    throw new Error(
      "Use a name and a lowercase project slug (2–41 letters, digits or hyphens)"
    )
  validOrigin(origin)
  validOrigin(stagingOrigin)
  if (origin === stagingOrigin)
    throw new Error("Staging and production need different origins")
  if (!/^[a-f0-9]{32}$/.test(accountId))
    throw new Error("Enter the 32-character Cloudflare account ID")
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFrom))
    throw new Error("Enter a sender email address")
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
  for (const id of [productionDbId, stagingDbId])
    if (!id.startsWith("REPLACE_WITH_") && !uuid.test(id))
      throw new Error("Invalid D1 database ID")
  if (productionDbId === stagingDbId)
    throw new Error("Staging and production must have separate databases")
  const configPath = resolve(directory, "apps/web/wrangler.jsonc"),
    config = readJson(configPath)
  const database = (suffix, id) => [
    {
      ...config.d1_databases[0],
      database_name: `${slug}${suffix}`,
      database_id: id,
    },
  ]
  const attachments = (suffix) => [
    {
      ...config.r2_buckets[0],
      bucket_name: `${slug}-attachments${suffix}`,
      preview_bucket_name: `${slug}-attachments${suffix}-preview`,
    },
  ]
  editJson(resolve(directory, "package.json"), [[["name"], slug]])
  editJson(resolve(directory, "apps/web/config/product.json"), [
    [["name"], name],
    [["slug"], slug],
    [["supportEmail"], emailFrom],
  ])
  editJson(configPath, [
    [["name"], slug],
    [["account_id"], accountId],
    [["vars"], { APP_URL: origin, EMAIL_FROM: emailFrom }],
    [["d1_databases"], database("", productionDbId)],
    [["r2_buckets"], attachments("")],
    [
      ["env", "staging"],
      {
        name: `${slug}-staging`,
        vars: { APP_URL: stagingOrigin, EMAIL_FROM: emailFrom },
        d1_databases: database("-staging", stagingDbId),
        r2_buckets: attachments("-staging"),
        durable_objects: config.durable_objects,
        send_email: config.send_email,
      },
    ],
  ])
  const local = resolve(directory, "apps/web/.dev.vars")
  if (!existsSync(local))
    writeFileSync(
      local,
      `APP_URL=http://localhost:3000\nEMAIL_FROM=cloudwarden@example.com\nBETTER_AUTH_SECRET=${randomBytes(32).toString("base64url")}\n`,
      { mode: 0o600 }
    )
  return [
    `pnpm --filter web exec wrangler d1 create ${slug}`,
    `pnpm --filter web exec wrangler d1 create ${slug}-staging`,
    `pnpm --filter web exec wrangler r2 bucket create ${slug}-attachments`,
    `pnpm --filter web exec wrangler r2 bucket create ${slug}-attachments-staging`,
    "Put each returned database_id in its matching wrangler.jsonc environment.",
    "Configure a verified Cloudflare Email Service sender for each environment.",
    "Set BETTER_AUTH_SECRET separately with wrangler secret put; add --env staging for staging.",
    "pnpm db:migrate:local && pnpm db:seed && pnpm doctor",
    "See docs/deployment.md for GitHub environments and deployment.",
  ]
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const cli = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const name = await cli.question("Product name: "),
      slug = await cli.question("Project slug (lowercase): "),
      origin = await cli.question("Production origin (https://…): "),
      stagingOrigin = await cli.question("Staging origin (https://…): "),
      accountId = await cli.question("Cloudflare account ID: "),
      emailFrom = await cli.question("Verified sender email: ")
    console.log(
      initialize(root, {
        name,
        slug,
        origin,
        stagingOrigin,
        accountId,
        emailFrom,
      }).join("\n")
    )
  } finally {
    cli.close()
  }
}
