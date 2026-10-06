import { createLocalJWKSet, jwtVerify, type JSONWebKeySet } from "jose"

type Discovery = {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
}

type TokenSet = {
  access_token: string
  id_token: string
  refresh_token?: string
}
type Identity = {
  subject: string
  email: string
  name: string | null
  tokens: TokenSet
}

const encoder = new TextEncoder()

export function ssoRandom() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

export async function ssoChallenge(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(verifier))
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function endpoint(value: string, issuer: URL) {
  const url = new URL(value)
  if (
    url.protocol !== "https:" ||
    url.origin !== issuer.origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Invalid OIDC provider endpoint")
  return url
}

async function jsonResponse(
  url: URL,
  init: RequestInit,
  fetcher: typeof fetch
) {
  const response = await fetcher(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`OIDC provider returned ${response.status}`)
  const text = await response.text()
  if (text.length > 64_000)
    throw new Error("OIDC provider response is too large")
  const value: unknown = JSON.parse(text)
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid OIDC provider response")
  return value as Record<string, unknown>
}

export async function discoverVaultOidc(
  issuer: string,
  fetcher: typeof fetch = fetch
): Promise<Discovery> {
  const issuerUrl = new URL(issuer)
  if (
    issuerUrl.protocol !== "https:" ||
    issuerUrl.username ||
    issuerUrl.password ||
    issuerUrl.search ||
    issuerUrl.hash ||
    issuerUrl.pathname.endsWith("/")
  )
    throw new Error("Invalid OIDC issuer")
  const discoveryUrl = new URL(`${issuer}/.well-known/openid-configuration`)
  const metadata = await jsonResponse(discoveryUrl, {}, fetcher)
  if (
    metadata.issuer !== issuer ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string" ||
    typeof metadata.jwks_uri !== "string"
  )
    throw new Error("Invalid OIDC provider metadata")
  for (const value of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.jwks_uri,
  ])
    endpoint(value, issuerUrl)
  return metadata as Discovery
}

export function vaultOidcAuthorizeUrl(
  provider: Discovery,
  clientId: string,
  redirectUri: string,
  state: string,
  nonce: string,
  challenge: string
) {
  const url = new URL(provider.authorization_endpoint)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", clientId)
  url.searchParams.set("redirect_uri", redirectUri)
  url.searchParams.set("scope", "openid profile email offline_access")
  url.searchParams.set("state", state)
  url.searchParams.set("nonce", nonce)
  url.searchParams.set("code_challenge", challenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url
}

export async function redeemVaultOidc(
  provider: Discovery,
  input: {
    clientId: string
    clientSecret: string
    redirectUri: string
    code: string
    verifier: string
    nonce: string
  },
  fetcher: typeof fetch = fetch
): Promise<Identity> {
  const issuer = new URL(provider.issuer)
  const credential = btoa(`${input.clientId}:${input.clientSecret}`)
  const tokens = await jsonResponse(
    endpoint(provider.token_endpoint, issuer),
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credential}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.verifier,
      }),
    },
    fetcher
  )
  if (
    typeof tokens.id_token !== "string" ||
    typeof tokens.access_token !== "string" ||
    (tokens.refresh_token !== undefined &&
      typeof tokens.refresh_token !== "string")
  )
    throw new Error("Invalid OIDC token response")
  const keys = await jsonResponse(
    endpoint(provider.jwks_uri, issuer),
    {},
    fetcher
  )
  if (!Array.isArray(keys.keys)) throw new Error("Invalid OIDC signing keys")
  const { payload } = await jwtVerify(
    tokens.id_token,
    createLocalJWKSet({ keys: keys.keys } as JSONWebKeySet),
    {
      issuer: provider.issuer,
      audience: input.clientId,
      algorithms: ["RS256", "ES256"],
    }
  )
  if (
    payload.nonce !== input.nonce ||
    payload.email_verified !== true ||
    typeof payload.sub !== "string" ||
    !payload.sub ||
    typeof payload.email !== "string" ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)
  )
    throw new Error("OIDC identity is not verified")
  return {
    subject: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : null,
    tokens: tokens as TokenSet,
  }
}

export async function refreshVaultOidc(
  provider: Discovery,
  input: { clientId: string; clientSecret: string; refreshToken: string },
  fetcher: typeof fetch = fetch
) {
  const credential = btoa(`${input.clientId}:${input.clientSecret}`)
  const tokens = await jsonResponse(
    endpoint(provider.token_endpoint, new URL(provider.issuer)),
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credential}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
    },
    fetcher
  )
  if (
    typeof tokens.access_token !== "string" ||
    !tokens.access_token ||
    (tokens.refresh_token !== undefined &&
      typeof tokens.refresh_token !== "string")
  )
    throw new Error("Invalid OIDC refresh response")
  return tokens.refresh_token ?? input.refreshToken
}

async function tokenEncryptionKey(secret: string) {
  if (secret.length < 32)
    throw new Error("Token encryption secret is not configured")
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`cloudwarden-sso-refresh:${secret}`)
  )
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ])
}

export async function sealVaultOidcRefresh(secret: string, token: string) {
  const nonce = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    await tokenEncryptionKey(secret),
    encoder.encode(token)
  )
  return `${ssoBase64Url(nonce)}.${ssoBase64Url(new Uint8Array(ciphertext))}`
}

export async function openVaultOidcRefresh(secret: string, sealed: string) {
  const [nonce, ciphertext] = sealed.split(".")
  if (!nonce || !ciphertext) throw new Error("Invalid SSO refresh token")
  const bytes = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ssoDecodeBase64Url(nonce) },
    await tokenEncryptionKey(secret),
    ssoDecodeBase64Url(ciphertext)
  )
  return new TextDecoder().decode(bytes)
}

function ssoBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "")
}

function ssoDecodeBase64Url(value: string) {
  return Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0)
  )
}
