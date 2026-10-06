import { and, eq, isNotNull, isNull, lt, or } from "drizzle-orm"
import { drizzle } from "drizzle-orm/d1"

import { vaultSsoFlow, vaultSsoIdentity, vaultUser } from "../db/schema/vault"
import {
  createVaultStubUser,
  tokenHash,
  type VaultUser,
} from "./bitwarden-auth"
import {
  discoverVaultOidc,
  openVaultOidcRefresh,
  redeemVaultOidc,
  sealVaultOidcRefresh,
  ssoChallenge,
  ssoRandom,
  vaultOidcAuthorizeUrl,
} from "./bitwarden-oidc"

type SsoEnv = CloudflareEnv & {
  SSO_AUTHORITY?: string
  SSO_CLIENT_ID?: string
  SSO_CLIENT_SECRET?: string
  SSO_IDENTIFIER?: string
  SSO_CALLBACK_URL?: string
}

type SsoConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  identifier: string
  callback: string
  vaultOrigin: string
}

const encoder = new TextEncoder()
const lifetimeMs = 10 * 60_000

function clientRedirect(
  clientId: string | null,
  requested: string | null,
  vaultOrigin: string
) {
  if (clientId === "web" || clientId === "browser") {
    const expected = `${vaultOrigin}/sso-connector.html`
    return requested === expected ? expected : null
  }
  if (clientId === "desktop" || clientId === "mobile")
    return requested === "bitwarden://sso-callback" ? requested : null
  if (
    clientId === "cli" &&
    /^http:\/\/localhost:[0-9]{4}$/.test(requested ?? "")
  )
    return requested
  return null
}

function configuration(env: CloudflareEnv): SsoConfig | null {
  const config = env as SsoEnv
  if (
    !config.SSO_AUTHORITY ||
    !config.SSO_CLIENT_ID ||
    !config.SSO_CLIENT_SECRET ||
    !config.SSO_IDENTIFIER ||
    !config.SSO_CALLBACK_URL
  )
    return null
  const callback = new URL(config.SSO_CALLBACK_URL)
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.search ||
    callback.hash ||
    callback.pathname !== "/identity/connect/oidc-signin"
  )
    throw new Error("Invalid SSO callback configuration")
  return {
    issuer: config.SSO_AUTHORITY,
    clientId: config.SSO_CLIENT_ID,
    clientSecret: config.SSO_CLIENT_SECRET,
    identifier: config.SSO_IDENTIFIER,
    callback: callback.href,
    vaultOrigin: callback.origin,
  }
}

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function decodeBase64Url(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0)
  )
}

async function ssoSigningKey(env: CloudflareEnv) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32)
    throw new Error("Token signing secret is not configured")
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(env.BETTER_AUTH_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  )
}

async function prevalidateToken(env: CloudflareEnv, identifier: string) {
  const payload = base64Url(
    encoder.encode(
      JSON.stringify({
        purpose: "cloudwarden-sso",
        identifier,
        expiresAt: Date.now() + 2 * 60_000,
      })
    )
  )
  const signature = await crypto.subtle.sign(
    "HMAC",
    await ssoSigningKey(env),
    encoder.encode(payload)
  )
  return `${payload}.${base64Url(new Uint8Array(signature))}`
}

async function validPrevalidateToken(
  env: CloudflareEnv,
  token: string,
  identifier: string
) {
  const parts = token.split(".")
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  )
    return false
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await ssoSigningKey(env),
      decodeBase64Url(parts[1]!),
      encoder.encode(parts[0]!)
    )
    if (!valid) return false
    const value = JSON.parse(
      new TextDecoder().decode(decodeBase64Url(parts[0]!))
    ) as Record<string, unknown>
    return (
      value.purpose === "cloudwarden-sso" &&
      value.identifier === identifier &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now()
    )
  } catch {
    return false
  }
}

export async function prevalidateVaultSso(
  request: Request,
  env: CloudflareEnv
) {
  const config = configuration(env)
  if (!config)
    return Response.json({ error: "SSO is unavailable" }, { status: 404 })
  const hint = new URL(request.url).searchParams.get("domainHint")
  if (hint !== config.identifier)
    return Response.json({ error: "Unknown organization" }, { status: 404 })
  return Response.json({
    token: await prevalidateToken(env, config.identifier),
  })
}

export async function startVaultSso(
  request: Request,
  env: CloudflareEnv,
  fetcher: typeof fetch = fetch
) {
  const config = configuration(env)
  if (!config) return new Response("SSO is unavailable", { status: 404 })
  const params = new URL(request.url).searchParams
  const clientId = params.get("client_id")
  const state = params.get("state")
  const challenge = params.get("code_challenge")
  const redirect = clientRedirect(
    clientId,
    params.get("redirect_uri"),
    config.vaultOrigin
  )
  if (
    !clientId ||
    !redirect ||
    params.get("domain_hint") !== config.identifier ||
    params.get("code_challenge_method") !== "S256" ||
    !state ||
    state.length > 2048 ||
    !challenge ||
    !/^[A-Za-z0-9_-]{43,128}$/.test(challenge) ||
    !(await validPrevalidateToken(
      env,
      params.get("ssoToken") ?? "",
      config.identifier
    ))
  )
    return new Response("Invalid SSO request", { status: 400 })
  const provider = await discoverVaultOidc(config.issuer, fetcher)
  const id = ssoRandom()
  const verifier = ssoRandom()
  const nonce = ssoRandom()
  const binding = ssoRandom()
  await drizzle(env.DB)
    .insert(vaultSsoFlow)
    .values({
      id,
      clientId,
      clientState: state,
      clientChallenge: challenge,
      clientRedirect: redirect,
      providerVerifier: verifier,
      nonce,
      bindingHash: await tokenHash(binding),
      providerCode: null,
      providerRefreshToken: null,
      userId: null,
      createdAt: new Date(),
      usedAt: null,
    })
    .run()
  const location = vaultOidcAuthorizeUrl(
    provider,
    config.clientId,
    config.callback,
    id,
    nonce,
    await ssoChallenge(verifier)
  )
  return new Response(null, {
    status: 302,
    headers: {
      Location: location.href,
      "Set-Cookie": `CW_SSO_BINDING=${binding}; Path=/identity/connect/; Max-Age=600; HttpOnly; Secure; SameSite=Lax`,
      "Cache-Control": "no-store",
    },
  })
}

export async function finishVaultSsoCallback(
  request: Request,
  env: CloudflareEnv
) {
  const config = configuration(env)
  if (!config) return new Response("SSO is unavailable", { status: 404 })
  const params = new URL(request.url).searchParams
  const id = params.get("state")
  const code = params.get("code")
  const binding = /(?:^|;\s*)CW_SSO_BINDING=([^;]+)/.exec(
    request.headers.get("Cookie") ?? ""
  )?.[1]
  if (!id || !code || !binding || id.length > 100 || code.length > 4000)
    return new Response("Invalid SSO callback", { status: 400 })
  const db = drizzle(env.DB)
  const flow = await db
    .select()
    .from(vaultSsoFlow)
    .where(eq(vaultSsoFlow.id, id))
    .get()
  if (
    !flow ||
    flow.usedAt ||
    flow.providerCode ||
    flow.createdAt.getTime() + lifetimeMs < Date.now() ||
    flow.bindingHash !== (await tokenHash(binding))
  )
    return new Response("Invalid SSO callback", { status: 400 })
  const saved = await db
    .update(vaultSsoFlow)
    .set({ providerCode: code })
    .where(
      and(
        eq(vaultSsoFlow.id, id),
        isNull(vaultSsoFlow.providerCode),
        isNull(vaultSsoFlow.usedAt)
      )
    )
    .returning({ id: vaultSsoFlow.id })
    .get()
  if (!saved) return new Response("Invalid SSO callback", { status: 400 })
  const destination = new URL(flow.clientRedirect)
  destination.searchParams.set("code", id)
  destination.searchParams.set("state", flow.clientState)
  destination.searchParams.set("scope", "api offline_access")
  destination.searchParams.set("iss", config.vaultOrigin)
  return new Response(null, {
    status: 302,
    headers: {
      Location: destination.href,
      "Set-Cookie":
        "CW_SSO_BINDING=; Path=/identity/connect/; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
      "Cache-Control": "no-store",
    },
  })
}

export async function redeemVaultSso(
  env: CloudflareEnv,
  code: string,
  clientVerifier: string,
  clientId: string,
  redirectUri: string | null,
  fetcher: typeof fetch = fetch
): Promise<{ user: VaultUser; refreshToken: string }> {
  const config = configuration(env)
  if (
    !config ||
    !code ||
    !clientVerifier ||
    code.length > 100 ||
    clientVerifier.length > 200
  )
    throw new Error("Invalid SSO exchange")
  const db = drizzle(env.DB)
  const flow = await db
    .select()
    .from(vaultSsoFlow)
    .where(eq(vaultSsoFlow.id, code))
    .get()
  if (
    !flow?.providerCode ||
    flow.usedAt ||
    flow.createdAt.getTime() + lifetimeMs < Date.now() ||
    flow.clientId !== clientId ||
    (redirectUri !== null && flow.clientRedirect !== redirectUri) ||
    flow.clientChallenge !== (await ssoChallenge(clientVerifier))
  )
    throw new Error("Invalid SSO exchange")
  if (flow.userId) {
    const user = await db
      .select()
      .from(vaultUser)
      .where(and(eq(vaultUser.id, flow.userId), isNull(vaultUser.deletingAt)))
      .get()
    if (!user || !flow.providerRefreshToken)
      throw new Error("SSO account is unavailable")
    return {
      user,
      refreshToken: await openVaultOidcRefresh(
        env.BETTER_AUTH_SECRET ?? "",
        flow.providerRefreshToken
      ),
    }
  }
  const provider = await discoverVaultOidc(config.issuer, fetcher)
  const identity = await redeemVaultOidc(
    provider,
    {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.callback,
      code: flow.providerCode,
      verifier: flow.providerVerifier,
      nonce: flow.nonce,
    },
    fetcher
  )
  if (!identity.tokens.refresh_token)
    throw new Error("SSO provider did not grant a refresh token")
  const sealedRefresh = await sealVaultOidcRefresh(
    env.BETTER_AUTH_SECRET ?? "",
    identity.tokens.refresh_token
  )
  const mapped = await db
    .select({ user: vaultUser })
    .from(vaultSsoIdentity)
    .innerJoin(vaultUser, eq(vaultUser.id, vaultSsoIdentity.userId))
    .where(
      and(
        eq(vaultSsoIdentity.issuer, config.issuer),
        eq(vaultSsoIdentity.subject, identity.subject),
        isNull(vaultUser.deletingAt)
      )
    )
    .get()
  if (mapped) {
    const verified = mapped.user.email === identity.email
    const account =
      mapped.user.emailVerified === verified
        ? mapped.user
        : await db
            .update(vaultUser)
            .set({ emailVerified: verified, updatedAt: new Date() })
            .where(eq(vaultUser.id, mapped.user.id))
            .returning()
            .get()
    await db
      .update(vaultSsoFlow)
      .set({ userId: mapped.user.id, providerRefreshToken: sealedRefresh })
      .where(eq(vaultSsoFlow.id, code))
      .run()
    return { user: account, refreshToken: identity.tokens.refresh_token }
  }
  let user = await db
    .select()
    .from(vaultUser)
    .where(
      and(eq(vaultUser.email, identity.email), isNull(vaultUser.deletingAt))
    )
    .get()
  if (!user) {
    user = await createVaultStubUser(
      env,
      identity.email,
      identity.name ?? identity.email,
      true
    )
  }
  if (!user.emailVerified)
    user = await db
      .update(vaultUser)
      .set({ emailVerified: true, updatedAt: new Date() })
      .where(eq(vaultUser.id, user.id))
      .returning()
      .get()
  const existing = await db
    .select()
    .from(vaultSsoIdentity)
    .where(
      and(
        eq(vaultSsoIdentity.issuer, config.issuer),
        eq(vaultSsoIdentity.userId, user.id)
      )
    )
    .get()
  if (existing)
    throw new Error("Vault account is linked to another SSO identity")
  await db
    .insert(vaultSsoIdentity)
    .values({
      id: crypto.randomUUID(),
      issuer: config.issuer,
      subject: identity.subject,
      userId: user.id,
      createdAt: new Date(),
    })
    .run()
  await db
    .update(vaultSsoFlow)
    .set({ userId: user.id, providerRefreshToken: sealedRefresh })
    .where(eq(vaultSsoFlow.id, code))
    .run()
  return { user, refreshToken: identity.tokens.refresh_token }
}

export async function consumeVaultSso(
  env: CloudflareEnv,
  code: string,
  userId: string
) {
  const consumed = await drizzle(env.DB)
    .update(vaultSsoFlow)
    .set({ usedAt: new Date(), providerRefreshToken: null })
    .where(
      and(
        eq(vaultSsoFlow.id, code),
        eq(vaultSsoFlow.userId, userId),
        isNull(vaultSsoFlow.usedAt)
      )
    )
    .returning({ id: vaultSsoFlow.id })
    .get()
  return !!consumed
}

export async function pruneVaultSsoFlows(env: CloudflareEnv) {
  await drizzle(env.DB)
    .delete(vaultSsoFlow)
    .where(
      or(
        isNotNull(vaultSsoFlow.usedAt),
        lt(vaultSsoFlow.createdAt, new Date(Date.now() - lifetimeMs))
      )
    )
    .run()
}
