import { and, eq } from "drizzle-orm"
import { member, user, organization, invitation } from "@workspace/auth/schema"
import { roleAtLeast } from "@workspace/auth"
import { AccountPage } from "@/components/account-page"
import { ActionButton } from "@/components/action-button"
import { requireActiveOrganization } from "@/lib/session"
import { getDb } from "@/db"
import { TeamForms, MemberRole } from "./team-forms"
export default async function Page() {
  const { organizationId, membership, session } =
      await requireActiveOrganization(),
    db = getDb()
  const members = await db
    .select({
      id: member.id,
      userId: member.userId,
      name: user.name,
      email: user.email,
      role: member.role,
    })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, organizationId))
  const [org] = await db
    .select()
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1)
  const admin = roleAtLeast(membership.role, "admin"),
    owner = roleAtLeast(membership.role, "owner")
  const pending = admin
    ? await db
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.organizationId, organizationId),
            eq(invitation.status, "pending")
          )
        )
    : []
  return (
    <AccountPage title="Organization">
      {admin && (
        <TeamForms organizationId={organizationId} name={org?.name ?? ""} />
      )}
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Members</h2>
        {members.map((row) => (
          <div
            key={row.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div>
              <p className="font-medium">{row.name}</p>
              <p className="text-sm text-muted-foreground">
                {row.email} · {row.role}
              </p>
            </div>
            {owner && (
              <MemberRole
                organizationId={organizationId}
                memberId={row.id}
                role={row.role}
              />
            )}
            {admin && row.userId !== session.user.id && (
              <ActionButton
                label="Remove member"
                path="/api/auth/organization/remove-member"
                body={{ organizationId, memberIdOrEmail: row.id }}
              />
            )}
          </div>
        ))}
      </section>
      {admin && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Invitations</h2>
          {!pending.length && <p>No pending invitations.</p>}
          {pending.map((invite) => (
            <div key={invite.id} className="rounded-lg border p-4">
              <p>
                {invite.email} · {invite.role}
              </p>
              <p className="my-2 text-sm">
                {invite.expiresAt < new Date() ? "Expired" : "Pending"}
              </p>
              <div className="flex gap-2">
                <ActionButton
                  label="Resend"
                  path="/api/auth/organization/invite-member"
                  body={{
                    organizationId,
                    email: invite.email,
                    role: invite.role,
                    resend: true,
                  }}
                />
                <ActionButton
                  label="Cancel"
                  path="/api/auth/organization/cancel-invitation"
                  body={{ invitationId: invite.id }}
                />
              </div>
            </div>
          ))}
        </section>
      )}
      <ActionButton
        label="Leave organization"
        path="/api/auth/organization/leave"
        body={{ organizationId }}
        redirectTo="/onboarding"
      />
    </AccountPage>
  )
}
