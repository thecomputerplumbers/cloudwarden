import { AppError, errorResponse } from "@/lib/errors"
import { logError, requestId } from "@/lib/diagnostics"
import { browserSession } from "@/lib/browser-request"
import { getDb } from "@/db"
import { renameOrganization } from "@/operations/organization"
export async function POST(request: Request) {
  try {
    const { user } = await browserSession(request)
    const input = (await request.json()) as {
      organizationId: unknown
      name: unknown
      requestId: unknown
    }
    if (
      typeof input.organizationId !== "string" ||
      typeof input.name !== "string" ||
      typeof input.requestId !== "string"
    )
      throw new AppError("INVALID_INPUT", "Invalid input")
    const result = await renameOrganization(
      {
        db: getDb(),
        actor: {
          userId: user.id,
          organizationId: input.organizationId,
        },
      },
      { name: input.name, requestId: input.requestId }
    )
    return Response.json(result)
  } catch (error) {
    logError(error, "organization.rename")
    return errorResponse(error, requestId())
  }
}
