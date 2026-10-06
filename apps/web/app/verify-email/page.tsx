import { AuthPage } from "@/components/auth-page"
import { EmailFlow } from "@/components/email-flow"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>
}) {
  const { email } = await searchParams
  return (
    <AuthPage title="Check your inbox">
      <p className="mb-5 text-muted-foreground">
        Verify your email address to continue. The link expires in one hour.
      </p>
      <EmailFlow mode="verify" initialEmail={email} />
    </AuthPage>
  )
}
