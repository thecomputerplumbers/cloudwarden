import { browserSession } from "@/lib/browser-request"
import { AppError, errorResponse } from "@/lib/errors"
import { logError, requestId } from "@/lib/diagnostics"
import { getDb } from "@/db"
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
} from "@/operations/projects"
async function handle(request: Request) {
  try {
    const { user } = await browserSession(request)
    const input = (
      request.method === "GET"
        ? Object.fromEntries(new URL(request.url).searchParams)
        : await request.json().catch(() => {
            throw new AppError("INVALID_INPUT", "Invalid JSON")
          })
    ) as Record<string, unknown>
    if (!input || typeof input.organizationId !== "string")
      throw new AppError("INVALID_INPUT", "Choose an organization")
    const context = {
      db: getDb(),
      actor: { userId: user.id, organizationId: input.organizationId },
    }
    const result =
      request.method === "GET"
        ? typeof input.id === "string"
          ? await getProject(context, input.id)
          : await listProjects(context, {
              after: input.after,
              limit: input.limit ? Number(input.limit) : undefined,
            })
        : request.method === "POST"
          ? await createProject(context, input)
          : await updateProject(context, input)
    return Response.json(result)
  } catch (error) {
    logError(error, "projects")
    return errorResponse(error, requestId())
  }
}
export const GET = handle
export const POST = handle
export const PATCH = handle
