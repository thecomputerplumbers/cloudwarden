# @workspace/mcp

The official MCP server SDK, adapted to a native Worker Request/Response handler.
`createMcpEndpoint` creates a server per request: it never shares a user's
identity, transport, or tool closures with another request. The SDK supplies
Streamable HTTP and protocol negotiation; there is no separate Node server.

## Structure

- `packages/mcp`: transport and result helpers, with no application imports.
- `packages/auth`: OAuth provider, signing keys, client registration, consent,
  organization grants, token validation and revocation checks.
- `apps/web/mcp/handler.ts`: authenticate, enforce origin and request budget,
  then register the application's tools.
- `apps/web/operations`: business operations used by MCP and browser routes.
  Put membership, scope, validation and mutation rules here, not in a tool.
- `apps/web/worker/index.ts`: dispatch `/mcp` and discovery before vinext.

## Connect

Point an OAuth-capable MCP client at `https://YOUR_APP/mcp`. Discovery is at
`/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server/api/auth`. The provider supports
public dynamic client registration, authorization code with PKCE, and refresh
tokens. Users sign in, verify their email, select an organization and approve
the listed scopes. Clients must explicitly request `organization:write` or `projects:write`.

CIMD URL client IDs are not enabled. Add them only with a Worker-compatible
SSRF-safe metadata fetch implementation; ordinary `fetch` is insufficient.
Cross-origin browser MCP calls are rejected; native clients do not send an
Origin header. Add an explicit trusted-origin policy and CORS handling if a
product needs browser-hosted external clients.

## Tools and scopes

| Tool                               | Required scope       | Role           |
| ---------------------------------- | -------------------- | -------------- |
| `get_current_user`                 | `organization:read`  | Member         |
| `list_organizations`               | `organization:read`  | Member         |
| `get_billing_status`               | `billing:read`       | Member         |
| `list_projects`, `get_project`     | `projects:read`      | Member         |
| `create_project`, `update_project` | `projects:write`     | Admin or owner |
| `rename_organization`              | `organization:write` | Admin or owner |

`profile` and `email` govern whether the account tool returns those fields.
`list_organizations` lists only the organization approved for this grant.
Rename requires a caller-generated `requestId`; retry the same payload with the
same ID. Its audit receipt and write commit atomically in D1. Reusing an ID for
a different payload fails. Tool annotations describe read/write and retry behavior.

JWT access tokens expire after five minutes. Every request also checks the
stored grant, consent, verified account and current organization membership.
Changing a browser's active organization cannot change a grant. `/connections`
revokes the grant, consent and refresh tokens; already-issued JWTs stop working
immediately. The Durable Object limits authenticated MCP requests per user.

## Validation

`pnpm test:worker` builds, migrates a fresh local D1, starts Wrangler, exercises
OAuth and real MCP requests plus account lifecycle flows, then stops the Worker
and removes its state. Mail uses Cloudflare's local simulation. No external
client or real email account is required. Failures retain local diagnostics.
