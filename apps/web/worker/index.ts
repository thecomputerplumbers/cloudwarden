import { processEmergencyAccess } from "./bitwarden-emergency-access"
import { handleSecretsManager, isSecretsManagerPath } from "./secrets-manager"
import { prunePasskeyChallenges } from "./bitwarden-passkey-login"
import product from "../config/product.json"
import { observeRequest } from "../lib/diagnostics"

export { AppDatabase } from "./database"

import {
  canonicalBitwardenPath,
  handleBitwarden,
  isBitwardenPath,
} from "./bitwarden"
import { authenticatedVaultUser, deletingVaultUsers } from "./bitwarden-auth"
import { cleanupVaultDeletion } from "./bitwarden-delete"
import { reconcileVaultDirectory } from "./bitwarden-directory-sync"
import { pruneVaultSsoFlows } from "./bitwarden-sso"
import {
  cleanupOrgDeletion,
  deletingOrganizations,
  getOrgCipherLocator,
} from "./bitwarden-org"
import { completeVaultShare, pendingVaultShares } from "./bitwarden-share"
import {
  completeOrgImport,
  pendingOrgImports,
  pruneOrgImports,
} from "./bitwarden-org-import"
import { pruneProtectedOtps } from "./bitwarden-protected-otp"
import { pruneVaultEmailChanges } from "./bitwarden-email-change"
import { pruneAuthRequests } from "./bitwarden-auth-request"
import { handleVaultRecovery } from "./bitwarden-recovery"
import {
  handleVaultNotification,
  mutationNotification,
  organizationNotificationTargets,
  publishOrganizationSync,
  publishVaultNotification,
} from "./bitwarden-notifications"

/**
 * Bitwarden's web client, served at /legacy/, takes its API base from its own
 * address and calls /legacy/api, /legacy/identity, and so on. Those are the
 * same endpoints as at the root, so the prefix is dropped before routing.
 */
const LEGACY_API =
  /^\/legacy(\/(?:api|identity|notifications|icons|events|attachments)(?:\/.*)?)$/i

function fromLegacy(request: Request) {
  if (product.slug !== "cloudwarden") return request
  const url = new URL(request.url)
  const match = LEGACY_API.exec(url.pathname)
  if (!match) return request
  url.pathname = match[1]!
  return new Request(url, request)
}

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    request = fromLegacy(request)
    return observeRequest(request, async () => {
      const path = canonicalBitwardenPath(
        new URL(request.url).pathname.toLowerCase()
      )
      if (path.startsWith("/__ops/"))
        return path.startsWith("/__ops/recovery/")
          ? handleVaultRecovery(request, env)
          : new Response("Not found", { status: 404 })
      if (env.MAINTENANCE_MODE === "true")
        return Response.json(
          { error: "Vault temporarily unavailable", maintenance: true },
          {
            status: 503,
            headers: { "Cache-Control": "no-store", "Retry-After": "300" },
          }
        )
      // Secrets Manager (docs/secrets-manager.md): cloudwarden's own API, with its own auth.
      if (isSecretsManagerPath(path))
        return handleSecretsManager(request, env, ctx)
      if (
        path === "/notifications/hub" ||
        path === "/notifications/anonymous-hub"
      )
        return handleVaultNotification(request, env)
      if (isBitwardenPath(path)) {
        const mutating = !["GET", "HEAD"].includes(request.method)
        const vaultMutation =
          mutating &&
          (path.startsWith("/api/ciphers") ||
            path.startsWith("/api/folders") ||
            path.startsWith("/api/sends"))
        const orgMutation = mutating && path.startsWith("/api/organizations")
        const user =
          vaultMutation || orgMutation
            ? await authenticatedVaultUser(env, request)
            : null
        const userOnlyCipherMutation =
          /\/api\/ciphers\/[0-9a-f-]{36}\/(?:partial|archive|unarchive)$/i.test(
            path
          )
        const cipherId =
          user &&
          !userOnlyCipherMutation &&
          path.match(/^\/api\/ciphers\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]
        const beforeLocator = cipherId
          ? await getOrgCipherLocator(env, cipherId)
          : null
        const batchIds =
          user &&
          (request.method === "PUT" ||
            (path !== "/api/ciphers/restore" &&
              (request.method === "POST" || request.method === "DELETE"))) &&
          (path === "/api/ciphers/delete" ||
            path === "/api/ciphers/restore" ||
            (path === "/api/ciphers" && request.method === "DELETE"))
            ? (
                (await request
                  .clone()
                  .json()
                  .catch(() => null)) as { ids?: unknown } | null
              )?.ids
            : null
        const batchLocators =
          Array.isArray(batchIds) && batchIds.length <= 100
            ? await Promise.all(
                batchIds
                  .filter(
                    (id): id is string =>
                      typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)
                  )
                  .map((id) => getOrgCipherLocator(env, id))
              )
            : []
        const orgIdFromPath =
          user &&
          path.match(/^\/api\/organizations\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]
        const beforeMembers =
          orgIdFromPath &&
          request.method === "DELETE" &&
          (path === `/api/organizations/${orgIdFromPath}` ||
            path.includes("/users/"))
            ? await organizationNotificationTargets(env, orgIdFromPath, null)
            : []
        const shareRequest =
          user && path === "/api/ciphers/share" && request.method === "PUT"
            ? request.clone()
            : null
        const response = await handleBitwarden(
          request,
          env,
          user ?? undefined,
          cipherId ? { id: cipherId, locator: beforeLocator } : undefined
        )
        if (user && response.ok) {
          // Other devices are told after the response is sent: the client that
          // made the change has its answer, and publishing takes several round trips.
          const created =
            request.method === "POST" &&
            (path === "/api/ciphers" ||
              path === "/api/ciphers/create" ||
              path === "/api/organizations")
              ? response.clone()
              : null
          const mutationResponse = vaultMutation ? response.clone() : null
          const notify = async () => {
            try {
              const event = vaultMutation
                ? await mutationNotification(
                    path,
                    request.method,
                    mutationResponse!,
                    user.id,
                    user.notificationDeviceId
                  )
                : null
              // Only the owner receives personal updates. Shared updates are
              // sent below to the currently authorized collection members.
              if (
                event &&
                (userOnlyCipherMutation ||
                  (!beforeLocator && !event.organizationId))
              )
                await publishVaultNotification(env, event)
              const notices = new Map<string, Set<string> | null>()
              const add = (
                orgId: string | null | undefined,
                collections: string[] | null
              ) => {
                if (!orgId) return
                const existing = notices.get(orgId)
                if (existing === null || collections === null) {
                  notices.set(orgId, null)
                  return
                }
                const ids = existing ?? new Set<string>()
                for (const id of collections) ids.add(id)
                notices.set(orgId, ids)
              }
              if (beforeLocator)
                add(beforeLocator.orgId, beforeLocator.collectionIds)
              for (const locator of batchLocators)
                if (locator) add(locator.orgId, locator.collectionIds)
              let afterLocator = null
              if (cipherId) {
                // These routes cannot change the locator or collection assignments.
                afterLocator =
                  /^\/api\/ciphers\/[0-9a-f-]{36}(?:\/(?:delete|restore))?$/.test(
                    path
                  )
                    ? beforeLocator
                    : await getOrgCipherLocator(env, cipherId)
                if (afterLocator)
                  add(afterLocator.orgId, afterLocator.collectionIds)
              }
              if (path === "/api/ciphers/import-organization")
                add(
                  new URL(request.url).searchParams.get("organizationId"),
                  null
                )
              if (shareRequest) {
                const body = (await shareRequest.json().catch(() => null)) as {
                  ciphers?: { organizationId?: string }[]
                  collectionIds?: string[]
                } | null
                if (
                  body?.ciphers?.[0]?.organizationId &&
                  Array.isArray(body.collectionIds)
                )
                  add(body.ciphers[0].organizationId, body.collectionIds)
              }
              if (
                (path === "/api/ciphers" || path === "/api/ciphers/create") &&
                request.method === "POST"
              ) {
                const body = (await created?.json().catch(() => null)) as {
                  organizationId?: string
                  collectionIds?: string[]
                } | null
                if (body?.organizationId && Array.isArray(body.collectionIds))
                  add(body.organizationId, body.collectionIds)
              }
              if (orgMutation) {
                if (orgIdFromPath) add(orgIdFromPath, null)
                else if (
                  path === "/api/organizations" &&
                  request.method === "POST"
                ) {
                  const body = (await created?.json().catch(() => null)) as {
                    id?: string
                  } | null
                  add(body?.id, null)
                }
              }
              for (const [orgId, collections] of notices)
                await publishOrganizationSync(
                  env,
                  orgId,
                  collections ? [...collections] : null,
                  event &&
                    [0, 1, 2].includes(event.type) &&
                    (!beforeLocator ||
                      !afterLocator ||
                      JSON.stringify(
                        [...beforeLocator.collectionIds].sort()
                      ) ===
                        JSON.stringify([...afterLocator.collectionIds].sort()))
                    ? { ...event, organizationId: orgId }
                    : {
                        type: 5,
                        userId: user.id,
                        contextId: user.notificationDeviceId,
                      }
                )
              if (orgIdFromPath && beforeMembers.length) {
                const afterMembers = new Set(
                  await organizationNotificationTargets(
                    env,
                    orgIdFromPath,
                    null
                  )
                )
                for (const removed of beforeMembers)
                  if (!afterMembers.has(removed))
                    await publishVaultNotification(env, {
                      type: 5,
                      userId: removed,
                    })
              }
            } catch {
              console.error("Vault mutation notification failed")
            }
          }
          ctx.waitUntil(notify())
        }
        return response
      }
      if (
        (!product.features.mcp &&
          (path === "/mcp" ||
            path.startsWith("/.well-known/") ||
            path.startsWith("/api/auth/oauth2") ||
            path === "/connect" ||
            path === "/api/connect" ||
            path === "/connections" ||
            path === "/api/connections")) ||
        (!product.features.billing &&
          (path === "/billing" || path.startsWith("/api/stripe/")))
      )
        return new Response("Not found", { status: 404 })
      if (path === "/mcp") {
        const { handleMcp } = await import("../mcp/handler")
        return handleMcp(request)
      }
      if (path.startsWith("/.well-known/")) {
        const { auth } = await import("../lib/auth")
        return auth.handler(request)
      }
      if (product.slug === "cloudwarden") {
        // The native vault is the site: / and /vault (app/page.tsx,
        // app/vault). Bitwarden's web client is static under /legacy/.
        if (
          path === "/" ||
          path === "/api/health" ||
          path === "/vault" ||
          path.startsWith("/vault/")
        ) {
          const { default: vinextWorker } =
            await import("vinext/server/app-router-entry")
          return vinextWorker.fetch(request, env, ctx)
        }
        // The client resolves its files against /legacy/, so it needs the slash.
        if (path === "/legacy")
          return Response.redirect(new URL("/legacy/", request.url), 308)
        // Bitwarden's apps and browser extensions open the connector pages
        // (SSO, WebAuthn, Duo) at the site root, and the web client loads a
        // few images from there too; they are served from /legacy/.
        if (
          /^\/[a-z-]+-connector\.html$/.test(path) ||
          path.startsWith("/connectors/") ||
          path.startsWith("/images/")
        ) {
          const url = new URL(request.url)
          url.pathname = `/legacy${url.pathname}`
          return env.ASSETS.fetch(new Request(url, request))
        }
        if (path.startsWith("/api/"))
          return new Response("Not found", { status: 404 })
        return env.ASSETS.fetch(request)
      }
      const { default: vinextWorker } =
        await import("vinext/server/app-router-entry")
      return vinextWorker.fetch(request, env, ctx)
    })
  },
  async scheduled(_controller: ScheduledController, env: CloudflareEnv) {
    if (env.MAINTENANCE_MODE === "true") return
    try {
      await pruneVaultSsoFlows(env)
    } catch {
      console.error("SSO flow cleanup will retry")
    }
    try {
      await reconcileVaultDirectory(env)
    } catch {
      console.error("SCIM directory sync will retry")
    }
    for (const transfer of await pendingVaultShares(env)) {
      try {
        await completeVaultShare(env, transfer.cipherId)
      } catch {
        console.error("Cipher transfer will retry")
      }
    }
    for (const pending of await pendingOrgImports(env)) {
      try {
        await completeOrgImport(env, pending.id)
      } catch {
        console.error("Organization import will retry")
      }
    }
    try {
      await pruneOrgImports(env)
    } catch {
      console.error("Organization import cleanup will retry")
    }
    try {
      await pruneProtectedOtps(env)
    } catch {
      console.error("Protected-action code cleanup will retry")
    }
    try {
      await processEmergencyAccess(env)
    } catch {
      console.error("Emergency access processing will retry")
    }
    try {
      await prunePasskeyChallenges(env)
    } catch {
      console.error("Passkey challenge cleanup will retry")
    }
    try {
      await pruneVaultEmailChanges(env)
    } catch {
      console.error("Email-change code cleanup will retry")
    }
    try {
      await pruneAuthRequests(env)
    } catch {
      console.error("Auth request cleanup will retry")
    }
    for (const organization of await deletingOrganizations(env)) {
      try {
        await cleanupOrgDeletion(env, organization.id)
      } catch {
        console.error("Organization deletion cleanup will retry")
      }
    }
    for (const user of await deletingVaultUsers(env)) {
      try {
        await cleanupVaultDeletion(env, user.id)
      } catch {
        console.error("Vault deletion cleanup will retry")
      }
    }
  },
} satisfies ExportedHandler<CloudflareEnv>
