import product from "../config/product.json"
import { observeRequest } from "../lib/diagnostics"
import vinextWorker from "vinext/server/app-router-entry"

export { AppDatabase } from "./database"

import { auth } from "../lib/auth"
import { handleMcp } from "../mcp/handler"
import { handleBitwarden, isBitwardenPath } from "./bitwarden"
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
  organizationNotificationTargets,
  publishOrganizationSync,
  publishVaultNotification,
} from "./bitwarden-notifications"

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    return observeRequest(request, async () => {
      const path = new URL(request.url).pathname
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
        const cipherId =
          user && path.match(/^\/api\/ciphers\/([0-9a-f-]{36})(?:\/|$)/i)?.[1]
        const beforeLocator = cipherId
          ? await getOrgCipherLocator(env, cipherId)
          : null
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
        const response = await handleBitwarden(request, env)
        if (user && response.ok) {
          try {
            if (vaultMutation)
              await publishVaultNotification(env, { type: 5, userId: user.id })
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
            if (cipherId) {
              const afterLocator = await getOrgCipherLocator(env, cipherId)
              if (afterLocator)
                add(afterLocator.orgId, afterLocator.collectionIds)
            }
            if (path === "/api/ciphers/import-organization")
              add(new URL(request.url).searchParams.get("organizationId"), null)
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
            if (path === "/api/ciphers" && request.method === "POST") {
              const body = (await response
                .clone()
                .json()
                .catch(() => null)) as {
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
                const body = (await response
                  .clone()
                  .json()
                  .catch(() => null)) as { id?: string } | null
                add(body?.id, null)
              }
            }
            for (const [orgId, collections] of notices)
              await publishOrganizationSync(
                env,
                orgId,
                collections ? [...collections] : null
              )
            if (orgIdFromPath && beforeMembers.length) {
              const afterMembers = new Set(
                await organizationNotificationTargets(env, orgIdFromPath, null)
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
      if (path === "/mcp") return handleMcp(request)
      if (path.startsWith("/.well-known/")) return auth.handler(request)
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
