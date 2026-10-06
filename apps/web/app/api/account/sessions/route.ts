import { and, eq } from "drizzle-orm"
import { session as sessionTable } from "@workspace/auth/schema"
import { browserSession } from "@/lib/browser-request"
import { auth } from "@/lib/auth"
import { getDb } from "@/db"

export async function POST(request: Request) {
  try {
    const current = await browserSession(request)
    const { id } = (await request.json()) as { id: unknown }
    if (typeof id !== "string") throw new Error("Invalid session")
    const [target] = await getDb()
      .select({ token: sessionTable.token })
      .from(sessionTable)
      .where(
        and(eq(sessionTable.id, id), eq(sessionTable.userId, current.user.id))
      )
      .limit(1)
    if (!target)
      return Response.json({ error: "Session not found" }, { status: 404 })
    await auth.api.revokeSession({
      headers: request.headers,
      body: { token: target.token },
    })
    return Response.json({ ok: true })
  } catch {
    return Response.json({ error: "Could not revoke session" }, { status: 403 })
  }
}
