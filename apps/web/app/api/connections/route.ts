import { and, eq } from "drizzle-orm"
import {
  agentGrant,
  oauthConsent,
  oauthAccessToken,
  oauthRefreshToken,
} from "@workspace/auth/schema"
import { browserSession } from "@/lib/browser-request"
import { getDb } from "@/db"

export async function POST(request: Request) {
  try {
    const { user } = await browserSession(request)
    const { id } = (await request.json()) as { id: unknown }
    if (typeof id !== "string") throw new Error("Invalid connection")
    const db = getDb()
    const [grant] = await db
      .select()
      .from(agentGrant)
      .where(and(eq(agentGrant.id, id), eq(agentGrant.userId, user.id)))
      .limit(1)
    if (!grant)
      return Response.json({ error: "Connection not found" }, { status: 404 })
    await db.batch([
      db
        .update(agentGrant)
        .set({ revokedAt: new Date() })
        .where(eq(agentGrant.id, id)),
      db.delete(oauthAccessToken).where(eq(oauthAccessToken.referenceId, id)),
      db.delete(oauthRefreshToken).where(eq(oauthRefreshToken.referenceId, id)),
      db.delete(oauthConsent).where(eq(oauthConsent.referenceId, id)),
    ])
    return Response.json({ ok: true })
  } catch {
    return Response.json(
      { error: "Could not revoke connection" },
      { status: 403 }
    )
  }
}
