import { AuthPage } from "@/components/auth-page"
import { EmailFlow } from "@/components/email-flow"
export default function Page() {
  return (
    <AuthPage title="Reset your password">
      <EmailFlow mode="forgot" />
    </AuthPage>
  )
}
