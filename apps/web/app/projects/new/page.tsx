import Link from "next/link"
import { notFound } from "next/navigation"
import { roleAtLeast } from "@workspace/auth"
import { AccountPage } from "@/components/account-page"
import { requireActiveOrganization } from "@/lib/session"
import { ProjectForm } from "../project-form"
import product from "@/config/product.json"
export default async function Page() {
  if (!product.features.projects) notFound()
  const { organizationId, membership } = await requireActiveOrganization()
  if (!roleAtLeast(membership.role, "admin")) notFound()
  return (
    <AccountPage title="New project">
      <Link className="underline" href="/projects">
        All projects
      </Link>
      <ProjectForm organizationId={organizationId} />
    </AccountPage>
  )
}
