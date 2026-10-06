import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import test from "node:test"

const web = resolve("apps/web")
const requireWeb = createRequire(resolve(web, "package.json"))
const { createServer } = await import(requireWeb.resolve("vite"))
const { getPlatformProxy } = requireWeb("wrangler")

test("signed invitation can register a stub while public registration is disabled", async () => {
  const storage = mkdtempSync("/tmp/cloudwarden-invite-")
  let vite
  let proxy
  try {
    execFileSync(
      "pnpm",
      [
        "--filter",
        "web",
        "exec",
        "wrangler",
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        storage,
      ],
      { stdio: "pipe" }
    )
    proxy = await getPlatformProxy({
      configPath: resolve(web, "wrangler.jsonc"),
      persist: { path: resolve(storage, "v3") },
      remoteBindings: false,
      envFiles: [],
    })
    vite = await createServer({
      configFile: false,
      root: web,
      server: { middlewareMode: true },
      appType: "custom",
    })
    const auth = await vite.ssrLoadModule("/worker/bitwarden-auth.ts")
    const invite = await vite.ssrLoadModule("/worker/bitwarden-invite.ts")
    const { handleBitwarden } = await vite.ssrLoadModule("/worker/bitwarden.ts")
    const env = {
      ...proxy.env,
      BETTER_AUTH_SECRET: "local-invitation-test-signing-secret-2026",
      SIGNUPS_ALLOWED: "false",
    }
    const email = "invitee@example.test"
    const user = await auth.createVaultStubUser(env, email, "Invitee")
    const orgId = crypto.randomUUID()
    const memberId = crypto.randomUUID()
    const now = Date.now()
    await env.DB.prepare(
      "INSERT INTO vault_organization (id,name,billing_email,created_at,updated_at) VALUES (?,?,?,?,?)"
    )
      .bind(orgId, "Team", "owner@example.test", now, now)
      .run()
    await env.DB.prepare(
      "INSERT INTO vault_membership (id,org_id,user_id,role,status,access_all,created_at) VALUES (?,?,?,?,?,?,?)"
    )
      .bind(memberId, orgId, user.id, 2, 0, 0, now)
      .run()
    const token = await invite.issueOrgInviteToken(env, {
      email,
      orgId,
      memberId,
      userId: user.id,
    })
    const body = {
      email,
      name: "Invitee",
      masterPasswordHash: "client-secret",
      key: "2.user-key",
      keys: { encryptedPrivateKey: "2.private", publicKey: "public" },
      kdf: 0,
      kdfIterations: 600_000,
      organizationUserId: memberId,
      orgInviteToken: token,
    }
    const register = (data) =>
      handleBitwarden(
        new Request("https://vault.example.test/identity/accounts/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        }),
        env
      )
    assert.equal(
      (await register({ ...body, orgInviteToken: `${token}tampered` })).status,
      403
    )
    assert.equal((await register(body)).status, 200)
    const updated = await auth.findVaultUser(env, email)
    assert.equal(updated.id, user.id)
    assert.equal(updated.emailVerified, true)
    assert.equal(await auth.verifyVaultPassword(updated, "client-secret"), true)
    assert.equal((await register(body)).status, 409)
  } finally {
    await vite?.close()
    await proxy?.dispose()
    rmSync(storage, { recursive: true, force: true })
  }
})
