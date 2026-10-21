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

export async function request<T>(
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

export const json = (body: unknown): RequestInit => ({
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

export const publicKeyOf = (token: string, userId: string) =>
  request<{ publicKey: string }>(`/api/users/${userId}/public-key`, { token })

export const createOrganization = (
  token: string,
  body: Record<string, unknown>
) =>
  request<{ id: string; name: string }>("/api/organizations", {
    ...json(body),
    token,
  })

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

export const changePassword = (token: string, body: Record<string, unknown>) =>
  request<null>("/api/accounts/password", { ...json(body), token })

export const changeKdf = (token: string, body: Record<string, unknown>) =>
  request<null>("/api/accounts/kdf", { ...json(body), token })

/** Two-step login providers: 0 authenticator app, 1 email, 7 security key. */
export const twoFactorProviders = (token: string) =>
  request<{ data: { type: number; enabled: boolean }[] }>("/api/two-factor", {
    token,
  })

/** Proof of the master password for two-step login changes, valid for 15 minutes. */
type Verified = { userVerificationToken: string }

export const getAuthenticator = (token: string, masterPasswordHash: string) =>
  request<{ enabled: boolean; key: string } & Verified>(
    "/api/two-factor/get-authenticator",
    { ...json({ masterPasswordHash }), token }
  )

export const enableAuthenticator = (
  token: string,
  body: { key: string; token: string; userVerificationToken: string }
) =>
  request<unknown>("/api/two-factor/authenticator", {
    ...json(body),
    method: "PUT",
    token,
  })

export const getEmailFactor = (token: string, masterPasswordHash: string) =>
  request<{ enabled: boolean; email: string | null } & Verified>(
    "/api/two-factor/get-email",
    { ...json({ masterPasswordHash }), token }
  )

export const sendEmailFactorCode = (
  token: string,
  body: { email: string; userVerificationToken: string }
) => request<null>("/api/two-factor/send-email", { ...json(body), token })

export const enableEmailFactor = (
  token: string,
  body: { email: string; token: string; userVerificationToken: string }
) =>
  request<unknown>("/api/two-factor/email", {
    ...json(body),
    method: "PUT",
    token,
  })

export interface SecurityKey {
  id: number
  name: string
}

export const getSecurityKeys = (token: string, masterPasswordHash: string) =>
  request<{ enabled: boolean; keys: SecurityKey[] } & Verified>(
    "/api/two-factor/get-webauthn",
    { ...json({ masterPasswordHash }), token }
  )

export const securityKeyChallenge = (
  token: string,
  userVerificationToken: string
) =>
  request<Record<string, unknown>>("/api/two-factor/get-webauthn-challenge", {
    ...json({ userVerificationToken }),
    token,
  })

export const addSecurityKey = (
  token: string,
  body: {
    id: number
    name: string
    deviceResponse: unknown
    userVerificationToken: string
  }
) =>
  request<{ keys: SecurityKey[] }>("/api/two-factor/webauthn", {
    ...json(body),
    method: "PUT",
    token,
  })

export const removeSecurityKey = (
  token: string,
  body: { id: number; userVerificationToken: string }
) =>
  request<{ keys: SecurityKey[] }>("/api/two-factor/webauthn", {
    ...json(body),
    method: "DELETE",
    token,
  })

export const disableTwoFactor = (
  token: string,
  body: { type: number; userVerificationToken: string }
) =>
  request<unknown>("/api/two-factor/disable", {
    ...json(body),
    method: "PUT",
    token,
  })

export const recoveryCode = (token: string, masterPasswordHash: string) =>
  request<{ code: string }>("/api/two-factor/get-recover", {
    ...json({ masterPasswordHash }),
    token,
  })

export interface Device {
  id: string
  name: string
  type: number
  identifier: string
  creationDate: string
  lastActivityDate: string
}

export const devices = (token: string) =>
  request<{ data: Device[] }>("/api/devices", { token })

export const removeDevice = (token: string, id: string) =>
  request<null>(`/api/devices/${id}/deactivate`, { method: "POST", token })

export const createFolder = (token: string, name: string) =>
  request<{ id: string }>("/api/folders", { ...json({ name }), token })

/** Imports into the personal vault: at most 1,000 items a request. Folders with an ID already exist; `folderRelationships` maps item index to folder index. */
export const importVault = (
  token: string,
  body: {
    ciphers: Record<string, unknown>[]
    folders: { id: string; name: string }[]
    folderRelationships: { key: number; value: number }[]
  }
) => request<null>("/api/ciphers/import", { ...json(body), token })

export const verifyPassword = (token: string, masterPasswordHash: string) =>
  request<null>("/api/accounts/verify-password", {
    ...json({ masterPasswordHash }),
    token,
  })

// Sends ----------------------------------------------------------------------

export interface RawSend {
  id: string
  accessId: string
  type: number
  name: string
  notes: string | null
  text: { text: string | null; hidden: boolean } | null
  file: { id: string; fileName: string; size: string; sizeName: string } | null
  key: string
  maxAccessCount: number | null
  accessCount: number
  password: string | null
  authType: number
  disabled: boolean
  hideEmail: boolean
  revisionDate: string
  expirationDate: string | null
  deletionDate: string
}

export interface RawSendAccess {
  id: string
  type: number
  authType: number
  name: string
  text: { text: string | null; hidden: boolean } | null
  file: { id: string; fileName: string; size: string; sizeName: string } | null
  expirationDate: string | null
  creatorIdentifier: string | null
}

export const sends = (token: string) =>
  request<{ data: RawSend[] }>("/api/sends", { token })

export const createSend = (token: string, body: Record<string, unknown>) =>
  request<RawSend>("/api/sends", { ...json(body), token })

export const createFileSend = (token: string, body: Record<string, unknown>) =>
  request<{ url: string; sendResponse: RawSend }>("/api/sends/file/v2", {
    ...json(body),
    token,
  })

/** Uploads a file Send's encrypted bytes; the file's name is its encrypted name. */
export function uploadSendFile(
  token: string,
  send: RawSend,
  encrypted: Uint8Array
) {
  const form = new FormData()
  form.append(
    "data",
    new Blob([encrypted as Uint8Array<ArrayBuffer>]),
    send.file!.fileName
  )
  return request<null>(`/api/sends/${send.id}/file/${send.file!.id}`, {
    method: "POST",
    body: form,
    token,
  })
}

export const updateSend = (
  token: string,
  id: string,
  body: Record<string, unknown>
) =>
  request<RawSend>(`/api/sends/${id}`, { ...json(body), method: "PUT", token })

export const removeSendPassword = (token: string, id: string) =>
  request<RawSend>(`/api/sends/${id}/remove-password`, { method: "PUT", token })

export const deleteSend = (token: string, id: string) =>
  request<null>(`/api/sends/${id}`, { method: "DELETE", token })

/** Opens a Send as its recipient. 401 means it needs a password. */
export const accessSend = (accessId: string, password: string | null) =>
  request<RawSendAccess>(
    `/api/sends/access/${accessId}`,
    json(password ? { password } : {})
  )

export const sendFileLink = (
  sendId: string,
  fileId: string,
  password: string | null
) =>
  request<{ url: string }>(
    `/api/sends/${sendId}/access/file/${fileId}`,
    json(password ? { password } : {})
  )
