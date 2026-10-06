"use client"

import { oauthProviderClient } from "@better-auth/oauth-provider/client"
import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

/**
 * The browser client. Every plugin used on the server that has browser-facing
 * methods needs its client counterpart here, or calls like
 * `authClient.organization.create` are simply absent at runtime.
 *
 * No `baseURL`: same-origin is the default, which is what this app serves.
 */
export const authClient = createAuthClient({
  plugins: [organizationClient(), oauthProviderClient()],
})

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  organization,
  useActiveOrganization,
  useListOrganizations,
} = authClient

export type AuthClient = typeof authClient
