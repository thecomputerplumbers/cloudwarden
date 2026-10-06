import { getMembership, roleAtLeast } from "@workspace/auth"
import { AppError } from "@/lib/errors"
import type { AppDb } from "@/db"

export type Actor = {
  userId: string
  organizationId: string
  grantId?: string
  scopes?: string[]
}
export type OperationContext = { db: AppDb; actor: Actor }

export async function authorize(
  context: OperationContext,
  scope: string,
  role: "member" | "admin" | "owner" = "member"
) {
  if (context.actor.scopes && !context.actor.scopes.includes(scope))
    throw new AppError("FORBIDDEN", `Requires ${scope} permission`)
  const membership = await getMembership(context.db, context.actor)
  if (!membership || !roleAtLeast(membership.role, role))
    throw new AppError(
      "FORBIDDEN",
      "Your organization role does not allow this action"
    )
  return membership
}
