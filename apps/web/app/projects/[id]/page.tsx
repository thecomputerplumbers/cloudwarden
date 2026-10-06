import Link from "next/link"
import { notFound } from "next/navigation"
import { roleAtLeast } from "@workspace/auth"
import { AccountPage } from "@/components/account-page"
import { requireActiveOrganization } from "@/lib/session"
import { getDb } from "@/db"
import { getProject } from "@/operations/projects"
import { AppError } from "@/lib/errors"
import { ProjectForm } from "../project-form"
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { session, organizationId, membership } =
      await requireActiveOrganization(),
    { id } = await params
  let project
  try {
    project = await getProject(
      { db: getDb(), actor: { userId: session.user.id, organizationId } },
      id
    )
  } catch (error) {
    if (error instanceof AppError && error.code === "NOT_FOUND") notFound()
    throw error
  }
  return (
    <AccountPage title={project.name}>
      <Link href="/projects" className="underline">
        All projects
      </Link>
      {roleAtLeast(membership.role, "admin") ? (
        <ProjectForm
          organizationId={organizationId}
          project={{
            id: project.id,
            name: project.name,
            description: project.description,
            status: project.status,
            version: project.version,
          }}
        />
      ) : (
        <section>
          <p className="whitespace-pre-wrap">{project.description}</p>
          <p className="mt-4">Status: {project.status}</p>
          <p className="mt-4 text-sm text-muted-foreground">
            An admin can edit this project.
          </p>
        </section>
      )}
    </AccountPage>
  )
}
