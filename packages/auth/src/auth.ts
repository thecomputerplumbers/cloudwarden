import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { mcp } from "@better-auth/mcp"
import {
  consentGrant,
  requireGrant,
  MCP_SCOPES,
  hasGrantSelection,
} from "@workspace/auth/grants"
import { organization, jwt } from "better-auth/plugins"

import type { AuthDb } from "@workspace/auth/db"
import * as schema from "@workspace/auth/schema"

export type CreateAuthOptions = {
  db: AuthDb
  /**
   * Signs session cookies and tokens. Rotating it signs everyone out.
   * Required outside local development — see `resolveSecret`.
   */
  secret: string
  /** The app's own origin, e.g. `https://example.com`. */
  baseURL?: string
  trustedOrigins?: string[]
  /**
   * Delivers the reset link. Without it, password reset is disabled rather
   * than silently broken — a reset flow that cannot send mail is worse than
   * no reset flow, because it tells people a mail is coming.
   */
  sendResetPassword?: (input: {
    user: { email: string; name: string }
    url: string
  }) => Promise<void>
  sendVerificationEmail?: (input: {
    user: { email: string; name: string }
    url: string
  }) => Promise<void>
  sendInvitationEmail?: (input: {
    id: string
    email: string
    role: string
    organization: { name: string }
  }) => Promise<void>
  /** Appended to the built-in plugins. */
  plugins?: Parameters<typeof betterAuth>[0]["plugins"]
}

/**
 * Builds the Better Auth instance.
 *
 * Do not call this at module scope in a Worker: Better Auth starts plugin
 * setup — including database queries — as soon as it is constructed, and
 * workerd forbids I/O outside a request handler. Use `lazyAuth` below, or
 * construct it inside the handler.
 */
export function createAuth(options: CreateAuthOptions) {
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: "sqlite",
      schema,
    }),
    secret: options.secret,
    baseURL: options.baseURL,
    trustedOrigins: options.trustedOrigins,

    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      // Reset links are single-use and short-lived; 30 minutes is long enough
      // to find the mail and short enough that a leaked inbox ages out.
      resetPasswordTokenExpiresIn: 30 * 60,
      // A password change means the old password may be compromised, so every
      // other session goes with it.
      revokeSessionsOnPasswordReset: true,
      ...(options.sendResetPassword
        ? { sendResetPassword: options.sendResetPassword }
        : {}),
    },

    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      expiresIn: 3600,
      sendVerificationEmail: options.sendVerificationEmail,
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },

    advanced: {
      // Cloudflare puts the real client address here; without this every
      // session records the edge's address and rate limits become useless.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      database: { generateId: "uuid" },
    },

    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        "/sign-in/email": { window: 60, max: 10 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/reset-password": { window: 60, max: 10 },
        "/send-verification-email": { window: 3600, max: 5 },
        "/oauth2/register": { window: 3600, max: 20 },
      },
    },

    plugins: [
      organization({
        requireEmailVerificationOnInvitation: true,
        allowUserToCreateOrganization: (user) => user.emailVerified,
        sendInvitationEmail: options.sendInvitationEmail,
        cancelPendingInvitationsOnReInvite: true,
      }),
      jwt(),
      mcp({
        resource: `${options.baseURL}/mcp`,
        loginPage: "/sign-in",
        consentPage: "/connect",
        scopes: [...MCP_SCOPES],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "organization:read",
          "billing:read",
          "projects:read",
        ],
        clientRegistrationAllowedScopes: [
          "organization:write",
          "projects:write",
        ],
        accessTokenExpiresIn: 300,
        postLogin: {
          page: "/connect",
          shouldRedirect: async () => !hasGrantSelection(),
          consentReferenceId: async ({ user, scopes }) => {
            if (!user.emailVerified) throw new Error("Verify your email first")
            return (await consentGrant(options.db, user.id, scopes)).id
          },
        },
        customAccessTokenClaims: async ({ user, referenceId }) => {
          if (!user || !referenceId)
            throw new Error("Organization grant required")
          const grant = await requireGrant(options.db, referenceId, user.id)
          return { grant_id: grant.id, organization_id: grant.organizationId }
        },
      }),
      ...(options.plugins ?? []),
    ],
  })
}

export type Auth = ReturnType<typeof createAuth>

/**
 * Defers construction to the first property access, which is always inside a
 * request. Export the returned proxy as `auth` and use it like the instance.
 */
export function lazyAuth(factory: () => Auth): Auth {
  let instance: Auth | undefined
  const resolve = () => (instance ??= factory())

  return new Proxy({} as Auth, {
    get: (_target, property) => Reflect.get(resolve(), property),
    has: (_target, property) => Reflect.has(resolve(), property),
  })
}

const DEVELOPMENT_SECRET = "cloudwarden-development-secret-change-me"

/**
 * Refuses to fall back to the development secret anywhere but localhost.
 *
 * A shared default secret in production means anyone who has read this
 * repository can mint a valid session cookie for any account.
 */
export function resolveSecret(
  secret: string | undefined,
  appUrl: string | undefined
) {
  const local =
    !!appUrl && /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?$/.test(appUrl)

  if (!secret && !local) {
    throw new Error(
      "BETTER_AUTH_SECRET must be set outside local development " +
        "(generate one with `openssl rand -base64 32`)"
    )
  }

  return secret || DEVELOPMENT_SECRET
}
