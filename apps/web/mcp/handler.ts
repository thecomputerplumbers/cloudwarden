import product from "@/config/product.json"
import { publicError } from "@/lib/errors"
import { logError, requestId } from "@/lib/diagnostics"
import {
  listProjects,
  getProject,
  createProject,
  updateProject,
  projectCreateInput,
  projectUpdateInput,
} from "@/operations/projects"
async function execute(operation: () => Promise<Record<string, unknown>>) {
  try {
    return toolResult(await operation())
  } catch (error) {
    logError(error, "mcp.tool")
    const result = { ...publicError(error), requestId: requestId() }
    return { ...toolResult(result), isError: true }
  }
}
import { env } from "cloudflare:workers"
import { createMcpEndpoint, toolResult } from "@workspace/mcp"
import { authenticateMcp, mcpAuthError } from "@workspace/auth/mcp"
import { z } from "zod"
import { auth } from "@/lib/auth"
import { getDb } from "@/db"
import { stripeConfig } from "@/lib/stripe"
import {
  currentUser,
  currentOrganization,
  billingStatus,
  renameOrganization,
} from "@/operations/organization"

export async function handleMcp(request: Request) {
  const resource = `${env.APP_URL}/mcp`
  const origin = request.headers.get("origin")
  if (origin && origin !== env.APP_URL)
    return new Response("Origin not allowed", { status: 403 })
  const db = getDb()
  try {
    const actor = await authenticateMcp(request, auth, db, resource)
    const budget = await env.APP_DATABASE.getByName(
      `mcp:${actor.userId}`
    ).consumeRateLimit("requests", 120, 60_000)
    if (!budget.allowed)
      return new Response("Too many requests", {
        status: 429,
        headers: { "Retry-After": "60" },
      })
    const context = { db, actor }
    const read = {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    }
    return createMcpEndpoint(
      (server) => {
        server.registerTool(
          "get_current_user",
          {
            description: "Get the signed-in account for this connection.",
            inputSchema: z.object({}),
            annotations: read,
          },
          async () => execute(() => currentUser(context))
        )
        server.registerTool(
          "list_organizations",
          {
            description:
              "List the organization authorized for this connection.",
            inputSchema: z.object({}),
            annotations: read,
          },
          async () => execute(() => currentOrganization(context))
        )
        if (product.features.billing)
          server.registerTool(
            "get_billing_status",
            {
              description:
                "Read subscription and entitlement status for the authorized organization.",
              inputSchema: z.object({}),
              annotations: read,
            },
            async () =>
              execute(() => billingStatus(context, stripeConfig().livemode))
          )
        server.registerTool(
          "rename_organization",
          {
            description:
              "Rename the authorized organization. Requires an admin and organization:write permission. Reuse requestId only when retrying the same change.",
            inputSchema: z.object({
              name: z.string().trim().min(1).max(100),
              requestId: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
            }),
            annotations: {
              readOnlyHint: false,
              destructiveHint: false,
              idempotentHint: true,
              openWorldHint: false,
            },
          },
          async (input) => execute(() => renameOrganization(context, input))
        )
        if (product.features.projects) {
          server.registerTool(
            "list_projects",
            {
              description:
                "List projects in the authorized organization, with cursor pagination.",
              inputSchema: z.object({
                after: z.uuid().optional(),
                limit: z.number().int().min(1).max(50).optional(),
              }),
              annotations: read,
            },
            async (input) => execute(() => listProjects(context, input))
          )
          server.registerTool(
            "get_project",
            {
              description: "Read one project in the authorized organization.",
              inputSchema: z.object({ id: z.uuid() }),
              annotations: read,
            },
            async (input) => execute(() => getProject(context, input.id))
          )
          server.registerTool(
            "create_project",
            {
              description:
                "Create a project. Admin only. Supply a new UUID id; retries must reuse the same id and payload.",
              inputSchema: projectCreateInput,
              annotations: { ...read, readOnlyHint: false },
            },
            async (input) => execute(() => createProject(context, input))
          )
          server.registerTool(
            "update_project",
            {
              description:
                "Edit or archive a project. Admin only. Supply its current version; conflicts require reloading.",
              inputSchema: projectUpdateInput,
              annotations: {
                ...read,
                readOnlyHint: false,
                idempotentHint: false,
              },
            },
            async (input) => execute(() => updateProject(context, input))
          )
        }
      },
      { name: product.slug, version: "1.0.0" }
    )(request)
  } catch (error) {
    return mcpAuthError(error, resource)
  }
}
