import { and, count, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"
import {
  smAccessToken,
  smMachineAccess,
  smMachineAccount,
  smProject,
  smSecret,
} from "../db/schema/secrets"
import { authenticatedVaultUser, tokenHash } from "./bitwarden-auth"
import { getVaultMembership } from "./bitwarden-org"
import { vaultRateLimiter } from "./vault-rate-limit"

// Cloudwarden Secrets Manager: the server half. The contract (crypto, routes,
// shapes) is docs/secrets-manager.md; the browser and the Go reader implement
// the other halves. Everything stored here is ciphertext or a hash.

const PREFIX = "/api/cloudwarden/sm/"
/** How long a machine access token lasts before the reader authenticates again. */
const ACCESS_TOKEN_SECONDS = 600
const MAX_ENCRYPTED = 100_000
const LIMITS = {
  projects: 2000,
  secrets: 10_000,
  machineAccounts: 500,
  tokens: 50,
}

type Body = Record<string, unknown>
type Db = ReturnType<typeof drizzle>

export const isSecretsManagerPath = (path: string) => path.startsWith(PREFIX)

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}

const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store" } })
const noContent = () =>
  new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } })

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ENC_STRING =
  /^2\.[A-Za-z0-9+/]+={0,2}\|[A-Za-z0-9+/]+={0,2}\|[A-Za-z0-9+/]+={0,2}$/

async function bodyOf(request: Request): Promise<Body> {
  const text = await request.text()
  if (text.length > 1_000_000) throw new HttpError(413, "Request too large")
  try {
    const value: unknown = JSON.parse(text)
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Body
  } catch {
    // Falls through to the error below.
  }
  throw new HttpError(400, "Expected a JSON object")
}

function uuid(value: unknown, field: string) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new HttpError(400, `${field} must be a UUID`)
  return value.toLowerCase()
}

/** A type 2 encrypted string: the only form names and values are accepted in. */
function encrypted(value: unknown, field: string, optional = false) {
  if (optional && (value === null || value === undefined)) return null
  if (
    typeof value !== "string" ||
    value.length > MAX_ENCRYPTED ||
    !ENC_STRING.test(value)
  )
    throw new HttpError(400, `${field} must be an encrypted string`)
  return value
}

const iso = (date: Date | null) => (date ? date.toISOString() : null)

const projectBody = (row: typeof smProject.$inferSelect) => ({
  id: row.id,
  organizationId: row.orgId,
  name: row.name,
  creationDate: row.createdAt.toISOString(),
  revisionDate: row.updatedAt.toISOString(),
  object: "project",
})

const secretBody = (row: typeof smSecret.$inferSelect) => ({
  id: row.id,
  organizationId: row.orgId,
  projectId: row.projectId,
  key: row.key,
  value: row.value,
  note: row.note,
  creationDate: row.createdAt.toISOString(),
  revisionDate: row.updatedAt.toISOString(),
  object: "secret",
})

async function machineAccountBody(
  db: Db,
  row: typeof smMachineAccount.$inferSelect
) {
  const [access, tokens] = await Promise.all([
    db
      .select()
      .from(smMachineAccess)
      .where(eq(smMachineAccess.machineAccountId, row.id))
      .all(),
    db
      .select()
      .from(smAccessToken)
      .where(eq(smAccessToken.machineAccountId, row.id))
      .all(),
  ])
  return {
    id: row.id,
    organizationId: row.orgId,
    name: row.name,
    creationDate: row.createdAt.toISOString(),
    revisionDate: row.updatedAt.toISOString(),
    access: access.map((grant) => ({
      projectId: grant.projectId,
      write: grant.write,
    })),
    tokens: tokens.map(tokenBody),
    object: "machineAccount",
  }
}

const tokenBody = (row: typeof smAccessToken.$inferSelect) => ({
  id: row.id,
  name: row.name,
  expiresAt: iso(row.expiresAt),
  lastUsedDate: iso(row.lastUsedAt),
  creationDate: row.createdAt.toISOString(),
  object: "accessToken",
})

// ---------------------------------------------------------------------------
// Machine access tokens: `smv1.<tokenId>.<expiresMs>.<hmac>`, signed with a
// key derived from BETTER_AUTH_SECRET, so verifying one costs no storage read.

async function signingKey(env: CloudflareEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Token signing secret is not configured")
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.BETTER_AUTH_SECRET),
    "HKDF",
    false,
    ["deriveKey"]
  )
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new TextEncoder().encode("cloudwarden-sm-machine-access"),
      info: new TextEncoder().encode("v1"),
    },
    material,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"]
  )
}

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")

function fromBase64Url(text: string) {
  const base64 = text.replaceAll("-", "+").replaceAll("_", "/")
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="))
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

async function issueAccessToken(env: CloudflareEnv, tokenId: string) {
  const expires = Date.now() + ACCESS_TOKEN_SECONDS * 1000
  const input = `smv1.${tokenId}.${expires}`
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(env),
    new TextEncoder().encode(input)
  )
  return `${input}.${base64Url(new Uint8Array(signature))}`
}

/** The token ID an access token speaks for, or null when it is forged, malformed, or expired. */
async function verifyAccessToken(env: CloudflareEnv, request: Request) {
  const match =
    /^Bearer (smv1\.([0-9a-f-]{36})\.(\d{13})\.([A-Za-z0-9_-]+))$/i.exec(
      request.headers.get("Authorization") ?? ""
    )
  if (!match) return null
  const [, token, tokenId, expires, signature] = match
  if (Number(expires) <= Date.now()) return null
  let signatureBytes: Uint8Array<ArrayBuffer>
  try {
    signatureBytes = fromBase64Url(signature!)
  } catch {
    return null
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(env),
    signatureBytes,
    new TextEncoder().encode(token!.slice(0, token!.lastIndexOf(".")))
  )
  return valid ? tokenId!.toLowerCase() : null
}

/** The live token row: not revoked (deleted), not expired, its organization not being deleted. */
async function liveToken(db: Db, tokenId: string) {
  const row = await db
    .select()
    .from(smAccessToken)
    .where(eq(smAccessToken.id, tokenId))
    .get()
  if (!row || (row.expiresAt && row.expiresAt.getTime() <= Date.now()))
    return null
  return row
}

/** Constant-time comparison of two hex digests. */
function sameDigest(a: string, b: string) {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

async function machineAuth(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext
) {
  const body = await bodyOf(request)
  const tokenId = uuid(body.tokenId, "tokenId")
  if (typeof body.clientSecret !== "string" || body.clientSecret.length > 200)
    throw new HttpError(401, "Invalid access token")
  const limiter = vaultRateLimiter(env)
  const ip = request.headers.get("CF-Connecting-IP") ?? "unknown"
  const [perToken, perIp] = await Promise.all([
    limiter.consumeRateLimit(`sm-auth:${tokenId}`, 20, 60_000),
    limiter.consumeRateLimit(`sm-auth-ip:${ip}`, 20, 60_000),
  ])
  if (!perToken.allowed || !perIp.allowed)
    throw new HttpError(429, "Too many attempts")
  const db = drizzle(env.DB)
  const row = await liveToken(db, tokenId)
  // The same answer for unknown, revoked, expired, and wrong-secret tokens.
  if (!row || !sameDigest(await tokenHash(body.clientSecret), row.secretHash))
    throw new HttpError(401, "Invalid access token")
  ctx.waitUntil(
    db
      .update(smAccessToken)
      .set({ lastUsedAt: new Date() })
      .where(eq(smAccessToken.id, tokenId))
      .run()
      .catch(() => console.error("Access token last-use update failed"))
  )
  return json({
    accessToken: await issueAccessToken(env, tokenId),
    expiresIn: ACCESS_TOKEN_SECONDS,
    organizationId: row.orgId,
    encryptedPayload: row.encryptedPayload,
    object: "machineAuth",
  })
}

/** Reads for a machine: only secrets in projects its account has a grant on. */
async function machineRead(request: Request, env: CloudflareEnv, rest: string) {
  const tokenId = await verifyAccessToken(env, request)
  if (!tokenId) throw new HttpError(401, "Invalid or expired access token")
  const db = drizzle(env.DB)
  const token = await liveToken(db, tokenId)
  if (!token) throw new HttpError(401, "Invalid or expired access token")
  const readable = and(
    eq(smMachineAccess.machineAccountId, token.machineAccountId),
    eq(smSecret.orgId, token.orgId)
  )
  if (rest === "machine/projects") {
    const rows = await db
      .select({ project: smProject })
      .from(smProject)
      .innerJoin(smMachineAccess, eq(smMachineAccess.projectId, smProject.id))
      .where(
        and(
          eq(smMachineAccess.machineAccountId, token.machineAccountId),
          eq(smProject.orgId, token.orgId)
        )
      )
      .all()
    return json({
      data: rows.map((row) => projectBody(row.project)),
      object: "list",
    })
  }
  if (rest === "machine/secrets") {
    const projectId = new URL(request.url).searchParams.get("projectId")
    const rows = await db
      .select({ secret: smSecret })
      .from(smSecret)
      .innerJoin(
        smMachineAccess,
        eq(smMachineAccess.projectId, smSecret.projectId)
      )
      .where(
        projectId
          ? and(readable, eq(smSecret.projectId, uuid(projectId, "projectId")))
          : readable
      )
      .all()
    return json({
      data: rows.map((row) => secretBody(row.secret)),
      object: "list",
    })
  }
  const one = /^machine\/secrets\/([0-9a-f-]{36})$/i.exec(rest)
  if (one) {
    const row = await db
      .select({ secret: smSecret })
      .from(smSecret)
      .innerJoin(
        smMachineAccess,
        eq(smMachineAccess.projectId, smSecret.projectId)
      )
      .where(and(readable, eq(smSecret.id, one[1]!.toLowerCase())))
      .get()
    if (!row) throw new HttpError(404, "Secret not found")
    return json(secretBody(row.secret))
  }
  throw new HttpError(404, "Not found")
}

// ---------------------------------------------------------------------------
// Admin routes: an organization owner or admin, on their vault session.

async function requireAdmin(
  request: Request,
  env: CloudflareEnv,
  orgId: string
) {
  const user = await authenticatedVaultUser(env, request)
  if (!user) throw new HttpError(401, "Unauthorized")
  const membership = await getVaultMembership(env, orgId, user.id)
  // Not found for non-members, so organization IDs cannot be probed.
  if (!membership) throw new HttpError(404, "Organization not found")
  if (membership.role > 1)
    throw new HttpError(
      403,
      "Only organization owners and admins can manage secrets"
    )
}

async function underLimit(
  db: Db,
  table: typeof smProject | typeof smSecret | typeof smMachineAccount,
  orgId: string,
  limit: number
) {
  const row = await db
    .select({ n: count() })
    .from(table)
    .where(eq(table.orgId, orgId))
    .get()
  if ((row?.n ?? 0) >= limit)
    throw new HttpError(409, "This organization has reached its limit")
}

async function ownedProject(db: Db, orgId: string, projectId: string) {
  const row = await db
    .select()
    .from(smProject)
    .where(and(eq(smProject.id, projectId), eq(smProject.orgId, orgId)))
    .get()
  if (!row) throw new HttpError(404, "Project not found")
  return row
}

async function ownedMachineAccount(db: Db, orgId: string, id: string) {
  const row = await db
    .select()
    .from(smMachineAccount)
    .where(and(eq(smMachineAccount.id, id), eq(smMachineAccount.orgId, orgId)))
    .get()
  if (!row) throw new HttpError(404, "Machine account not found")
  return row
}

/** An insert that fails on a duplicate client-chosen ID is the same object being created again. */
async function insertOnce<T>(
  write: () => Promise<unknown>,
  existing: () => Promise<T | undefined>
) {
  try {
    await write()
  } catch (error) {
    const found = await existing()
    if (found) return found
    throw error
  }
  return undefined
}

async function admin(request: Request, env: CloudflareEnv, rest: string) {
  const match = /^orgs\/([0-9a-f-]{36})(?:\/(.*))?$/i.exec(rest)
  if (!match) throw new HttpError(404, "Not found")
  const orgId = match[1]!.toLowerCase()
  const sub = match[2] ?? ""
  const method = request.method
  await requireAdmin(request, env, orgId)
  const db = drizzle(env.DB)
  const now = new Date()

  if (sub === "" && method === "GET") {
    const [projects, secrets, accounts] = await Promise.all([
      db.select().from(smProject).where(eq(smProject.orgId, orgId)).all(),
      db.select().from(smSecret).where(eq(smSecret.orgId, orgId)).all(),
      db
        .select()
        .from(smMachineAccount)
        .where(eq(smMachineAccount.orgId, orgId))
        .all(),
    ])
    const ids = accounts.map((account) => account.id)
    // In batches: D1 binds at most 100 parameters per query.
    const grants: (typeof smMachineAccess.$inferSelect)[] = []
    const tokens: (typeof smAccessToken.$inferSelect)[] = []
    for (let i = 0; i < ids.length; i += 90) {
      const slice = ids.slice(i, i + 90)
      const [g, t] = await Promise.all([
        db
          .select()
          .from(smMachineAccess)
          .where(inArray(smMachineAccess.machineAccountId, slice))
          .all(),
        db
          .select()
          .from(smAccessToken)
          .where(inArray(smAccessToken.machineAccountId, slice))
          .all(),
      ])
      grants.push(...g)
      tokens.push(...t)
    }
    return json({
      projects: projects.map(projectBody),
      secrets: secrets.map(secretBody),
      machineAccounts: accounts.map((account) => ({
        id: account.id,
        organizationId: account.orgId,
        name: account.name,
        creationDate: account.createdAt.toISOString(),
        revisionDate: account.updatedAt.toISOString(),
        access: grants
          .filter((grant) => grant.machineAccountId === account.id)
          .map((grant) => ({ projectId: grant.projectId, write: grant.write })),
        tokens: tokens
          .filter((token) => token.machineAccountId === account.id)
          .map(tokenBody),
        object: "machineAccount",
      })),
      object: "secretsManager",
    })
  }

  // Projects
  if (sub === "projects" && method === "POST") {
    const body = await bodyOf(request)
    const id = uuid(body.id, "id")
    const name = encrypted(body.name, "name")!
    await underLimit(db, smProject, orgId, LIMITS.projects)
    const again = await insertOnce(
      () =>
        db
          .insert(smProject)
          .values({ id, orgId, name, createdAt: now, updatedAt: now })
          .run(),
      () =>
        db
          .select()
          .from(smProject)
          .where(and(eq(smProject.id, id), eq(smProject.orgId, orgId)))
          .get()
    )
    return json(projectBody(again ?? (await ownedProject(db, orgId, id))))
  }
  const project = /^projects\/([0-9a-f-]{36})$/i.exec(sub)
  if (project) {
    const id = project[1]!.toLowerCase()
    await ownedProject(db, orgId, id)
    if (method === "PUT") {
      const name = encrypted((await bodyOf(request)).name, "name")!
      await db
        .update(smProject)
        .set({ name, updatedAt: now })
        .where(eq(smProject.id, id))
        .run()
      return json(projectBody(await ownedProject(db, orgId, id)))
    }
    if (method === "DELETE") {
      const inUse = await db
        .select({ n: count() })
        .from(smSecret)
        .where(eq(smSecret.projectId, id))
        .get()
      if ((inUse?.n ?? 0) > 0)
        throw new HttpError(409, "Move or delete this project's secrets first")
      await db.batch([
        db.delete(smMachineAccess).where(eq(smMachineAccess.projectId, id)),
        db.delete(smProject).where(eq(smProject.id, id)),
      ])
      return noContent()
    }
  }

  // Secrets
  if (sub === "secrets" && method === "POST") {
    const body = await bodyOf(request)
    const id = uuid(body.id, "id")
    const projectId = uuid(body.projectId, "projectId")
    await ownedProject(db, orgId, projectId)
    await underLimit(db, smSecret, orgId, LIMITS.secrets)
    const fields = {
      key: encrypted(body.key, "key")!,
      value: encrypted(body.value, "value")!,
      note: encrypted(body.note, "note", true),
    }
    const again = await insertOnce(
      () =>
        db
          .insert(smSecret)
          .values({
            id,
            orgId,
            projectId,
            ...fields,
            createdAt: now,
            updatedAt: now,
          })
          .run(),
      () =>
        db
          .select()
          .from(smSecret)
          .where(and(eq(smSecret.id, id), eq(smSecret.orgId, orgId)))
          .get()
    )
    const row =
      again ??
      (await db.select().from(smSecret).where(eq(smSecret.id, id)).get())
    return json(secretBody(row!))
  }
  const secret = /^secrets\/([0-9a-f-]{36})$/i.exec(sub)
  if (secret) {
    const id = secret[1]!.toLowerCase()
    const existing = await db
      .select()
      .from(smSecret)
      .where(and(eq(smSecret.id, id), eq(smSecret.orgId, orgId)))
      .get()
    if (!existing) throw new HttpError(404, "Secret not found")
    if (method === "PUT") {
      const body = await bodyOf(request)
      const projectId = uuid(body.projectId, "projectId")
      await ownedProject(db, orgId, projectId)
      await db
        .update(smSecret)
        .set({
          projectId,
          key: encrypted(body.key, "key")!,
          value: encrypted(body.value, "value")!,
          note: encrypted(body.note, "note", true),
          updatedAt: now,
        })
        .where(eq(smSecret.id, id))
        .run()
      return json(
        secretBody(
          (await db.select().from(smSecret).where(eq(smSecret.id, id)).get())!
        )
      )
    }
    if (method === "DELETE") {
      await db.delete(smSecret).where(eq(smSecret.id, id)).run()
      return noContent()
    }
  }

  // Machine accounts
  if (sub === "machine-accounts" && method === "POST") {
    const body = await bodyOf(request)
    const id = uuid(body.id, "id")
    const name = encrypted(body.name, "name")!
    await underLimit(db, smMachineAccount, orgId, LIMITS.machineAccounts)
    const again = await insertOnce(
      () =>
        db
          .insert(smMachineAccount)
          .values({ id, orgId, name, createdAt: now, updatedAt: now })
          .run(),
      () =>
        db
          .select()
          .from(smMachineAccount)
          .where(
            and(eq(smMachineAccount.id, id), eq(smMachineAccount.orgId, orgId))
          )
          .get()
    )
    return json(
      await machineAccountBody(
        db,
        again ?? (await ownedMachineAccount(db, orgId, id))
      )
    )
  }
  const account =
    /^machine-accounts\/([0-9a-f-]{36})(?:\/(access|tokens)(?:\/([0-9a-f-]{36}))?)?$/i.exec(
      sub
    )
  if (account) {
    const id = account[1]!.toLowerCase()
    const part = account[2]
    const tokenId = account[3]?.toLowerCase()
    const row = await ownedMachineAccount(db, orgId, id)
    if (!part && method === "PUT") {
      const name = encrypted((await bodyOf(request)).name, "name")!
      await db
        .update(smMachineAccount)
        .set({ name, updatedAt: now })
        .where(eq(smMachineAccount.id, id))
        .run()
      return json(
        await machineAccountBody(db, await ownedMachineAccount(db, orgId, id))
      )
    }
    if (!part && method === "DELETE") {
      await db.batch([
        db.delete(smAccessToken).where(eq(smAccessToken.machineAccountId, id)),
        db
          .delete(smMachineAccess)
          .where(eq(smMachineAccess.machineAccountId, id)),
        db.delete(smMachineAccount).where(eq(smMachineAccount.id, id)),
      ])
      return noContent()
    }
    if (part === "access" && !tokenId && method === "PUT") {
      const grants = (await bodyOf(request)).grants
      if (!Array.isArray(grants) || grants.length > LIMITS.projects)
        throw new HttpError(400, "grants must be a list")
      const parsed = new Map<string, boolean>()
      for (const grant of grants) {
        if (!grant || typeof grant !== "object")
          throw new HttpError(400, "Invalid grant")
        const entry = grant as Body
        parsed.set(uuid(entry.projectId, "projectId"), entry.write === true)
      }
      const projectIds = [...parsed.keys()]
      for (let i = 0; i < projectIds.length; i += 90) {
        const slice = projectIds.slice(i, i + 90)
        const found = await db
          .select({ id: smProject.id })
          .from(smProject)
          .where(and(eq(smProject.orgId, orgId), inArray(smProject.id, slice)))
          .all()
        if (found.length !== slice.length)
          throw new HttpError(404, "Project not found")
      }
      await db.batch([
        db
          .delete(smMachineAccess)
          .where(eq(smMachineAccess.machineAccountId, id)),
        ...projectIds.map((projectId) =>
          db.insert(smMachineAccess).values({
            machineAccountId: id,
            projectId,
            write: parsed.get(projectId)!,
          })
        ),
        db
          .update(smMachineAccount)
          .set({ updatedAt: now })
          .where(eq(smMachineAccount.id, id)),
      ] as unknown as Parameters<typeof db.batch>[0])
      return json(
        await machineAccountBody(db, await ownedMachineAccount(db, orgId, id))
      )
    }
    if (part === "tokens" && !tokenId && method === "POST") {
      const body = await bodyOf(request)
      const newId = uuid(body.id, "id")
      if (
        typeof body.secretHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(body.secretHash)
      )
        throw new HttpError(400, "secretHash must be a SHA-256 hex digest")
      let expiresAt: Date | null = null
      if (body.expiresAt !== null && body.expiresAt !== undefined) {
        if (
          typeof body.expiresAt !== "string" ||
          !Number.isFinite(Date.parse(body.expiresAt))
        )
          throw new HttpError(400, "expiresAt must be an ISO time")
        expiresAt = new Date(body.expiresAt)
        if (expiresAt.getTime() <= Date.now())
          throw new HttpError(400, "expiresAt must be in the future")
      }
      const existing = await db
        .select({ n: count() })
        .from(smAccessToken)
        .where(eq(smAccessToken.machineAccountId, id))
        .get()
      if ((existing?.n ?? 0) >= LIMITS.tokens)
        throw new HttpError(409, "This machine account has too many tokens")
      const values = {
        id: newId,
        machineAccountId: id,
        orgId,
        name: encrypted(body.name, "name")!,
        secretHash: body.secretHash,
        encryptedPayload: encrypted(body.encryptedPayload, "encryptedPayload")!,
        expiresAt,
        createdAt: now,
      }
      const again = await insertOnce(
        () => db.insert(smAccessToken).values(values).run(),
        () =>
          db
            .select()
            .from(smAccessToken)
            .where(
              and(
                eq(smAccessToken.id, newId),
                eq(smAccessToken.machineAccountId, id)
              )
            )
            .get()
      )
      await db
        .update(smMachineAccount)
        .set({ updatedAt: now })
        .where(eq(smMachineAccount.id, id))
        .run()
      return json(
        tokenBody(
          again ??
            (await db
              .select()
              .from(smAccessToken)
              .where(eq(smAccessToken.id, newId))
              .get())!
        )
      )
    }
    if (part === "tokens" && tokenId && method === "DELETE") {
      await db
        .delete(smAccessToken)
        .where(
          and(
            eq(smAccessToken.id, tokenId),
            eq(smAccessToken.machineAccountId, row.id)
          )
        )
        .run()
      return noContent()
    }
  }
  throw new HttpError(404, "Not found")
}

export async function handleSecretsManager(
  request: Request,
  env: CloudflareEnv,
  ctx: ExecutionContext
) {
  const rest = new URL(request.url).pathname.slice(PREFIX.length)
  try {
    if (rest === "auth" && request.method === "POST")
      return await machineAuth(request, env, ctx)
    if (rest.startsWith("machine/")) {
      if (request.method !== "GET")
        throw new HttpError(405, "Method not allowed")
      return await machineRead(request, env, rest)
    }
    return await admin(request, env, rest)
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status)
    throw error
  }
}
