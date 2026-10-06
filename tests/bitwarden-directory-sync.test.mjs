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
const source =
  "https://auth.thecomputerplumbers.com/api/integrations/vault/scim/v2/Users"
const externalId = "41850bc4-fe8c-42cd-97c4-88a61cfaa3a5"
const ownerId = crypto.randomUUID()
const targetId = crypto.randomUUID()
const manualId = crypto.randomUUID()
const orgId = crypto.randomUUID()
const now = Date.now()

test("SCIM sync links only new members and revokes only directory owned access", async () => {
  const storage = mkdtempSync("/tmp/cloudwarden-scim-")
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
    const { reconcileVaultDirectory } = await vite.ssrLoadModule(
      "/worker/bitwarden-directory-sync.ts"
    )
    const { setOrgMemberCollections } = await vite.ssrLoadModule(
      "/worker/bitwarden-org.ts"
    )
    const db = proxy.env.DB
    const user = async (id, email) =>
      db
        .prepare(
          `INSERT INTO vault_user (id,email,name,password_hash,password_salt,key,public_key,kdf,kdf_iterations,security_stamp,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .bind(
          id,
          email,
          email,
          "hash",
          "salt",
          "key",
          "public-key",
          0,
          600000,
          crypto.randomUUID(),
          now,
          now
        )
        .run()
    await user(ownerId, "owner@example.test")
    await user(targetId, "target@example.test")
    await user(manualId, "manual@example.test")
    await db
      .prepare(
        `INSERT INTO vault_organization (id,name,billing_email,created_at,updated_at) VALUES (?,?,?,?,?)`
      )
      .bind(orgId, "Test", "owner@example.test", now, now)
      .run()
    const membership = async (id, userId, role, status) =>
      db
        .prepare(
          `INSERT INTO vault_membership (id,org_id,user_id,key,role,status,access_all,created_at) VALUES (?,?,?,?,?,?,?,?)`
        )
        .bind(id, orgId, userId, "wrapped-key", role, status, 1, now)
        .run()
    await membership(crypto.randomUUID(), ownerId, 0, 2)
    const manualMembershipId = crypto.randomUUID()
    await membership(manualMembershipId, manualId, 2, 2)
    const env = {
      ...proxy.env,
      SCIM_DIRECTORY_URL: source,
      SCIM_TOKEN: "local-token",
      SCIM_ORGANIZATION_ID: orgId,
      SCIM_INVITATIONS_ENABLED: "true",
    }
    const scimUser = {
      id: externalId,
      userName: "target@example.test",
      displayName: "Target",
      active: true,
    }
    const snapshot = (resources) => async () =>
      Response.json({
        totalResults: resources.length,
        startIndex: 1,
        itemsPerPage: resources.length,
        Resources: resources,
        "urn:thecomputerplumbers:scim:directoryVersion": "v1",
      })
    await reconcileVaultDirectory(env, snapshot([scimUser]))
    const linked = await db
      .prepare(`SELECT * FROM vault_directory_identity WHERE org_id = ?`)
      .bind(orgId)
      .first()
    assert.equal(linked.email, "target@example.test")
    const pending = await db
      .prepare(`SELECT * FROM vault_membership WHERE id = ?`)
      .bind(linked.membership_id)
      .first()
    assert.equal(pending.status, 1)
    assert.equal(pending.access_all, 0)
    await reconcileVaultDirectory(env, snapshot([scimUser]))
    assert.equal(
      (
        await db
          .prepare(
            `SELECT count(*) AS n FROM vault_membership WHERE org_id = ?`
          )
          .bind(orgId)
          .first()
      ).n,
      3
    )
    await db
      .prepare(`UPDATE vault_membership SET status = 2, key = ? WHERE id = ?`)
      .bind("wrapped", linked.membership_id)
      .run()
    const mappedCollectionId = crypto.randomUUID()
    const manualCollectionId = crypto.randomUUID()
    for (const [id, name, external] of [
      [mappedCollectionId, "Engineering", "engineering"],
      [manualCollectionId, "Manual", null],
    ])
      await db
        .prepare(
          `INSERT INTO vault_collection (id,org_id,name,external_id,created_at,updated_at) VALUES (?,?,?,?,?,?)`
        )
        .bind(id, orgId, name, external, now, now)
        .run()
    await db
      .prepare(
        `INSERT INTO vault_collection_member (collection_id,membership_id,read_only,hide_passwords) VALUES (?,?,?,?)`
      )
      .bind(manualCollectionId, linked.membership_id, 1, 0)
      .run()
    const groupUser = {
      ...scimUser,
      groups: [{ value: "engineering", display: "Engineering" }],
    }
    const groupNotifications = []
    const recordGroupNotification = async (userId) => {
      groupNotifications.push(userId)
    }
    await reconcileVaultDirectory(
      env,
      snapshot([groupUser]),
      recordGroupNotification
    )
    assert.deepEqual(groupNotifications, [targetId])
    assert.deepEqual(
      (
        await db
          .prepare(
            `SELECT collection_id FROM vault_directory_collection_grant WHERE membership_id = ?`
          )
          .bind(linked.membership_id)
          .all()
      ).results.map((row) => row.collection_id),
      [mappedCollectionId]
    )
    assert.deepEqual(
      (
        await db
          .prepare(
            `SELECT collection_id FROM vault_collection_member WHERE membership_id = ? ORDER BY collection_id`
          )
          .bind(linked.membership_id)
          .all()
      ).results.map((row) => row.collection_id),
      [mappedCollectionId, manualCollectionId].sort()
    )
    groupNotifications.length = 0
    await reconcileVaultDirectory(
      env,
      snapshot([
        {
          ...groupUser,
          groups: [],
        },
      ]),
      recordGroupNotification
    )
    assert.deepEqual(groupNotifications, [targetId])
    assert.deepEqual(
      (
        await db
          .prepare(
            `SELECT collection_id FROM vault_collection_member WHERE membership_id = ?`
          )
          .bind(linked.membership_id)
          .all()
      ).results.map((row) => row.collection_id),
      [manualCollectionId]
    )
    await reconcileVaultDirectory(env, snapshot([groupUser]))
    assert.equal(
      await setOrgMemberCollections(env, orgId, linked.membership_id, [
        { id: mappedCollectionId, readOnly: true, hidePasswords: false },
        { id: manualCollectionId, readOnly: true, hidePasswords: false },
      ]),
      true
    )
    await reconcileVaultDirectory(env, snapshot([{ ...groupUser, groups: [] }]))
    assert.deepEqual(
      (
        await db
          .prepare(
            `SELECT collection_id FROM vault_collection_member WHERE membership_id = ? ORDER BY collection_id`
          )
          .bind(linked.membership_id)
          .all()
      ).results.map((row) => row.collection_id),
      [mappedCollectionId, manualCollectionId].sort()
    )
    assert.equal(
      (
        await db
          .prepare(
            `SELECT count(*) AS n FROM vault_directory_collection_grant WHERE membership_id = ?`
          )
          .bind(linked.membership_id)
          .first()
      ).n,
      0
    )
    await assert.rejects(
      reconcileVaultDirectory(
        env,
        async () => new Response("", { status: 503 })
      ),
      /503/
    )
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(linked.membership_id)
          .first()
      ).status,
      2
    )
    const notified = []
    const recordNotification = async (userId) => {
      notified.push(userId)
    }
    await reconcileVaultDirectory(env, snapshot([]), recordNotification)
    assert.deepEqual(notified.sort(), [ownerId, manualId, targetId].sort())
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(linked.membership_id)
          .first()
      ).status,
      3
    )
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(manualMembershipId)
          .first()
      ).status,
      2
    )
    notified.length = 0
    await reconcileVaultDirectory(env, snapshot([scimUser]), recordNotification)
    assert.deepEqual(notified.sort(), [ownerId, manualId, targetId].sort())
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(linked.membership_id)
          .first()
      ).status,
      2
    )
    await reconcileVaultDirectory(
      env,
      snapshot([{ ...scimUser, userName: "changed@example.test" }])
    )
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(linked.membership_id)
          .first()
      ).status,
      3
    )
    assert.equal(
      (
        await db
          .prepare(
            `SELECT membership_id FROM vault_directory_identity WHERE org_id = ?`
          )
          .bind(orgId)
          .first()
      ).membership_id,
      linked.membership_id
    )
    await db
      .prepare(`UPDATE vault_user SET email = ? WHERE id = ?`)
      .bind("changed@example.test", targetId)
      .run()
    await reconcileVaultDirectory(
      env,
      snapshot([{ ...scimUser, userName: "changed@example.test" }])
    )
    const replacementId = (
      await db
        .prepare(
          `SELECT membership_id FROM vault_directory_identity WHERE org_id = ?`
        )
        .bind(orgId)
        .first()
    ).membership_id
    assert.equal(replacementId, linked.membership_id)
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(replacementId)
          .first()
      ).status,
      2
    )
    await db
      .prepare(`UPDATE vault_user SET email = ? WHERE id = ?`)
      .bind("renamed@example.test", targetId)
      .run()
    await reconcileVaultDirectory(
      env,
      snapshot([{ ...scimUser, userName: "changed@example.test" }])
    )
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(replacementId)
          .first()
      ).status,
      3
    )
    const newcomer = {
      id: "c1850bc4-fe8c-42cd-97c4-88a61cfaa3a5",
      userName: "newcomer@example.test",
      displayName: "Newcomer",
      active: true,
    }
    const sent = []
    let failOnce = true
    const mailEnv = {
      ...env,
      APP_URL: "https://vault.example.test",
      EMAIL_FROM: "vault@example.test",
      ORG_INVITATION_EMAILS_ENABLED: "true",
      BETTER_AUTH_SECRET: "local-scim-invitation-signing-secret-2026",
      EMAIL: {
        send: async (message) => {
          if (failOnce) {
            failOnce = false
            throw new Error("simulated mail failure")
          }
          sent.push(message)
        },
      },
    }
    await assert.rejects(
      reconcileVaultDirectory(mailEnv, snapshot([newcomer])),
      /simulated mail failure/
    )
    const identity = await db
      .prepare(`SELECT * FROM vault_directory_identity WHERE external_id = ?`)
      .bind(newcomer.id)
      .first()
    assert.ok(identity.membership_id)
    assert.equal(identity.invitation_sent_at, null)
    assert.equal(
      (
        await db
          .prepare(`SELECT status FROM vault_membership WHERE id = ?`)
          .bind(identity.membership_id)
          .first()
      ).status,
      0
    )
    await reconcileVaultDirectory(mailEnv, snapshot([newcomer]))
    assert.equal(sent.length, 1)
    assert.match(sent[0].text, /accept-organization/)
    await reconcileVaultDirectory(mailEnv, snapshot([newcomer]))
    assert.equal(sent.length, 1)
  } finally {
    await vite?.close()
    await proxy?.dispose()
    rmSync(storage, { recursive: true, force: true })
  }
})
