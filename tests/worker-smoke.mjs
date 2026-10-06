// Apply migrations and start the built Worker locally with --persist-to <state>,
// --var APP_URL:<origin>, and stdout redirected to <state>/worker.log.
// Usage: node tests/worker-smoke.mjs http://localhost:3101 /tmp/starter-review.XXXXXX
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setTimeout as delay } from "node:timers/promises"
const [origin, storage] = process.argv.slice(2)
assert.equal(new URL(origin).hostname, "localhost")
assert.ok(storage?.startsWith("/tmp/starter-review."))
function browser() {
  const cookies = new Map()
  return async (path, body, extra = {}) => {
    const response = await fetch(new URL(path, origin), {
      method: body ? "POST" : "GET",
      redirect: "manual",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        ...extra,
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    for (const cookie of response.headers.getSetCookie()) {
      const first = cookie.split(";")[0],
        i = first.indexOf("=")
      cookies.set(first.slice(0, i), first.slice(i + 1))
    }
    return response
  }
}
async function json(response, status = 200) {
  assert.equal(response.status, status, await response.clone().text())
  return response.json()
}
async function mail(email, subject) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const log = readFileSync(`${storage}/worker.log`, "utf8")
    const messages = log
      .split("send_email binding called with MessageBuilder:")
      .slice(1)
    const match = messages
      .reverse()
      .find(
        (message) =>
          message.includes(`To: ${email}\n`) &&
          message.includes(`Subject: ${subject}\n`)
      )
    const path = match?.match(/Text: (.+)\n/)?.[1]
    if (path) return readFileSync(path, "utf8")
    await delay(100)
  }
  throw new Error(`Missing local ${subject} email`)
}
async function signup(name) {
  const request = browser(),
    email = `${name}-${crypto.randomUUID()}@example.org`,
    password = crypto.randomUUID()
  const result = await json(
    await request("/api/auth/sign-up/email", {
      email,
      password,
      name,
      callbackURL: "/onboarding",
    })
  )
  assert.equal(result.token, null)
  assert.equal(
    (await request("/api/auth/sign-in/email", { email, password })).status,
    403
  )
  const text = await mail(email, "Verify your email"),
    url = text.match(/https?:\/\/\S+/)[0]
  const verified = await request(url)
  assert.equal(verified.status, 302)
  return { request, email, password, user: result.user }
}
const owner = await signup("owner"),
  member = await signup("member")
const org = await json(
  await owner.request("/api/auth/organization/create", {
    name: "Smoke organization",
    slug: `smoke-${crypto.randomUUID()}`,
  })
)
await json(await owner.request("/api/auth/sign-out", {}))
await json(
  await owner.request("/api/auth/sign-in/email", {
    email: owner.email,
    password: owner.password,
  })
)
let returning = await owner.request("/billing")
assert.equal(returning.status, 307)
assert.equal(returning.headers.get("location"), "/onboarding")
assert.ok(
  (await (await owner.request("/onboarding")).text()).includes(
    "Smoke organization"
  )
)
await json(
  await owner.request("/api/auth/organization/set-active", {
    organizationId: org.id,
  })
)
assert.equal((await owner.request("/billing")).status, 200)
await json(
  await owner.request("/api/organization", {
    organizationId: org.id,
    name: "Browser rename",
    requestId: crypto.randomUUID(),
  })
)
console.log("Verified signup and local Cloudflare email delivery passed.")
let response = await fetch(`${origin}/mcp`, { method: "POST" })
assert.equal(response.status, 401)
assert.match(response.headers.get("www-authenticate"), /resource_metadata/)
const metadata = await json(
  await fetch(`${origin}/.well-known/oauth-protected-resource`)
)
assert.equal(metadata.resource, `${origin}/mcp`)
const serverMetadata = await json(
  await fetch(`${origin}/.well-known/oauth-authorization-server/api/auth`)
)
const redirectUri = "https://client.example/callback"
const client = await json(
  await fetch(serverMetadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Smoke client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope:
        "openid profile email offline_access organization:read organization:write billing:read projects:read projects:write",
    }),
  }),
  201
)
async function connect(
  account,
  organizationId,
  scope = "openid profile email offline_access organization:read organization:write billing:read projects:read projects:write"
) {
  const verifier = crypto.randomUUID() + crypto.randomUUID()
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
  ).toString("base64url")
  const query = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: crypto.randomUUID(),
    resource: `${origin}/mcp`,
  })
  const authorization = await account.request(
    `${serverMetadata.authorization_endpoint}?${query}`
  )
  assert.ok([200, 302].includes(authorization.status))
  const location =
    authorization.status === 200
      ? (await authorization.json()).url
      : authorization.headers.get("location")
  const consentUrl = new URL(location, origin)
  assert.equal(consentUrl.pathname, "/connect")
  assert.equal(
    (
      await account.request("/api/connect", {
        accept: true,
        organizationId: crypto.randomUUID(),
        oauthQuery: consentUrl.search.slice(1),
      })
    ).status,
    400
  )
  const tampered = new URLSearchParams(consentUrl.search)
  tampered.set("scope", "organization:write")
  assert.equal(
    (
      await account.request("/api/connect", {
        accept: true,
        organizationId,
        oauthQuery: tampered.toString(),
      })
    ).status,
    400
  )
  const consent = await json(
    await account.request("/api/connect", {
      accept: true,
      organizationId,
      oauthQuery: consentUrl.search.slice(1),
    })
  )
  const code = new URL(consent.url).searchParams.get("code")
  assert.ok(code)
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: client.client_id,
    redirect_uri: redirectUri,
    code,
    code_verifier: verifier,
    resource: `${origin}/mcp`,
  })
  const tokens = await json(
    await fetch(serverMetadata.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    })
  )
  assert.ok(tokens.access_token)
  return tokens
}
async function rpc(token, name, args = {}) {
  const result = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": name === "list" ? "tools/list" : "tools/call",
      ...(name === "list" ? {} : { "Mcp-Name": name }),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: name === "list" ? "tools/list" : "tools/call",
      params: {
        ...(name === "list" ? {} : { name, arguments: args }),
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  })
  return result
}
let tokens = await connect(owner, org.id)
response = await rpc(tokens.access_token, "list")
const listed = await json(response)
assert.ok(
  listed.result.tools.some((tool) => tool.name === "rename_organization")
)
let result = await json(await rpc(tokens.access_token, "get_current_user"))
assert.equal(result.result.structuredContent.user.id, owner.user.id)
const refreshed = await json(
  await fetch(serverMetadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
      resource: `${origin}/mcp`,
    }),
  })
)
assert.ok(refreshed.access_token)
tokens = refreshed
assert.equal(
  (
    await rpc(
      `${tokens.access_token.slice(0, -10)}invalidjwt`,
      "get_current_user"
    )
  ).status,
  401
)
result = await json(await rpc(tokens.access_token, "get_billing_status"))
assert.equal(result.result.structuredContent.entitled, false)
const requestId = crypto.randomUUID()
for (let i = 0; i < 2; i++) {
  result = await json(
    await rpc(tokens.access_token, "rename_organization", {
      name: "Renamed by MCP",
      requestId,
    })
  )
  assert.equal(result.result.structuredContent.name, "Renamed by MCP")
}
console.log(
  "OAuth discovery, PKCE, consent, MCP reads and idempotent mutation passed."
)
const writeOnlyTokens = await connect(owner, org.id, "projects:write")
const writeOnlyResult = await json(
  await rpc(writeOnlyTokens.access_token, "create_project", {
    id: crypto.randomUUID(),
    name: "Write-only token project",
  })
)
assert.equal(writeOnlyResult.result.isError, undefined)
const projectId = crypto.randomUUID()
let projectResult = await json(
  await rpc(tokens.access_token, "create_project", {
    id: projectId,
    name: "MCP project",
    description: "A real project",
  })
)
assert.equal(projectResult.result.structuredContent.name, "MCP project")
projectResult = await json(
  await rpc(tokens.access_token, "create_project", {
    id: projectId,
    name: "MCP project",
    description: "A real project",
  })
)
assert.equal(projectResult.result.structuredContent.version, 1)
projectResult = await json(
  await rpc(tokens.access_token, "update_project", {
    id: projectId,
    name: "Updated project",
    description: "A real project",
    status: "archived",
    version: 1,
  })
)
assert.equal(projectResult.result.structuredContent.version, 2)
projectResult = await json(
  await rpc(tokens.access_token, "update_project", {
    id: projectId,
    name: "Stale update",
    version: 1,
  })
)
assert.equal(projectResult.result.structuredContent.code, "CONFLICT")
const invalidProject = await owner.request("/api/projects", {
  organizationId: org.id,
  id: crypto.randomUUID(),
  name: " ",
})
assert.equal(invalidProject.status, 400)
assert.ok(invalidProject.headers.get("x-request-id"))
assert.ok((await invalidProject.json()).fields.name)
const browserProject = await json(
  await owner.request("/api/projects", {
    organizationId: org.id,
    id: crypto.randomUUID(),
    name: "Browser project",
  })
)
const firstPage = await json(
  await owner.request(`/api/projects?organizationId=${org.id}&limit=1`)
)
assert.equal(firstPage.items.length, 1)
assert.ok(firstPage.nextCursor)
const secondPage = await json(
  await owner.request(
    `/api/projects?organizationId=${org.id}&limit=1&after=${firstPage.nextCursor}`
  )
)
assert.equal(secondPage.items.length, 1)
assert.notEqual(firstPage.items[0].id, secondPage.items[0].id)
assert.equal(
  (await owner.request(`/projects/${browserProject.id}`)).status,
  200
)
assert.equal(
  (await owner.request(`/projects/${crypto.randomUUID()}`)).status,
  404
)
const otherOrg = await json(
  await member.request("/api/auth/organization/create", {
    name: "Other organization",
    slug: `other-${crypto.randomUUID()}`,
  })
)
assert.equal(
  (
    await member.request(
      `/api/projects?organizationId=${otherOrg.id}&id=${projectId}`
    )
  ).status,
  404
)
assert.equal(
  (
    await member.request(
      `/api/projects?organizationId=${org.id}&id=${projectId}`
    )
  ).status,
  403
)
console.log(
  "Project creation, edits, pagination, conflict protection and organization isolation passed."
)
const invitation = await json(
  await owner.request("/api/auth/organization/invite-member", {
    organizationId: org.id,
    email: member.email,
    role: "member",
  })
)
const invitationMail = await mail(member.email, "Invitation to Renamed by MCP")
assert.ok(invitationMail.includes(`/invitations/${invitation.id}`))
assert.ok(
  (
    await owner.request("/api/auth/organization/accept-invitation", {
      invitationId: invitation.id,
    })
  ).status >= 400
)
await json(
  await member.request("/api/auth/organization/accept-invitation", {
    invitationId: invitation.id,
  })
)
await json(
  await member.request("/api/auth/organization/set-active", {
    organizationId: org.id,
  })
)
const memberTokens = await connect(
  member,
  org.id,
  "openid offline_access organization:read billing:read projects:read"
)
result = await json(await rpc(memberTokens.access_token, "get_current_user"))
assert.equal(result.result.structuredContent.user.name, undefined)
assert.equal(result.result.structuredContent.user.email, undefined)
result = await json(
  await rpc(memberTokens.access_token, "rename_organization", {
    name: "Should fail",
    requestId: crypto.randomUUID(),
  })
)
assert.equal(result.result.isError, true)
projectResult = await json(
  await rpc(memberTokens.access_token, "list_projects")
)
assert.equal(projectResult.result.structuredContent.items.length, 3)
projectResult = await json(
  await rpc(memberTokens.access_token, "create_project", {
    id: crypto.randomUUID(),
    name: "Forbidden",
  })
)
assert.equal(projectResult.result.structuredContent.code, "FORBIDDEN")
assert.equal(
  (
    await member.request("/api/projects", {
      organizationId: org.id,
      id: crypto.randomUUID(),
      name: "Forbidden",
    })
  ).status,
  403
)
await json(
  await owner.request("/api/auth/organization/remove-member", {
    organizationId: org.id,
    memberIdOrEmail: member.email,
  })
)
assert.equal(
  (await rpc(memberTokens.access_token, "get_current_user")).status,
  401
)
response = await member.request("/billing")
assert.equal(response.status, 307)
assert.equal(response.headers.get("location"), "/onboarding")
assert.ok(
  (
    await owner.request("/api/auth/organization/leave", {
      organizationId: org.id,
    })
  ).status >= 400
)
assert.equal(
  (await member.request("/api/stripe/checkout", { plan: "pro-monthly" }))
    .status,
  403
)
console.log(
  "Invitation delivery, acceptance, denied mutation, membership removal and last-owner protection passed."
)
const claims = JSON.parse(
  Buffer.from(tokens.access_token.split(".")[1], "base64url").toString()
)
await json(await owner.request("/api/connections", { id: claims.grant_id }))
assert.equal((await rpc(tokens.access_token, "get_current_user")).status, 401)
response = await fetch(serverMetadata.token_endpoint, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "refresh_token",
    client_id: client.client_id,
    refresh_token: tokens.refresh_token,
    resource: `${origin}/mcp`,
  }),
})
assert.ok(response.status >= 400)
console.log(
  "Connected-app revocation blocks existing access and refresh tokens."
)
const another = browser()
await json(
  await another("/api/auth/sign-in/email", {
    email: owner.email,
    password: owner.password,
  })
)
const current = await json(await another("/api/auth/get-session"))
await json(
  await owner.request("/api/account/sessions", { id: current.session.id })
)
assert.equal(await json(await another("/api/auth/get-session")), null)
await json(
  await member.request("/api/auth/request-password-reset", {
    email: member.email,
    redirectTo: `${origin}/reset-password`,
  })
)
const resetMail = await mail(member.email, "Reset your password")
const resetLink = resetMail.match(/https?:\/\/\S+/)[0]
const resetRedirect = await member.request(resetLink)
const resetToken = new URL(
  resetRedirect.headers.get("location"),
  origin
).searchParams.get("token")
const password = crypto.randomUUID()
await json(
  await member.request("/api/auth/reset-password", {
    token: resetToken,
    newPassword: password,
  })
)
assert.ok(
  (
    await member.request("/api/auth/reset-password", {
      token: resetToken,
      newPassword: crypto.randomUUID(),
    })
  ).status >= 400
)
assert.ok(
  (
    await browser()("/api/auth/sign-in/email", {
      email: member.email,
      password: member.password,
    })
  ).status >= 400
)
await json(
  await browser()("/api/auth/sign-in/email", { email: member.email, password })
)
for (const path of ["/account", "/team", "/connections"])
  assert.equal((await owner.request(path)).status, 200, path)
console.log(
  "Session revocation, password recovery, single-use reset and account screens passed."
)
