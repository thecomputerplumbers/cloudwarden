import { logError } from "@/lib/diagnostics"
import { and, eq } from "drizzle-orm"
import { agentGrant } from "@workspace/auth/schema"
import { withGrantSelection } from "@workspace/auth/grants"
import { requireMembership } from "@workspace/auth"
import { auth } from "@/lib/auth"
import { browserSession } from "@/lib/browser-request"
import { getDb } from "@/db"

export async function POST(request: Request) {
  const db = getDb()
  let grantId: string | undefined
  let userId: string | undefined
  try {
    const session = await browserSession(request)
    userId = session.user.id
    const body = (await request.json()) as {
      organizationId?: unknown
      oauthQuery?: unknown
      accept?: unknown
    }
    if (
      typeof body.oauthQuery !== "string" ||
      body.oauthQuery.length > 16000 ||
      typeof body.accept !== "boolean"
    )
      throw new Error("Invalid authorization request")
    const oauthQuery = body.oauthQuery
    const headers = new Headers(request.headers)
    headers.set("accept", "application/json")
    if (!body.accept) {
      const result = await auth.api.oauth2Consent({
        request,
        asResponse: false,
        headers,
        body: { accept: false, oauth_query: oauthQuery },
      })
      return Response.json(result)
    }
    if (typeof body.organizationId !== "string")
      throw new Error("Choose an organization")
    await requireMembership(db, { userId, organizationId: body.organizationId })
    const clientId = new URLSearchParams(body.oauthQuery).get("client_id")
    if (!clientId) throw new Error("Missing client")
    grantId = crypto.randomUUID()
    const id = grantId
    return await withGrantSelection(
      { id, userId, organizationId: body.organizationId, clientId },
      async () => {
        // The provider verifies the signed authorization query before consent.
        const result = await auth.api.oauth2Consent({
          request,
          asResponse: false,
          headers,
          body: { accept: true, oauth_query: oauthQuery },
        })
        await db
          .update(agentGrant)
          .set({ approvedAt: new Date() })
          .where(
            and(eq(agentGrant.id, id), eq(agentGrant.userId, session.user.id))
          )
        return Response.json(result)
      }
    )
  } catch (error) {
    logError(error, "oauth.consent")
    if (grantId && userId)
      await db
        .delete(agentGrant)
        .where(and(eq(agentGrant.id, grantId), eq(agentGrant.userId, userId)))
    return Response.json(
      {
        error:
          "Authorization could not be completed. Restart the connection and try again.",
      },
      { status: 400 }
    )
  }
}
