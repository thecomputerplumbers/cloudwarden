import type { RawCipher } from "./crypto/cipher.ts"
import type { KdfConfig } from "./crypto/kdf.ts"

/**
 * The native vault's calls to its own server: the same Bitwarden API every
 * other client uses, plus cloudwarden's vault selection. Same origin, so no
 * CORS; tokens live in memory and the refresh token in session storage.
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: Record<string, unknown> | null
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
  Key?: string
  key?: string
  PrivateKey?: string | null
  privateKey?: string | null
}

export interface TwoFactorChallenge {
  providers: number[]
}

export interface SyncResponse {
  profile: {
    id: string
    name: string
    email: string
    key: string
    privateKey: string | null
    organizations: {
      id: string
      name: string
      key: string | null
      type: number
      enabled: boolean
    }[]
  }
  folders: { id: string; name: string; revisionDate: string }[]
  collections: {
    id: string
    organizationId: string
    name: string
    readOnly: boolean
    hidePasswords: boolean
    manage?: boolean
  }[]
  ciphers: RawCipher[]
}

const DEVICE_KEY = "cloudwarden.device"

/** A stable ID for this browser, as Bitwarden clients send at login. */
export function deviceId() {
  try {
    const known = localStorage.getItem(DEVICE_KEY)
    if (known) return known
    const fresh = crypto.randomUUID()
    localStorage.setItem(DEVICE_KEY, fresh)
    return fresh
  } catch {
    return crypto.randomUUID()
  }
}

async function request<T>(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<T> {
  const headers = new Headers(init.headers)
  if (init.token) headers.set("Authorization", `Bearer ${init.token}`)
  const response = await fetch(path, { ...init, headers })
  const text = await response.text()
  let body: Record<string, unknown> | null = null
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : null
  } catch {
    body = null
  }
  if (!response.ok) {
    const message =
      (body?.error_description as string | undefined) ??
      (body?.ErrorModel as { Message?: string } | undefined)?.Message ??
      (body?.message as string | undefined) ??
      (body?.error as string | undefined) ??
      `Request failed (${response.status})`
    throw new ApiError(response.status, message, body)
  }
  return body as T
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

export async function prelogin(email: string): Promise<KdfConfig> {
  const body = await request<{
    kdf: number
    kdfIterations: number
    kdfMemory: number | null
    kdfParallelism: number | null
  }>("/identity/accounts/prelogin", json({ email }))
  return body.kdf === 1
    ? {
        kdf: 1,
        iterations: body.kdfIterations,
        memory: body.kdfMemory ?? 64,
        parallelism: body.kdfParallelism ?? 4,
      }
    : { kdf: 0, iterations: body.kdfIterations }
}

/** Password login. Resolves to a challenge when the account needs a second factor. */
export async function passwordLogin(input: {
  email: string
  passwordHash: string
  twoFactor?: { provider: number; token: string; remember: boolean }
}): Promise<TokenResponse | TwoFactorChallenge> {
  const form = new URLSearchParams({
    grant_type: "password",
    client_id: "web",
    scope: "api offline_access",
    username: input.email,
    password: input.passwordHash,
    deviceIdentifier: deviceId(),
    deviceName: "Cloudwarden",
    deviceType: "9",
  })
  if (input.twoFactor) {
    form.set("twoFactorProvider", String(input.twoFactor.provider))
    form.set("twoFactorToken", input.twoFactor.token)
    form.set("twoFactorRemember", input.twoFactor.remember ? "1" : "0")
  }
  try {
    return await request<TokenResponse>("/identity/connect/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    })
  } catch (error) {
    const providers =
      error instanceof ApiError
        ? (error.body?.TwoFactorProviders as unknown)
        : null
    if (Array.isArray(providers)) return { providers: providers.map(Number) }
    throw error
  }
}

export const isChallenge = (
  value: TokenResponse | TwoFactorChallenge
): value is TwoFactorChallenge => "providers" in value

export function refresh(refreshToken: string) {
  return request<TokenResponse>("/identity/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: "web",
      refresh_token: refreshToken,
    }),
  })
}

export const sendEmailCode = (email: string, passwordHash: string) =>
  request<null>(
    "/api/two-factor/send-email-login",
    json({ email, masterPasswordHash: passwordHash })
  )

export const sync = (token: string) =>
  request<SyncResponse>("/api/sync?excludeDomains=true", { token })

export const createCipher = (
  token: string,
  body: Record<string, unknown>,
  collectionIds: string[]
) =>
  body.organizationId
    ? request<RawCipher>("/api/ciphers/create", {
        ...json({ cipher: body, collectionIds }),
        token,
      })
    : request<RawCipher>("/api/ciphers", { ...json(body), token })

export const updateCipher = (
  token: string,
  id: string,
  body: Record<string, unknown>
) =>
  request<RawCipher>(`/api/ciphers/${id}`, {
    ...json(body),
    method: "PUT",
    token,
  })

export const trashCipher = (token: string, id: string) =>
  request<null>(`/api/ciphers/${id}/delete`, { method: "PUT", token })

export const restoreCipher = (token: string, id: string) =>
  request<RawCipher>(`/api/ciphers/${id}/restore`, { method: "PUT", token })

export const getVaultSelection = (token: string) =>
  request<{ excluded: string[] }>("/api/cloudwarden/vault-selection", { token })

export const putVaultSelection = (token: string, excluded: string[]) =>
  request<{ excluded: string[] }>("/api/cloudwarden/vault-selection", {
    ...json({ excluded }),
    method: "PUT",
    token,
  })

/** Starts a sign-up. Resolves to a registration token when the server does not verify email first, or null once it has sent the verification email. */
export const startSignup = (email: string, name: string) =>
  request<string | null>(
    "/identity/accounts/register/send-verification-email",
    {
      ...json({ email, name: name || null }),
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    }
  )

/** Checks an emailed sign-up link before asking for a master password. */
export const checkSignupLink = (email: string, token: string) =>
  request<null>(
    "/identity/accounts/register/verification-email-clicked",
    json({ email, emailVerificationToken: token })
  )

export const register = (body: Record<string, unknown>) =>
  request<unknown>("/identity/accounts/register/finish", json(body))

export const acceptInvite = (
  token: string,
  orgId: string,
  memberId: string,
  inviteToken: string
) =>
  request<null>(`/api/organizations/${orgId}/users/${memberId}/accept`, {
    ...json({ token: inviteToken }),
    token,
  })
