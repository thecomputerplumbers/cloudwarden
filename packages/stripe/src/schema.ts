import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

/**
 * The billing tables.
 *
 * These mirror Stripe rather than replace it: Stripe stays the source of
 * truth for money, and these rows are a local read model so a page can answer
 * "is this account paid?" without a round trip to the API on every render.
 *
 * They key on the **organization**, not the user. Billing belongs to the
 * account that is paying, and a person who leaves an organization should not
 * take its subscription with them.
 *
 * They live in D1 beside the auth tables — same store, so a subscription can
 * be joined to the organization that owns it. Add them to your app's schema:
 *
 * ```ts
 * // apps/web/db/schema/billing.ts
 * export * from "@workspace/stripe/schema"
 * ```
 *
 * then `pnpm db:generate` and commit the migration.
 */

const timestamps = {
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
}

/**
 * One Stripe customer per organization. `organizationId` is unique on
 * purpose — a second customer for the same organization is how an account
 * ends up paying twice and seeing neither subscription.
 *
 * There is no foreign key to the organization table: this package does not
 * know what that table is called. Add one in your app's schema if you want
 * the cascade.
 */
export const stripeCustomer = sqliteTable(
  "stripe_customer",
  {
    /** The Stripe customer id, `cus_…`. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    email: text("email"),
    livemode: integer("livemode", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("stripe_customer_organization_idx").on(table.organizationId),
  ]
)

export const stripeSubscription = sqliteTable(
  "stripe_subscription",
  {
    /** Optimistic concurrency fence for reconciliation. */
    revision: integer("revision").notNull().default(0),
    /** The Stripe subscription id, `sub_…`. */
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    customerId: text("customer_id").notNull(),
    /** `active`, `trialing`, `past_due`, `canceled`, … */
    status: text("status").notNull(),
    priceId: text("price_id"),
    quantity: integer("quantity"),
    currentPeriodStart: integer("current_period_start", {
      mode: "timestamp_ms",
    }),
    currentPeriodEnd: integer("current_period_end", { mode: "timestamp_ms" }),
    cancelAtPeriodEnd: integer("cancel_at_period_end", { mode: "boolean" })
      .notNull()
      .default(false),
    canceledAt: integer("canceled_at", { mode: "timestamp_ms" }),
    trialEnd: integer("trial_end", { mode: "timestamp_ms" }),
    livemode: integer("livemode", { mode: "boolean" }).notNull().default(false),
    ...timestamps,
  },
  (table) => [
    index("stripe_subscription_organization_idx").on(table.organizationId),
    index("stripe_subscription_customer_idx").on(table.customerId),
    index("stripe_subscription_status_idx").on(table.status),
  ]
)

/**
 * Processed webhook ids.
 *
 * Stripe delivers at least once and retries anything that is not answered
 * with a 2xx, so the same event will arrive twice sooner or later. Recording
 * the id is what keeps a retry from granting the same thing again.
 */
export const stripeEvent = sqliteTable(
  "stripe_event",
  {
    /** The Stripe event id, `evt_…`. */
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    livemode: integer("livemode", { mode: "boolean" }).notNull().default(false),
    processedAt: integer("processed_at", { mode: "timestamp_ms" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [index("stripe_event_type_idx").on(table.type)]
)

export type StripeCustomerRow = typeof stripeCustomer.$inferSelect
export type StripeSubscriptionRow = typeof stripeSubscription.$inferSelect
export type StripeEventRow = typeof stripeEvent.$inferSelect
