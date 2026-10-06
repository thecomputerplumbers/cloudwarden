import { safeReturnPath } from "@workspace/stripe"
import Link from "next/link"
import { redirect } from "next/navigation"

import { AuthForm } from "@workspace/auth/react/auth-form"
import {
  OrnamentedSurface,
  FloatingOrnaments,
} from "@workspace/ui-shell/components/ornaments"

import { getServerSession } from "@/lib/session"

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined
        ? []
        : (Array.isArray(value) ? value : [value]).map((item) => [key, item])
    )
  ).toString()
  if (!params.client_id && (await getServerSession())) redirect("/dashboard")

  return (
    <OrnamentedSurface className="flex items-center justify-center p-6">
      <FloatingOrnaments intensity="quiet" />
      <div className="relative z-10 flex w-full justify-center">
        <AuthForm
          mode="sign-in"
          redirectTo={safeReturnPath(params.next, "/onboarding")}
          onSwitchMode={
            <>
              <Link className="underline" href="/forgot-password">
                Forgot your password?
              </Link>
              <br />
              No account yet?{" "}
              <Link
                className="underline underline-offset-4"
                href={`/sign-up${query ? `?${query}` : ""}`}
              >
                Create one
              </Link>
            </>
          }
        />
      </div>
    </OrnamentedSurface>
  )
}
