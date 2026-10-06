export type DirectoryUser = {
  id: string
  email: string
  name: string
  active: boolean
  groups?: { id: string; name: string }[]
}

type ScimUser = {
  id?: unknown
  userName?: unknown
  displayName?: unknown
  active?: unknown
  groups?: unknown
}

type ScimPage = {
  totalResults?: unknown
  startIndex?: unknown
  itemsPerPage?: unknown
  Resources?: unknown
  "urn:thecomputerplumbers:scim:directoryVersion"?: unknown
}

/** Read every page before callers make any membership changes. */
export async function readVaultDirectory(
  source: string,
  token: string,
  fetcher: typeof fetch = fetch
): Promise<DirectoryUser[]> {
  const endpoint = new URL(source)
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !token
  )
    throw new Error("Invalid SCIM directory configuration")

  const users: ScimUser[] = []
  let total: number | undefined
  let version: string | undefined
  do {
    const pageUrl = new URL(endpoint)
    pageUrl.searchParams.set("startIndex", String(users.length + 1))
    pageUrl.searchParams.set("count", "100")
    const response = await fetcher(pageUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/scim+json",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok)
      throw new Error(`SCIM directory returned ${response.status}`)
    const page = (await response.json()) as ScimPage
    const pageVersion = page["urn:thecomputerplumbers:scim:directoryVersion"]
    if (
      !Number.isInteger(page.totalResults) ||
      (page.totalResults as number) < 0 ||
      (page.totalResults as number) > 10_000 ||
      !Array.isArray(page.Resources) ||
      page.itemsPerPage !== page.Resources.length ||
      page.startIndex !== users.length + 1 ||
      typeof pageVersion !== "string" ||
      !pageVersion ||
      (total !== undefined && total !== page.totalResults) ||
      (version !== undefined && version !== pageVersion)
    )
      throw new Error("SCIM directory snapshot changed or is invalid")
    total = page.totalResults as number
    version = pageVersion
    if (page.Resources.length === 0 && users.length < total)
      throw new Error("SCIM directory page is incomplete")
    users.push(...page.Resources)
    if (users.length > total) throw new Error("SCIM directory count mismatch")
  } while (users.length < total!)

  const ids = new Set<string>()
  const emails = new Set<string>()
  return users.map((user) => {
    if (!user || typeof user !== "object")
      throw new Error("SCIM directory user is invalid")
    const email =
      typeof user.userName === "string"
        ? user.userName.trim().toLowerCase()
        : ""
    if (
      typeof user.id !== "string" ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(user.id) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      email.length > 254 ||
      typeof user.displayName !== "string" ||
      typeof user.active !== "boolean" ||
      ids.has(user.id) ||
      emails.has(email)
    )
      throw new Error("SCIM directory user is invalid")
    ids.add(user.id)
    emails.add(email)
    let groups: { id: string; name: string }[] | undefined
    if (user.groups !== undefined) {
      if (
        !Array.isArray(user.groups) ||
        user.groups.length > 100 ||
        user.groups.some(
          (group) =>
            !group ||
            typeof group !== "object" ||
            typeof group.value !== "string" ||
            !group.value ||
            group.value.length > 255 ||
            (group.display !== undefined &&
              (typeof group.display !== "string" ||
                !group.display.trim() ||
                group.display.length > 100))
        )
      )
        throw new Error("SCIM directory groups are invalid")
      groups = user.groups.map((group) => ({
        id: group.value as string,
        name:
          (group.display as string | undefined)?.trim() ??
          (group.value as string),
      }))
      if (new Set(groups.map((group) => group.id)).size !== groups.length)
        throw new Error("SCIM directory groups are invalid")
    }
    return {
      id: user.id,
      email,
      name: user.displayName,
      active: user.active,
      ...(groups ? { groups } : {}),
    }
  })
}
