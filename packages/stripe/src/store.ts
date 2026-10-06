import { and, desc, eq } from "drizzle-orm"
import type { DrizzleD1Database } from "drizzle-orm/d1"

import {
  stripeCustomer,
  stripeEvent,
  stripeSubscription,
  type StripeCustomerRow,
  type StripeSubscriptionRow,
} from "@workspace/stripe/schema"
import {
  normalizeSubscription,
  subscriptionIsEntitled,
  retrieveSubscription,
} from "@workspace/stripe/subscription"
import type { StripeClient } from "@workspace/stripe/client"
import type { StripeEvent } from "@workspace/stripe/types"

/**
 * Reads and writes for the billing tables, against D1.
 *
 * D1 is async and reachable from the request handler, which is what Better
 * Auth and these queries both need. Everything here is awaited.
 */

export type StripeDb = DrizzleD1Database

// ---------------------------------------------------------------------------
// Customers

export async function getCustomerByOrganization(
  db: StripeDb,
  organizationId: string,
  livemode: boolean
): Promise<StripeCustomerRow | null> {
  const [row] = await db
    .select()
    .from(stripeCustomer)
    .where(eq(stripeCustomer.organizationId, organizationId))
    .limit(1)
  if (row && row.livemode !== livemode) {
    throw new Error(
      "Billing database belongs to another Stripe environment; use a separate database"
    )
  }
  return row ?? null
}

export async function upsertCustomer(
  db: StripeDb,
  customer: {
    id: string
    organizationId: string
    email?: string | null
    livemode?: boolean
  }
) {
  const now = new Date()
  await db
    .insert(stripeCustomer)
    .values({
      id: customer.id,
      organizationId: customer.organizationId,
      email: customer.email ?? null,
      livemode: customer.livemode ?? false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: stripeCustomer.id,
      set: {
        organizationId: customer.organizationId,
        email: customer.email ?? null,
        updatedAt: now,
      },
    })
}

// ---------------------------------------------------------------------------
// Subscriptions

/**
 * Reconciles from Stripe's current state, never an event snapshot. The revision
 * check fences concurrent fetches: a losing writer must read and fetch again.
 * This keeps D1 work in the request handler without a network call in a transaction.
 */
export async function reconcileSubscription(
  db: StripeDb,
  stripe: StripeClient,
  subscriptionId: string,
  { organizationId: hinted }: { organizationId?: string } = {}
): Promise<StripeSubscriptionRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const [existing] = await db
      .select()
      .from(stripeSubscription)
      .where(eq(stripeSubscription.id, subscriptionId))
      .limit(1)
    const revision = existing?.revision ?? 0
    const subscription = await retrieveSubscription(stripe, subscriptionId)
    if (subscription.livemode !== stripe.config.livemode) {
      throw new Error("Subscription does not belong to this deployment")
    }
    const fields = normalizeSubscription(subscription)
    let organizationId =
      existing?.organizationId ??
      hinted ??
      subscription.metadata?.organization_id
    if (!organizationId) {
      const [customer] = await db
        .select()
        .from(stripeCustomer)
        .where(
          and(
            eq(stripeCustomer.id, fields.customerId),
            eq(stripeCustomer.livemode, stripe.config.livemode)
          )
        )
        .limit(1)
      organizationId = customer?.organizationId
    }
    if (!organizationId) return null

    const now = new Date()
    const values = {
      ...fields,
      organizationId,
      livemode: subscription.livemode,
      revision: revision + 1,
      updatedAt: now,
    }
    const [row] = await db
      .insert(stripeSubscription)
      .values({ ...values, createdAt: now })
      .onConflictDoUpdate({
        target: stripeSubscription.id,
        set: values,
        setWhere: eq(stripeSubscription.revision, revision),
      })
      .returning()
    if (row) return row
  }
  throw new Error("Subscription changed concurrently; retry reconciliation")
}

export async function getSubscriptionByOrganization(
  db: StripeDb,
  organizationId: string,
  livemode: boolean
): Promise<StripeSubscriptionRow | null> {
  const rows = await db
    .select()
    .from(stripeSubscription)
    .where(
      and(
        eq(stripeSubscription.organizationId, organizationId),
        eq(stripeSubscription.livemode, livemode)
      )
    )
    .orderBy(desc(stripeSubscription.createdAt), desc(stripeSubscription.id))
  return rows.find((row) => subscriptionIsEntitled(row)) ?? rows[0] ?? null
}

/** Any current subscription can grant access; historical rows cannot hide it. */
export async function organizationIsEntitled(
  db: StripeDb,
  organizationId: string,
  {
    livemode,
    priceId,
    now,
  }: { livemode: boolean; priceId?: string; now?: Date }
) {
  const rows = await db
    .select()
    .from(stripeSubscription)
    .where(
      and(
        eq(stripeSubscription.organizationId, organizationId),
        eq(stripeSubscription.livemode, livemode),
        priceId ? eq(stripeSubscription.priceId, priceId) : undefined
      )
    )
  return rows.some((row) => subscriptionIsEntitled(row, { now }))
}

// ---------------------------------------------------------------------------
// Webhook idempotency

/** Record completion only after all idempotent handler work succeeds. */
export async function recordStripeEvent(
  db: StripeDb,
  event: Pick<StripeEvent, "id" | "type" | "livemode">
): Promise<void> {
  await db
    .insert(stripeEvent)
    .values({
      id: event.id,
      type: event.type,
      livemode: event.livemode,
      processedAt: new Date(),
    })
    .onConflictDoNothing()
}

/** Whether an event id has already been recorded. */
export async function stripeEventSeen(db: StripeDb, eventId: string) {
  const [row] = await db
    .select({ id: stripeEvent.id })
    .from(stripeEvent)
    .where(eq(stripeEvent.id, eventId))
    .limit(1)
  return Boolean(row)
}
