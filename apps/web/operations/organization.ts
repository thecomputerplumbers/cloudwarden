import { AppError } from "@/lib/errors"
import { and, eq, sql } from "drizzle-orm"
import {
  organization,
  user,
  auditEvent,
  member,
  agentGrant,
} from "@workspace/auth/schema"
import {
  getSubscriptionByOrganization,
  organizationIsEntitled,
} from "@workspace/stripe/store"
import { authorize, type OperationContext } from "./context"

export async function currentUser(context: OperationContext) {
  await authorize(context, "organization:read")
  const [account] = await context.db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, context.actor.userId))
    .limit(1)
  return {
    user: account
      ? {
          id: account.id,
          ...(!context.actor.scopes || context.actor.scopes.includes("profile")
            ? { name: account.name }
            : {}),
          ...(!context.actor.scopes || context.actor.scopes.includes("email")
            ? { email: account.email }
            : {}),
        }
      : null,
  }
}
export async function currentOrganization(context: OperationContext) {
  await authorize(context, "organization:read")
  const [row] = await context.db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
    })
    .from(organization)
    .where(eq(organization.id, context.actor.organizationId))
    .limit(1)
  return { organizations: row ? [row] : [] }
}
export async function billingStatus(
  context: OperationContext,
  livemode: boolean
) {
  await authorize(context, "billing:read")
  const subscription = await getSubscriptionByOrganization(
    context.db,
    context.actor.organizationId,
    livemode
  )
  return {
    organizationId: context.actor.organizationId,
    entitled: await organizationIsEntitled(
      context.db,
      context.actor.organizationId,
      { livemode }
    ),
    subscription: subscription
      ? {
          status: subscription.status,
          renewsAt: subscription.currentPeriodEnd?.toISOString() ?? null,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
  }
}

/** Mutation + audit receipt commit together. Retried request IDs return the original receipt. */
export async function renameOrganization(
  context: OperationContext,
  input: { name: string; requestId: string }
) {
  await authorize(context, "organization:write", "admin")
  const name = input.name.trim()
  if (
    !name ||
    name.length > 100 ||
    !/^[a-zA-Z0-9_-]{8,128}$/.test(input.requestId)
  )
    throw new AppError("INVALID_INPUT", "Provide a name and a valid request ID")
  const requestId = `${context.actor.organizationId}:${context.actor.userId}:${input.requestId}`
  const [existing] = await context.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.requestId, requestId))
    .limit(1)
  if (existing) {
    if (existing.details.name !== name)
      throw new AppError(
        "CONFLICT",
        "Request ID already used for a different change"
      )
    return {
      organizationId: context.actor.organizationId,
      name,
      requestId: input.requestId,
    }
  }
  // Permission and idempotency predicates are also checked in the mutation SQL.
  const allowed = and(
    sql`exists (select 1 from ${member} where ${member.organizationId} = ${context.actor.organizationId} and ${member.userId} = ${context.actor.userId} and ${member.role} in ('admin','owner'))`,
    context.actor.grantId
      ? sql`exists (select 1 from ${agentGrant} where ${agentGrant.id} = ${context.actor.grantId} and ${agentGrant.revokedAt} is null)`
      : undefined
  )!
  await context.db.batch([
    context.db
      .update(organization)
      .set({ name })
      .where(
        and(
          eq(organization.id, context.actor.organizationId),
          allowed,
          sql`not exists (select 1 from ${auditEvent} where ${auditEvent.requestId} = ${requestId})`
        )
      ),
    context.db
      .insert(auditEvent)
      .select(
        context.db
          .select({
            id: sql<string>`${crypto.randomUUID()}`.as("id"),
            userId: sql<string>`${context.actor.userId}`.as("userId"),
            organizationId: organization.id,
            action: sql<string>`'organization.rename'`.as("action"),
            grantId: sql<string | null>`${context.actor.grantId ?? null}`.as(
              "grantId"
            ),
            requestId: sql<string>`${requestId}`.as("requestId"),
            details: sql<
              Record<string, unknown>
            >`${JSON.stringify({ name })}`.as("details"),
            createdAt: sql<Date>`${Date.now()}`.as("createdAt"),
          })
          .from(organization)
          .where(
            and(eq(organization.id, context.actor.organizationId), allowed)
          )
      )
      .onConflictDoNothing(),
  ])
  const [receipt] = await context.db
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.requestId, requestId))
    .limit(1)
  if (!receipt)
    throw new AppError("FORBIDDEN", "Organization permission changed")
  if (receipt.details.name !== name)
    throw new AppError(
      "CONFLICT",
      "Request ID already used for a different change"
    )
  return {
    organizationId: context.actor.organizationId,
    name,
    requestId: input.requestId,
  }
}
