import { headers } from "next/headers"
import { AccountPage } from "@/components/account-page"
import { ActionButton } from "@/components/action-button"
import { requireServerSession } from "@/lib/session"
import { auth } from "@/lib/auth"
import { AccountForm } from "./account-form"
export default async function Page() {
  const current = await requireServerSession()
  const sessions = await auth.api.listSessions({ headers: await headers() })
  return (
    <AccountPage title="Your account">
      <p>{current.user.email} · Verified</p>
      <AccountForm name={current.user.name} />
      <section className="space-y-4">
        <h2 className="text-lg font-semibold">Signed-in devices</h2>
        {sessions.map((session) => (
          <div className="rounded-lg border p-4" key={session.id}>
            <p className="text-sm break-words">
              {session.userAgent ?? "Unknown device"}
              {session.id === current.session.id ? " · This device" : ""}
            </p>
            <p className="my-2 text-sm text-muted-foreground">
              Signed in {session.createdAt.toLocaleDateString("en-US")}
            </p>
            <ActionButton
              label="Sign out device"
              path="/api/account/sessions"
              body={{ id: session.id }}
              redirectTo={
                session.id === current.session.id ? "/sign-in" : undefined
              }
            />
          </div>
        ))}
      </section>
    </AccountPage>
  )
}
