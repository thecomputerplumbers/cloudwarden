import { and, eq, gt, asc, sql } from "drizzle-orm"
import { z } from "zod"
import { project } from "@/db/schema/projects"
import { member, agentGrant } from "@workspace/auth/schema"
import { authorize, type OperationContext } from "./context"
import { AppError } from "@/lib/errors"
import product from "@/config/product.json"
export const projectInput = z.object({
  name: z.string().trim().min(1, "Enter a project name").max(100),
  description: z.string().trim().max(2000).default(""),
  status: z.enum(["active", "archived"]).default("active"),
})
export const projectCreateInput = projectInput.extend({ id: z.uuid() })
export const projectUpdateInput = projectInput.extend({
  id: z.uuid(),
  version: z.number().int().positive(),
})
function enabled() {
  if (!product.features.projects)
    throw new AppError("NOT_FOUND", "Projects are unavailable")
}
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw new AppError(
      "INVALID_INPUT",
      "Check the highlighted fields",
      Object.fromEntries(
        result.error.issues.map((issue) => [
          String(issue.path[0] ?? "form"),
          issue.message,
        ])
      )
    )
  return result.data
}
// Recheck permission in the mutation itself, closing the membership-check/write race.
function writePermission(context: OperationContext) {
  return and(
    sql`exists (select 1 from ${member} where ${member.organizationId}=${context.actor.organizationId} and ${member.userId}=${context.actor.userId} and ${member.role} in ('owner','admin'))`,
    context.actor.grantId
      ? sql`exists (select 1 from ${agentGrant} where ${agentGrant.id}=${context.actor.grantId} and ${agentGrant.revokedAt} is null and ${agentGrant.approvedAt} is not null)`
      : undefined
  )!
}
export async function listProjects(
  context: OperationContext,
  input: unknown = {}
) {
  enabled()
  await authorize(context, "projects:read")
  const { after, limit } = parse(
    z.object({
      after: z.uuid().optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }),
    input
  )
  const rows = await context.db
    .select()
    .from(project)
    .where(
      and(
        eq(project.organizationId, context.actor.organizationId),
        after ? gt(project.id, after) : undefined
      )
    )
    .orderBy(asc(project.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit)
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
}
export async function getProject(context: OperationContext, id: string) {
  enabled()
  await authorize(context, "projects:read")
  return findProject(context, id)
}
async function findProject(context: OperationContext, id: string) {
  const [row] = await context.db
    .select()
    .from(project)
    .where(
      and(
        eq(project.id, id),
        eq(project.organizationId, context.actor.organizationId)
      )
    )
    .limit(1)
  if (!row) throw new AppError("NOT_FOUND", "Project not found")
  return row
}
export async function createProject(context: OperationContext, input: unknown) {
  enabled()
  await authorize(context, "projects:write", "admin")
  const data = parse(projectCreateInput, input),
    now = Date.now()
  await context.db
    .insert(project)
    .select(
      context.db
        .select({
          id: sql<string>`${data.id}`.as("id"),
          organizationId: member.organizationId,
          name: sql<string>`${data.name}`.as("name"),
          description: sql<string>`${data.description}`.as("description"),
          status: sql<"active" | "archived">`${data.status}`.as("status"),
          version: sql<number>`1`.as("version"),
          createdAt: sql<Date>`${now}`.as("createdAt"),
          updatedAt: sql<Date>`${now}`.as("updatedAt"),
        })
        .from(member)
        .where(
          and(
            eq(member.organizationId, context.actor.organizationId),
            eq(member.userId, context.actor.userId),
            writePermission(context)
          )
        )
        .limit(1)
    )
    .onConflictDoNothing()
  const row = await findProject(context, data.id)
  if (
    row.name !== data.name ||
    row.description !== data.description ||
    row.status !== data.status
  )
    throw new AppError(
      "CONFLICT",
      "This project ID was already used. Reload and try again."
    )
  return row
}
export async function updateProject(context: OperationContext, input: unknown) {
  enabled()
  await authorize(context, "projects:write", "admin")
  const { id, version, ...data } = parse(projectUpdateInput, input)
  const [row] = await context.db
    .update(project)
    .set({ ...data, version: version + 1, updatedAt: new Date() })
    .where(
      and(
        eq(project.id, id),
        eq(project.organizationId, context.actor.organizationId),
        eq(project.version, version),
        writePermission(context)
      )
    )
    .returning()
  if (!row) {
    await findProject(context, id)
    throw new AppError(
      "CONFLICT",
      "This project changed. Reload before saving again."
    )
  }
  return row
}
