import {
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core"

// Bitwarden credentials are separate from the starter's browser sessions. The
// client supplies a derived master-password hash; the server stores only a
// second, salted hash of that value.
export const vaultUser = sqliteTable(
  "vault_user",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    name: text("name").notNull(),
    passwordHash: text("password_hash").notNull(),
    passwordSalt: text("password_salt").notNull(),
    key: text("key").notNull(),
    privateKey: text("private_key"),
    publicKey: text("public_key"),
    kdf: integer("kdf").notNull(),
    kdfIterations: integer("kdf_iterations").notNull(),
    kdfMemory: integer("kdf_memory"),
    kdfParallelism: integer("kdf_parallelism"),
    securityStamp: text("security_stamp").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    deletingAt: integer("deleting_at", { mode: "timestamp_ms" }),
  },
  (table) => [uniqueIndex("vault_user_email_unique").on(table.email)]
)

export const vaultSession = sqliteTable(
  "vault_session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    deviceType: text("device_type").notNull().default("unknown"),
    clientId: text("client_id").notNull().default("unknown"),
    accessHash: text("access_hash").notNull(),
    previousAccessHash: text("previous_access_hash"),
    previousAccessExpiresAt: integer("previous_access_expires_at", {
      mode: "timestamp_ms",
    }),
    refreshHash: text("refresh_hash").notNull(),
    ssoIssuer: text("sso_issuer"),
    ssoRefreshToken: text("sso_refresh_token"),
    accessExpiresAt: integer("access_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
    refreshExpiresAt: integer("refresh_expires_at", {
      mode: "timestamp_ms",
    }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_session_access_unique").on(table.accessHash),
    uniqueIndex("vault_session_previous_access_unique").on(
      table.previousAccessHash
    ),
    uniqueIndex("vault_session_refresh_unique").on(table.refreshHash),
  ]
)

export const vaultSsoFlow = sqliteTable("vault_sso_flow", {
  id: text("id").primaryKey(),
  clientState: text("client_state").notNull(),
  clientChallenge: text("client_challenge").notNull(),
  clientRedirect: text("client_redirect").notNull(),
  providerVerifier: text("provider_verifier").notNull(),
  nonce: text("nonce").notNull(),
  bindingHash: text("binding_hash").notNull(),
  providerCode: text("provider_code"),
  providerRefreshToken: text("provider_refresh_token"),
  userId: text("user_id").references(() => vaultUser.id, {
    onDelete: "set null",
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp_ms" }),
})

export const vaultSsoIdentity = sqliteTable(
  "vault_sso_identity",
  {
    id: text("id").primaryKey(),
    issuer: text("issuer").notNull(),
    subject: text("subject").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_sso_identity_subject_unique").on(
      table.issuer,
      table.subject
    ),
    uniqueIndex("vault_sso_identity_user_unique").on(
      table.issuer,
      table.userId
    ),
  ]
)

export const vaultTotp = sqliteTable("vault_totp", {
  userId: text("user_id")
    .primaryKey()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  secret: text("secret").notNull(),
  lastUsedStep: integer("last_used_step").notNull().default(0),
  recoveryCode: text("recovery_code").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

// Public Send URLs resolve to the owner's Durable Object through this index.
// The encrypted content and access counter remain in that object.
export const vaultSendLocator = sqliteTable("vault_send_locator", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
})

export const vaultOrganization = sqliteTable("vault_organization", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  billingEmail: text("billing_email").notNull(),
  publicKey: text("public_key"),
  privateKey: text("private_key"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  deletingAt: integer("deleting_at", { mode: "timestamp_ms" }),
})

export const vaultMembership = sqliteTable(
  "vault_membership",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    key: text("key"),
    role: integer("role").notNull(),
    status: integer("status").notNull(),
    accessAll: integer("access_all", { mode: "boolean" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_membership_org_user_unique").on(
      table.orgId,
      table.userId
    ),
  ]
)

// Directory identities are tracked separately from vault accounts. A SCIM
// user cannot access encrypted organization data until an account exists and
// an owner confirms its organization key.
export const vaultDirectoryIdentity = sqliteTable(
  "vault_directory_identity",
  {
    id: text("id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => vaultOrganization.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    membershipId: text("membership_id").references(() => vaultMembership.id, {
      onDelete: "set null",
    }),
    invitationSentAt: integer("invitation_sent_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_directory_identity_org_external_unique").on(
      table.orgId,
      table.externalId
    ),
    uniqueIndex("vault_directory_identity_membership_unique").on(
      table.membershipId
    ),
  ]
)

export const vaultCollection = sqliteTable("vault_collection", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => vaultOrganization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  externalId: text("external_id"),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultCollectionMember = sqliteTable(
  "vault_collection_member",
  {
    collectionId: text("collection_id")
      .notNull()
      .references(() => vaultCollection.id, { onDelete: "cascade" }),
    membershipId: text("membership_id")
      .notNull()
      .references(() => vaultMembership.id, { onDelete: "cascade" }),
    readOnly: integer("read_only", { mode: "boolean" })
      .notNull()
      .default(false),
    hidePasswords: integer("hide_passwords", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (table) => [
    uniqueIndex("vault_collection_member_unique").on(
      table.collectionId,
      table.membershipId
    ),
  ]
)

export const vaultOrgCipher = sqliteTable("vault_org_cipher", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => vaultOrganization.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultOrgCipherCollection = sqliteTable(
  "vault_org_cipher_collection",
  {
    cipherId: text("cipher_id")
      .notNull()
      .references(() => vaultOrgCipher.id, { onDelete: "cascade" }),
    collectionId: text("collection_id")
      .notNull()
      .references(() => vaultCollection.id, { onDelete: "cascade" }),
  },
  (table) => [
    uniqueIndex("vault_org_cipher_collection_unique").on(
      table.cipherId,
      table.collectionId
    ),
  ]
)
