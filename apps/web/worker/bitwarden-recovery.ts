const tokenEncoder = new TextEncoder()
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function hidden() {
  return new Response("Not found", {
    status: 404,
    headers: { "Cache-Control": "no-store" },
  })
}

async function authorized(request: Request, token: string) {
  const presented = /^Bearer (\S+)$/.exec(
    request.headers.get("Authorization") ?? ""
  )?.[1]
  if (!presented || token.length < 32 || presented.length > 4096) return false
  const [expected, actual] = await Promise.all([
    crypto.subtle.digest("SHA-256", tokenEncoder.encode(token)),
    crypto.subtle.digest("SHA-256", tokenEncoder.encode(presented)),
  ])
  const expectedBytes = new Uint8Array(expected)
  const actualBytes = new Uint8Array(actual)
  let different = 0
  for (let index = 0; index < expectedBytes.length; index++)
    different |= expectedBytes[index]! ^ actualBytes[index]!
  return different === 0
}

function parseTarget(value: unknown) {
  if (!value || typeof value !== "object") return null
  const body = value as Record<string, unknown>
  if (
    (body.kind !== "account" && body.kind !== "organization") ||
    typeof body.id !== "string" ||
    !uuid.test(body.id) ||
    typeof body.at !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(body.at)
  )
    return null
  const timestamp = Date.parse(body.at)
  if (!Number.isSafeInteger(timestamp) || timestamp > Date.now()) return null
  return {
    kind: body.kind,
    id: body.id,
    at: body.at,
    timestamp,
    confirm: body.confirm,
  }
}

async function boundedJson(request: Request) {
  const reader = request.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > 4096) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    return null
  }
}

export async function handleVaultRecovery(
  request: Request,
  env: CloudflareEnv
) {
  const url = new URL(request.url)
  if (
    env.MAINTENANCE_MODE !== "true" ||
    !env.RECOVERY_TOKEN ||
    url.origin !== env.APP_URL ||
    !(await authorized(request, env.RECOVERY_TOKEN))
  )
    return hidden()
  if (
    request.method !== "POST" ||
    !["/__ops/recovery/inspect", "/__ops/recovery/restore"].includes(
      url.pathname
    ) ||
    Number(request.headers.get("Content-Length") ?? 0) > 4096
  )
    return hidden()
  const body = await boundedJson(request)
  const target = parseTarget(body)
  if (!target)
    return Response.json({ error: "Invalid recovery target" }, { status: 400 })
  const table = target.kind === "account" ? "vault_user" : "vault_organization"
  let exists: { id: string } | null
  try {
    exists = await env.DB.prepare(
      `SELECT id FROM ${table} WHERE id = ? LIMIT 1`
    )
      .bind(target.id)
      .first<{ id: string }>()
  } catch {
    return Response.json(
      { error: "Recovery metadata database unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (!exists) return hidden()
  const object = await env.APP_DATABASE.getByName(
    `${target.kind === "account" ? "vault" : "org"}:${target.id}`
  )
  let bookmarks: { current: string; target: string }
  try {
    bookmarks = await object.recoveryBookmarksAt(target.timestamp)
  } catch {
    return Response.json(
      { error: "Recovery bookmarks unavailable for this object or time" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
  if (url.pathname.endsWith("/inspect"))
    return Response.json(
      { kind: target.kind, id: target.id, at: target.at, ...bookmarks },
      { headers: { "Cache-Control": "no-store" } }
    )
  if (target.confirm !== `RESTORE ${target.kind} ${target.id}`)
    return Response.json(
      { error: "Explicit restore confirmation required" },
      { status: 400 }
    )
  let undo: string
  try {
    undo = await object.scheduleRecoveryBookmark(bookmarks.target)
  } catch {
    return Response.json(
      { error: "Could not schedule Durable Object recovery" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
  try {
    await object.restartForRecovery()
  } catch {
    // Aborting the object ends this RPC while Cloudflare applies the bookmark.
  }
  return Response.json(
    {
      kind: target.kind,
      id: target.id,
      at: target.at,
      target: bookmarks.target,
      undo,
      restartRequested: true,
    },
    { status: 202, headers: { "Cache-Control": "no-store" } }
  )
}
