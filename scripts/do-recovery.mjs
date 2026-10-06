import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { targetConfig } from "./project-lib.mjs"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function recoveryInput(args) {
  const [environment, action, kind, id, at, flag] = args
  if (
    !["staging", "production"].includes(environment) ||
    !["inspect", "restore"].includes(action) ||
    !["account", "organization"].includes(kind) ||
    !uuid.test(id ?? "") ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(at ?? "") ||
    !Number.isFinite(Date.parse(at)) ||
    (action === "restore" ? flag !== "--apply" : flag !== undefined)
  )
    throw new Error(
      "Usage: pnpm do:recovery staging|production inspect|restore account|organization UUID RFC3339_TIME [--apply]"
    )
  return { environment, action, kind, id, at }
}

export async function runRecovery(
  args,
  { token = process.env.RECOVERY_TOKEN } = {}
) {
  const input = recoveryInput(args)
  if (!token || token.length < 32)
    throw new Error("Set RECOVERY_TOKEN from the operator's secret manager")
  const config = targetConfig(input.environment)
  const body = {
    kind: input.kind,
    id: input.id,
    at: input.at,
    ...(input.action === "restore"
      ? { confirm: `RESTORE ${input.kind} ${input.id}` }
      : {}),
  }
  const response = await fetch(
    `${config.vars.APP_URL}/__ops/recovery/${input.action}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }
  )
  const result = await response.json().catch(() => null)
  if (!response.ok)
    throw new Error(
      `Recovery request failed (HTTP ${response.status}): ${result?.error ?? "no details"}`
    )
  return result
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const result = await runRecovery(process.argv.slice(2))
    console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
