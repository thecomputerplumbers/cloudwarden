import Link from "next/link"
import { headers } from "next/headers"
import { AuthPage } from "@/components/auth-page"
import { ActionButton } from "@/components/action-button"
import { getServerSession } from "@/lib/session"
import { auth } from "@/lib/auth"
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params,
    session = await getServerSession()
  if (!session)
    return (
      <AuthPage title="You have an invitation">
        <p>Sign in with the invited email address to review it.</p>
        <div className="mt-4 flex gap-4">
          <Link
            className="underline"
            href={`/sign-in?next=${encodeURIComponent(`/invitations/${id}`)}`}
          >
            Sign in
          </Link>
          <Link
            className="underline"
            href={`/sign-up?next=${encodeURIComponent(`/invitations/${id}`)}`}
          >
            Create account
          </Link>
        </div>
      </AuthPage>
    )
  if (!session.user.emailVerified)
    return (
      <AuthPage title="Verify your email">
        <Link className="underline" href="/verify-email">
          Verify your address before accepting this invitation.
        </Link>
      </AuthPage>
    )
  let invite
  try {
    invite = await auth.api.getInvitation({
      headers: await headers(),
      query: { id },
    })
  } catch {
    return (
      <AuthPage title="Invitation unavailable">
        <p>
          The invitation may have expired, been canceled, or belong to another
          email address.
        </p>
      </AuthPage>
    )
  }
  if (invite.status !== "pending" || invite.expiresAt < new Date())
    return (
      <AuthPage title="Invitation unavailable">
        <p>
          This invitation is no longer pending. Ask an administrator to resend
          it.
        </p>
      </AuthPage>
    )
  return (
    <AuthPage title={`Join ${invite.organizationName}`}>
      <p className="mb-5">
        Join as {invite.role} using {session.user.email}.
      </p>
      <div className="flex gap-3">
        <ActionButton
          label="Accept invitation"
          path="/api/auth/organization/accept-invitation"
          body={{ invitationId: id }}
          redirectTo="/onboarding"
        />
        <ActionButton
          label="Decline"
          path="/api/auth/organization/reject-invitation"
          body={{ invitationId: id }}
          redirectTo="/dashboard"
        />
      </div>
    </AuthPage>
  )
}
