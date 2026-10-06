import { AuthPage } from "@/components/auth-page"
import { EmailFlow } from "@/components/email-flow"
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>
}) {
  const { token } = await searchParams
  return (
    <AuthPage title="Choose a new password">
      <EmailFlow mode="reset" token={token} />
    </AuthPage>
  )
}
