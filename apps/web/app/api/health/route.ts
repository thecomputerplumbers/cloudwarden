import product from "@/config/product.json"
import { env } from "cloudflare:workers"
import { sql } from "drizzle-orm"
import { stripeConfigComplete } from "@workspace/stripe"

import { getDb } from "@/db"
import { stripeConfig } from "@/lib/stripe"

export async function GET() {
  const durableObject = await env.APP_DATABASE.getByName("default").health()

  // Check the vault tables needed for registration and transfer recovery.
  let d1: { ok: boolean; users?: number; error?: string }
  try {
    const [row] = await getDb()
      .select({ users: sql<number>`count(*)`.as("users") })
      .from(sql`"vault_user"`)
    await getDb().run(
      sql`select cipher_id, prepared, lease_until from vault_cipher_transfer limit 0`
    )
    if (product.features.projects)
      await getDb().run(sql`select id, version from project limit 0`)
    d1 = { ok: true, users: Number(row?.users ?? 0) }
  } catch {
    d1 = {
      ok: false,
      error: "Database unavailable or migrations missing",
    }
  }

  // Reports whether billing is wired up without ever echoing a key — a
  // missing price should surface here, not at a customer's checkout.
  const stripe = stripeConfig()
  const billing = {
    livemode: stripe.livemode,
    configured: stripeConfigComplete(stripe),
    missingPrices: Object.entries(stripe.prices)
      .filter(([, price]) => !price)
      .map(([plan]) => plan),
  }

  const auth = {
    // Never the value — only whether it is set. Without it, sessions fall
    // back to a shared development secret, which is fine on localhost and a
    // vulnerability anywhere else.
    secretConfigured: Boolean(env.BETTER_AUTH_SECRET),
    appUrl: env.APP_URL ?? null,
    emailBound: Boolean(env.EMAIL),
    emailFromConfigured: Boolean(env.EMAIL_FROM),
  }

  const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(
    env.APP_URL ?? ""
  )
  const ok =
    d1.ok &&
    durableObject.ok &&
    (local ||
      (auth.secretConfigured &&
        auth.emailBound &&
        auth.emailFromConfigured &&
        (!product.features.billing || billing.configured)))

  return Response.json(
    { ok, buildId: env.BUILD_ID ?? "local", d1, durableObject, auth, billing },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  )
}
