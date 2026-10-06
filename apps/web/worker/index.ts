import product from "../config/product.json"
import { observeRequest } from "../lib/diagnostics"
import vinextWorker from "vinext/server/app-router-entry"

export { AppDatabase } from "./database"

import { auth } from "../lib/auth"
import { handleMcp } from "../mcp/handler"
import { handleBitwarden, isBitwardenPath } from "./bitwarden"
import { deletingVaultUsers } from "./bitwarden-auth"
import { cleanupVaultDeletion } from "./bitwarden-delete"
import { reconcileVaultDirectory } from "./bitwarden-directory-sync"
import { pruneVaultSsoFlows } from "./bitwarden-sso"
import { cleanupOrgDeletion, deletingOrganizations } from "./bitwarden-org"
import { completeVaultShare, pendingVaultShares } from "./bitwarden-share"
import {
  completeOrgImport,
  pendingOrgImports,
  pruneOrgImports,
} from "./bitwarden-org-import"
import { pruneProtectedOtps } from "./bitwarden-protected-otp"

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    return observeRequest(request, async () => {
      const path = new URL(request.url).pathname
      if (isBitwardenPath(path)) return handleBitwarden(request, env)
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
