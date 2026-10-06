import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import test from "node:test"

import {
  discoverVaultOidc,
  redeemVaultOidc,
  ssoChallenge,
  ssoRandom,
  vaultOidcAuthorizeUrl,
} from "../apps/web/worker/bitwarden-oidc.ts"

const requireWeb = createRequire(resolve("apps/web/package.json"))
const { exportJWK, generateKeyPair, SignJWT } = await import(
  requireWeb.resolve("jose")
)
const issuer = "https://auth.example.test/api/auth"
const metadata = {
  issuer,
  authorization_endpoint: `${issuer}/oauth2/authorize`,
  token_endpoint: `${issuer}/oauth2/token`,
  jwks_uri: `${issuer}/jwks`,
}
const { privateKey, publicKey } = await generateKeyPair("RS256")
const jwk = {
  ...(await exportJWK(publicKey)),
  kid: "test-key",
  alg: "RS256",
  use: "sig",
}

function providerFetch(claims = {}) {
  return async (url, init) => {
    const parsed = new URL(url)
    assert.equal(init.redirect, "manual")
    if (parsed.pathname.endsWith("openid-configuration"))
      return Response.json(metadata)
    if (parsed.pathname.endsWith("/jwks")) return Response.json({ keys: [jwk] })
    assert.equal(parsed.pathname, "/api/auth/oauth2/token")
    assert.equal(init.method, "POST")
    assert.equal(
      new Headers(init.headers).get("Authorization"),
      `Basic ${btoa("tcp-vaultwarden:secret")}`
    )
    const form = new URLSearchParams(init.body)
    assert.equal(form.get("code_verifier"), "client-verifier")
    assert.equal(
      form.get("redirect_uri"),
      "https://vault.example.test/identity/connect/oidc-signin"
    )
    const idToken = await new SignJWT({
      email: "Member@Example.test",
      email_verified: true,
      name: "Member",
      nonce: "expected-nonce",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(issuer)
      .setAudience("tcp-vaultwarden")
      .setSubject("directory-user")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey)
    return Response.json({ access_token: "provider-access", id_token: idToken })
  }
}

test("OIDC uses the configured issuer, S256 PKCE, and a verified ID token", async () => {
  const fetcher = providerFetch()
  const provider = await discoverVaultOidc(issuer, fetcher)
  const challenge = await ssoChallenge("client-verifier")
  assert.match(challenge, /^[A-Za-z0-9_-]+$/)
  assert.equal(ssoRandom().length, 43)
  const url = vaultOidcAuthorizeUrl(
    provider,
    "tcp-vaultwarden",
    "https://vault.example.test/identity/connect/oidc-signin",
    "state",
    "expected-nonce",
    challenge
  )
  assert.equal(url.searchParams.get("code_challenge_method"), "S256")
  assert.equal(url.searchParams.get("nonce"), "expected-nonce")
  const identity = await redeemVaultOidc(
    provider,
    {
      clientId: "tcp-vaultwarden",
      clientSecret: "secret",
      redirectUri: "https://vault.example.test/identity/connect/oidc-signin",
      code: "provider-code",
      verifier: "client-verifier",
      nonce: "expected-nonce",
    },
    fetcher
  )
  assert.deepEqual(
    [identity.subject, identity.email, identity.name],
    ["directory-user", "member@example.test", "Member"]
  )
})

test("OIDC rejects unverified email, wrong nonce, and untrusted endpoints", async () => {
  const provider = await discoverVaultOidc(issuer, providerFetch())
  const input = {
    clientId: "tcp-vaultwarden",
    clientSecret: "secret",
    redirectUri: "https://vault.example.test/identity/connect/oidc-signin",
    code: "provider-code",
    verifier: "client-verifier",
    nonce: "expected-nonce",
  }
  await assert.rejects(
    redeemVaultOidc(provider, input, providerFetch({ email_verified: false })),
    /verified/
  )
  await assert.rejects(
    redeemVaultOidc(provider, input, providerFetch({ nonce: "wrong" })),
    /verified/
  )
  await assert.rejects(
    discoverVaultOidc("http://auth.example.test/api/auth", providerFetch()),
    /issuer/
  )
  await assert.rejects(
    discoverVaultOidc(issuer, async () =>
      Response.json({
        ...metadata,
        token_endpoint: "https://attacker.example.test/token",
      })
    ),
    /endpoint/
  )
})
