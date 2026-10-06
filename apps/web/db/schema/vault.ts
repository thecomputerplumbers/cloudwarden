import {
  index,
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
    deviceName: text("device_name").notNull().default("Unknown device"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }),
    clientId: text("client_id").notNull().default("unknown"),
    securityStamp: text("security_stamp"),
    apiKey: integer("api_key", { mode: "boolean" }).notNull().default(false),
    apiKeyHash: text("api_key_hash"),
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
    index("vault_session_user_device_idx").on(table.userId, table.deviceId),
    uniqueIndex("vault_session_access_unique").on(table.accessHash),
    uniqueIndex("vault_session_previous_access_unique").on(
      table.previousAccessHash
    ),
    uniqueIndex("vault_session_refresh_unique").on(table.refreshHash),
  ]
)

export const vaultDevice = sqliteTable(
  "vault_device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    deviceId: text("device_id").notNull(),
    deviceType: integer("device_type").notNull(),
    deviceName: text("device_name").notNull(),
    twoFactorRememberHash: text("two_factor_remember_hash"),
    twoFactorRememberExpiresAt: integer("two_factor_remember_expires_at", {
      mode: "timestamp_ms",
    }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [
    uniqueIndex("vault_device_user_device_unique").on(
      table.userId,
      table.deviceId
    ),
  ]
)

export const vaultApiKey = sqliteTable("vault_api_key", {
  userId: text("user_id")
    .primaryKey()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  secretHash: text("secret_hash").notNull(),
  sealedSecret: text("sealed_secret").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
})

export const vaultProtectedOtp = sqliteTable("vault_protected_otp", {
  userId: text("user_id")
    .primaryKey()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  codeHash: text("code_hash").notNull(),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  attempts: integer("attempts").notNull().default(0),
})

export const vaultAuthRequest = sqliteTable(
  "vault_auth_request",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => vaultUser.id, { onDelete: "cascade" }),
    requestDeviceId: text("request_device_id").notNull(),
    deviceType: integer("device_type").notNull(),
    requestIp: text("request_ip").notNull(),
    accessCodeHash: text("access_code_hash").notNull(),
    publicKey: text("public_key").notNull(),
    encryptedKey: text("encrypted_key"),
    sealedMasterPasswordHash: text("sealed_master_password_hash"),
    approved: integer("approved", { mode: "boolean" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    responseAt: integer("response_at", { mode: "timestamp_ms" }),
    authenticatedAt: integer("authenticated_at", { mode: "timestamp_ms" }),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [index("vault_auth_request_user_idx").on(table.userId)]
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

export const vaultEmailTwoFactor = sqliteTable("vault_email_two_factor", {
  userId: text("user_id")
    .primaryKey()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  email: text("email"),
  pendingEmail: text("pending_email"),
  pendingCodeHash: text("pending_code_hash"),
  pendingCodeExpiresAt: integer("pending_code_expires_at", {
    mode: "timestamp_ms",
  }),
  loginCodeHash: text("login_code_hash"),
  loginCodeExpiresAt: integer("login_code_expires_at", {
    mode: "timestamp_ms",
  }),
  loginAttempts: integer("login_attempts").notNull().default(0),
  recoveryCode: text("recovery_code"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
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

// A cross-object share is retried by the scheduled handler until its R2 copy,
// organization locator, and personal vault cleanup have all completed.
export const vaultCipherTransfer = sqliteTable("vault_cipher_transfer", {
  cipherId: text("cipher_id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  orgId: text("org_id")
    .notNull()
    .references(() => vaultOrganization.id, { onDelete: "cascade" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  prepared: integer("prepared", { mode: "boolean" }).notNull().default(false),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
})

// Organization imports stage encrypted ciphers in the organization Durable
// Object, then publish collections and cipher locators in one D1 batch.
export const vaultOrgImport = sqliteTable("vault_org_import", {
  id: text("id").primaryKey(),
  orgId: text("org_id")
    .notNull()
    .references(() => vaultOrganization.id, { onDelete: "cascade" }),
  userId: text("user_id")
    .notNull()
    .references(() => vaultUser.id, { onDelete: "cascade" }),
  payload: text("payload").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  leaseId: text("lease_id"),
  leaseUntil: integer("lease_until", { mode: "timestamp_ms" }),
})
