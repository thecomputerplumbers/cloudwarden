import assert from "node:assert/strict"
import { test } from "node:test"
import { database } from "./database.mjs"
import { getStripeConfig } from "../packages/stripe/src/config.ts"
import { handleStripeWebhook } from "../packages/stripe/src/webhook.ts"
import {
  getCustomerByOrganization,
  upsertCustomer,
  getSubscriptionByOrganization,
  organizationIsEntitled,
  reconcileSubscription,
  recordStripeEvent,
  stripeEventSeen,
} from "../packages/stripe/src/store.ts"
import {
  getMembership,
  requireMembership,
} from "../packages/auth/src/organization.ts"

const env = {
  STRIPE_SECRET_KEY: "sk_test_local",
  STRIPE_WEBHOOK_SECRET: "whsec_local",
}
const config = getStripeConfig(env)
function subscription(id, status = "active", livemode = false) {
  return {
    id,
    object: "subscription",
    status,
    livemode,
    customer: "cus_1",
    metadata: { organization_id: "org_1" },
    items: {
      data: [{ price: { id: "price_1" }, current_period_end: 4102444800 }],
    },
  }
}
function client(get) {
  return { config, get }
}
async function request(id = "evt_1", livemode = false) {
  const payload = JSON.stringify({
    id,
    type: "customer.subscription.updated",
    livemode,
    data: { object: { id: "sub_1", status: "stale" } },
  })
  const t = Math.floor(Date.now() / 1000)
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const sig = Buffer.from(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${t}.${payload}`)
    )
  ).toString("hex")
  return new Request("https://app.example/webhook", {
    method: "POST",
    body: payload,
    headers: { "stripe-signature": `t=${t},v1=${sig}` },
  })
}

test("failed delivery retries, successful delivery deduplicates, stale snapshots are ignored", async (t) => {
  const { db } = database(t)
  let attempts = 0
  const stripe = client(async () => {
    if (++attempts === 1) throw new Error("temporary outage")
    return subscription("sub_1", "canceled")
  })
  const options = {
    seen: (event) => stripeEventSeen(db, event.id),
    record: (event) => recordStripeEvent(db, event),
    handlers: {
      "customer.subscription.updated": (event) =>
        reconcileSubscription(db, stripe, event.data.object.id),
    },
  }
  assert.equal(
    (await handleStripeWebhook(await request(), env, options)).status,
    500
  )
  assert.equal(await stripeEventSeen(db, "evt_1"), false)
  assert.equal(
    (await handleStripeWebhook(await request(), env, options)).status,
    200
  )
  assert.equal(await stripeEventSeen(db, "evt_1"), true)
  const duplicate = await handleStripeWebhook(await request(), env, options)
  assert.equal((await duplicate.json()).ignored, "duplicate")
  assert.equal(attempts, 2)
  assert.equal(
    (await getSubscriptionByOrganization(db, "org_1", false)).status,
    "canceled"
  )
})

test("failure to record completion remains retryable", async () => {
  let recorded = false,
    attempts = 0
  const options = {
    seen: () => recorded,
    record: () => {
      if (attempts === 1) throw new Error("database outage")
      recorded = true
    },
    handlers: {
      "customer.subscription.updated": () => {
        attempts++
      },
    },
  }
  assert.equal(
    (await handleStripeWebhook(await request(), env, options)).status,
    500
  )
  assert.equal(
    (await handleStripeWebhook(await request(), env, options)).status,
    200
  )
  assert.equal(attempts, 2)
})

test("a stale concurrent writer must refetch after losing the revision check", async (t) => {
  const { db } = database(t)
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let fetches = 0
  const slow = client(async () => {
    if (++fetches === 1) {
      started.resolve()
      await release.promise
      return subscription("sub_1")
    }
    return subscription("sub_1", "canceled")
  })
  const pending = reconcileSubscription(db, slow, "sub_1")
  await started.promise
  await reconcileSubscription(
    db,
    client(async () => subscription("sub_1", "canceled")),
    "sub_1"
  )
  release.resolve()
  await pending
  assert.equal(fetches, 2)
  assert.equal(
    (await getSubscriptionByOrganization(db, "org_1", false)).status,
    "canceled"
  )
})

test("historical canceled subscriptions do not hide paid access", async (t) => {
  const { db } = database(t)
  await reconcileSubscription(
    db,
    client(async () => subscription("sub_old", "canceled")),
    "sub_old"
  )
  await reconcileSubscription(
    db,
    client(async () => subscription("sub_new")),
    "sub_new"
  )
  assert.equal(
    await organizationIsEntitled(db, "org_1", { livemode: false }),
    true
  )
  assert.equal(
    (await getSubscriptionByOrganization(db, "org_1", false)).id,
    "sub_new"
  )
  assert.equal(
    await organizationIsEntitled(db, "org_1", { livemode: true }),
    false
  )
  assert.equal(
    await organizationIsEntitled(db, "org_1", {
      livemode: false,
      priceId: "other",
    }),
    false
  )
})

test("one deployment credential; opposite-environment webhooks and customers are rejected", async (t) => {
  const { db } = database(t)
  const old = getStripeConfig({
    STRIPE_MODE: "live",
    STRIPE_LIVE_SECRET_KEY: "sk_live_old",
    STRIPE_TEST_SECRET_KEY: "sk_test_old",
  })
  assert.equal(old.secretKey, undefined)
  let ran = false
  const result = await handleStripeWebhook(
    await request("evt_wrong", true),
    env,
    {
      handlers: {
        "customer.subscription.updated": () => {
          ran = true
        },
      },
    }
  )
  assert.equal(result.status, 400)
  assert.equal(ran, false)
  await upsertCustomer(db, {
    id: "cus_1",
    organizationId: "org_1",
    livemode: false,
  })
  await assert.rejects(
    getCustomerByOrganization(db, "org_1", true),
    /separate database/
  )
  await assert.rejects(
    reconcileSubscription(
      db,
      client(async () => subscription("sub_live", "active", true)),
      "sub_live"
    )
  )
})

test("membership revocation invalidates authorization independently of a stale session", async (t) => {
  const { db, sqlite } = database(t)
  sqlite.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u1','User','u@example.org',0,0,0);
    INSERT INTO organization (id,name,slug,created_at) VALUES ('org_1','Org','org',0);
    INSERT INTO member (id,organization_id,user_id,role,created_at) VALUES ('m1','org_1','u1','admin',0);`)
  const staleSession = { organizationId: "org_1", userId: "u1" }
  await requireMembership(db, staleSession)
  sqlite.exec("DELETE FROM member WHERE id='m1'")
  assert.equal(await getMembership(db, staleSession), null)
  await assert.rejects(requireMembership(db, staleSession), /Not a member/)
})
