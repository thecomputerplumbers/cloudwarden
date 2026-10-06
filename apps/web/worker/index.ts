import product from "../config/product.json"
import { observeRequest } from "../lib/diagnostics"
import vinextWorker from "vinext/server/app-router-entry"

export { AppDatabase } from "./database"

import { auth } from "../lib/auth"
import { handleMcp } from "../mcp/handler"

export default {
  async fetch(request: Request, env: CloudflareEnv, ctx: ExecutionContext) {
    return observeRequest(request, async () => {
      const path = new URL(request.url).pathname
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
} satisfies ExportedHandler<CloudflareEnv>
