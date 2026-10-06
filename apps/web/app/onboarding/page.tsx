import { listOrganizations } from "@workspace/auth"
import {
  FloatingOrnaments,
  OrnamentedSurface,
} from "@workspace/ui-shell/components/ornaments"

import { getDb } from "@/db"
import { requireServerSession } from "@/lib/session"
import { SelectOrganization } from "./select-organization"
import { CreateOrganization } from "./create-organization"

export default async function OnboardingPage() {
  const session = await requireServerSession()

  const existing = await listOrganizations(getDb(), session.user.id)

  return (
    <OrnamentedSurface className="flex items-center justify-center p-6">
      <FloatingOrnaments intensity="quiet" />
      <div className="relative z-10 flex w-full justify-center">
        {existing.length > 0 ? (
          <SelectOrganization
            organizations={existing.map(({ id, name }) => ({ id, name }))}
          />
        ) : (
          <CreateOrganization defaultName={`${session.user.name}'s team`} />
        )}
      </div>
    </OrnamentedSurface>
  )
}
