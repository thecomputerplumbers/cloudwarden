import { env } from "cloudflare:workers"
import {
  createAuth,
  createAuthDb,
  lazyAuth,
  resolveSecret,
} from "@workspace/auth"

import { createMailer } from "@workspace/email"

export const auth = lazyAuth(() => {
  if (!env.APP_URL) throw new Error("APP_URL must be configured")
  const origin = new URL(env.APP_URL).origin
  const local = ["localhost", "127.0.0.1"].includes(new URL(origin).hostname)
  const mail = createMailer(
    env.EMAIL,
    env.EMAIL_FROM ?? (local ? "cloudwarden@example.com" : "")
  )
  return createAuth({
    db: createAuthDb(env.DB),
    secret: resolveSecret(env.BETTER_AUTH_SECRET, env.APP_URL),
    baseURL: origin,
    trustedOrigins: [origin],
    sendVerificationEmail: ({ user, url }) =>
      mail({
        to: user.email,
        subject: "Verify your email",
        message:
          "Confirm your email address to finish setting up your account.",
        url,
        label: "Verify email",
      }),
    sendResetPassword: ({ user, url }) =>
      mail({
        to: user.email,
        subject: "Reset your password",
        message:
          "Use this link to choose a new password. It expires in 30 minutes.",
        url,
        label: "Reset password",
      }),
    sendInvitationEmail: ({ email, id, organization, role }) =>
      mail({
        to: email,
        subject: `Invitation to ${organization.name}`,
        message: `You have been invited to ${organization.name} as ${role}.`,
        url: `${origin}/invitations/${encodeURIComponent(id)}`,
        label: "Review invitation",
      }),
  })
})
