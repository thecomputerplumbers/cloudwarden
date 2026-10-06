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
const { exportJWK, generateKeyPair, SignJWT } = await import(
  requireWeb.resolve("jose")
)
const issuer = "https://auth.example.test/api/auth"
const callback = "https://vault.example.test/identity/connect/oidc-signin"
const connector = "https://vault.example.test/sso-connector.html"

test("SSO binds callback, verifies the provider, and bootstraps encrypted account keys", async () => {
  const storage = mkdtempSync("/tmp/cloudwarden-sso-")
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
    const sso = await vite.ssrLoadModule("/worker/bitwarden-sso.ts")
    const auth = await vite.ssrLoadModule("/worker/bitwarden-auth.ts")
    const env = {
      ...proxy.env,
      BETTER_AUTH_SECRET: "local-sso-test-signing-secret-2026-long",
      SSO_AUTHORITY: issuer,
      SSO_CLIENT_ID: "tcp-vaultwarden",
      SSO_CLIENT_SECRET: "provider-secret",
      SSO_IDENTIFIER: "thecomputerplumbers",
      SSO_CALLBACK_URL: callback,
    }
    const { privateKey, publicKey } = await generateKeyPair("RS256")
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "key1",
      alg: "RS256",
      use: "sig",
    }
    let providerNonce
    const fetcher = async (url, init) => {
      const path = new URL(url).pathname
      assert.equal(init.redirect, "manual")
      if (path.endsWith("openid-configuration"))
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/oauth2/authorize`,
          token_endpoint: `${issuer}/oauth2/token`,
          jwks_uri: `${issuer}/jwks`,
        })
      if (path.endsWith("/jwks")) return Response.json({ keys: [jwk] })
      assert.equal(path, "/api/auth/oauth2/token")
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        `Basic ${btoa("tcp-vaultwarden:provider-secret")}`
      )
      const form = new URLSearchParams(init.body)
      if (form.get("grant_type") === "refresh_token") {
        assert.equal(form.get("refresh_token"), "provider-refresh")
        return Response.json({
          access_token: "renewed-provider-access",
          refresh_token: "rotated-provider-refresh",
        })
      }
      assert.equal(form.get("code"), "provider-code")
      const idToken = await new SignJWT({
        email: "Member@Example.test",
        email_verified: true,
        name: "Member",
        nonce: providerNonce,
      })
        .setProtectedHeader({ alg: "RS256", kid: "key1" })
        .setIssuer(issuer)
        .setAudience("tcp-vaultwarden")
        .setSubject("auth-user-1")
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey)
      return Response.json({
        access_token: "provider-access",
        id_token: idToken,
        refresh_token: "provider-refresh",
      })
    }
    const prevalidate = await sso.prevalidateVaultSso(
      new Request(
        "https://vault.example.test/identity/sso/prevalidate?domainHint=thecomputerplumbers"
      ),
      env
    )
    assert.equal(prevalidate.status, 200)
    const ssoToken = (await prevalidate.json()).token
    const clientVerifier = "client-verifier"
    const challenge = await (
      await vite.ssrLoadModule("/worker/bitwarden-oidc.ts")
    ).ssoChallenge(clientVerifier)
    const startUrl = new URL(
      "https://vault.example.test/identity/connect/authorize"
    )
    for (const [key, value] of Object.entries({
      client_id: "web",
      redirect_uri: connector,
      state: "client-state",
      domain_hint: "thecomputerplumbers",
      code_challenge: challenge,
      code_challenge_method: "S256",
      ssoToken,
    }))
      startUrl.searchParams.set(key, value)
    const start = await sso.startVaultSso(new Request(startUrl), env, fetcher)
    assert.equal(start.status, 302)
    const binding = start.headers.get("Set-Cookie").split(";")[0]
    const authorization = new URL(start.headers.get("Location"))
    assert.equal(
      authorization.searchParams.get("code_challenge_method"),
      "S256"
    )
    providerNonce = authorization.searchParams.get("nonce")
    const flowId = authorization.searchParams.get("state")
    const callbackUrl = new URL(callback)
    callbackUrl.searchParams.set("state", flowId)
    callbackUrl.searchParams.set("code", "provider-code")
    assert.equal(
      (
        await sso.finishVaultSsoCallback(
          new Request(callbackUrl, {
            headers: { Cookie: "CW_SSO_BINDING=wrong" },
          }),
          env
        )
      ).status,
      400
    )
    const finished = await sso.finishVaultSsoCallback(
      new Request(callbackUrl, { headers: { Cookie: binding } }),
      env
    )
    assert.equal(finished.status, 302)
    assert.equal(
      new URL(finished.headers.get("Location")).searchParams.get("state"),
      "client-state"
    )
    await assert.rejects(
      sso.redeemVaultSso(
        env,
        flowId,
        "wrong-verifier",
        "web",
        connector,
        fetcher
      ),
      /Invalid SSO exchange/
    )
    const exchange = await sso.redeemVaultSso(
      env,
      flowId,
      clientVerifier,
      "web",
      connector,
      fetcher
    )
    const user = exchange.user
    assert.equal(exchange.refreshToken, "provider-refresh")
    assert.equal(user.email, "member@example.test")
    assert.equal(user.emailVerified, true)
    assert.equal(user.passwordHash, "")
    assert.equal(
      (
        await sso.redeemVaultSso(
          env,
          flowId,
          clientVerifier,
          "web",
          connector,
          fetcher
        )
      ).user.id,
      user.id
    )
    const setup = await auth.initializeVaultPassword(env, user.id, {
      masterPasswordHash: "client-derived-hash",
      key: "2.encrypted-key",
      privateKey: "2.encrypted-private",
      publicKey: "public-key",
      kdf: 0,
      kdfIterations: 600_000,
      kdfMemory: null,
      kdfParallelism: null,
    })
    assert.ok(setup)
    assert.equal(
      await auth.verifyVaultPassword(setup, "client-derived-hash"),
      true
    )
    assert.equal(
      await auth.initializeVaultPassword(env, user.id, {
        masterPasswordHash: "replacement",
        key: "key",
        privateKey: "private",
        publicKey: "public",
        kdf: 0,
        kdfIterations: 600_000,
        kdfMemory: null,
        kdfParallelism: null,
      }),
      undefined
    )
    const emailChange = await vite.ssrLoadModule(
      "/worker/bitwarden-email-change.ts"
    )
    assert.equal(
      await emailChange.requestVaultEmailChange(
        { ...env, EMAIL_FROM: "vault@example.test" },
        setup,
        "new@example.test"
      ),
      "managed"
    )
    assert.equal(
      await emailChange.completeVaultEmailChange(env, setup, {
        newEmail: "new@example.test",
        code: "123456",
        newPasswordHash: "new-secret",
        key: "2.new-key",
      }),
      "managed"
    )
    assert.equal(await sso.consumeVaultSso(env, flowId, user.id), true)
    assert.equal(await sso.consumeVaultSso(env, flowId, user.id), false)
    const session = await auth.issueVaultSession(
      env,
      user,
      "device",
      "web",
      "14",
      {
        sso: { issuer, refreshToken: exchange.refreshToken },
        deviceName: "SSO test device",
      }
    )
    const stored = await proxy.env.DB.prepare(
      "SELECT sso_refresh_token FROM vault_session WHERE user_id = ?"
    )
      .bind(user.id)
      .first()
    assert.ok(stored.sso_refresh_token)
    assert.ok(!stored.sso_refresh_token.includes("provider-refresh"))
    const renewed = await auth.refreshVaultSession(
      env,
      session.refresh,
      fetcher
    )
    assert.ok(renewed?.access)
    assert.equal(
      await auth.refreshVaultSession(env, session.refresh, fetcher),
      null
    )
    assert.equal(
      await auth.refreshVaultSession(env, renewed.refresh, async (url, init) =>
        new URL(url).pathname.endsWith("openid-configuration")
          ? fetcher(url, init)
          : new Response("", { status: 401 })
      ),
      null
    )
    await assert.rejects(
      sso.redeemVaultSso(
        env,
        flowId,
        clientVerifier,
        "web",
        connector,
        fetcher
      ),
      /Invalid SSO exchange/
    )
    for (const [clientId, redirect] of [
      ["desktop", "bitwarden://sso-callback"],
      ["mobile", "bitwarden://sso-callback"],
      ["cli", "http://localhost:4321"],
    ]) {
      const nativeUrl = new URL(startUrl)
      nativeUrl.searchParams.set("client_id", clientId)
      nativeUrl.searchParams.set("redirect_uri", redirect)
      const started = await sso.startVaultSso(
        new Request(nativeUrl),
        env,
        fetcher
      )
      assert.equal(started.status, 302)
      const nativeAuthorization = new URL(started.headers.get("Location"))
      providerNonce = nativeAuthorization.searchParams.get("nonce")
      const nativeFlowId = nativeAuthorization.searchParams.get("state")
      const nativeCallback = new URL(callback)
      nativeCallback.searchParams.set("state", nativeFlowId)
      nativeCallback.searchParams.set("code", "provider-code")
      const nativeFinished = await sso.finishVaultSsoCallback(
        new Request(nativeCallback, {
          headers: { Cookie: started.headers.get("Set-Cookie").split(";")[0] },
        }),
        env
      )
      assert.equal(nativeFinished.status, 302)
      const nativeDestination = new URL(nativeFinished.headers.get("Location"))
      assert.equal(nativeDestination.protocol, new URL(redirect).protocol)
      assert.equal(nativeDestination.searchParams.get("code"), nativeFlowId)
      await assert.rejects(
        sso.redeemVaultSso(
          env,
          nativeFlowId,
          clientVerifier,
          "web",
          redirect,
          fetcher
        ),
        /Invalid SSO exchange/
      )
      await assert.rejects(
        sso.redeemVaultSso(
          env,
          nativeFlowId,
          clientVerifier,
          clientId,
          connector,
          fetcher
        ),
        /Invalid SSO exchange/
      )
      assert.equal(
        (
          await sso.redeemVaultSso(
            env,
            nativeFlowId,
            clientVerifier,
            clientId,
            redirect,
            fetcher
          )
        ).user.id,
        user.id
      )
      assert.equal(await sso.consumeVaultSso(env, nativeFlowId, user.id), true)
    }
    for (const [clientId, redirect] of [
      ["web", "https://evil.example.test/sso-connector.html"],
      ["desktop", "bitwarden://evil-callback"],
      ["cli", "http://127.0.0.1:4321"],
      ["cli", "http://localhost:12345"],
      ["unknown", connector],
    ]) {
      const unsafeUrl = new URL(startUrl)
      unsafeUrl.searchParams.set("client_id", clientId)
      unsafeUrl.searchParams.set("redirect_uri", redirect)
      assert.equal(
        (await sso.startVaultSso(new Request(unsafeUrl), env, fetcher)).status,
        400
      )
    }
  } finally {
    await vite?.close()
    await proxy?.dispose()
    rmSync(storage, { recursive: true, force: true })
  }
})
