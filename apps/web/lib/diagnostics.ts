import { AsyncLocalStorage } from "node:async_hooks"
import { publicError } from "./errors"
const requests = new AsyncLocalStorage<{ requestId: string }>()
export const requestId = () => requests.getStore()?.requestId
// Allowlisted fields only: never serialize arbitrary errors, headers, URLs or payloads.
export function logEvent(
  event: string,
  fields: {
    status?: number
    durationMs?: number
    code?: string
    operation?: string
  } = {}
) {
  console.log(
    JSON.stringify({
      event,
      requestId: requestId(),
      status: fields.status,
      durationMs: fields.durationMs,
      code: fields.code,
      operation: fields.operation,
    })
  )
}
export function logError(error: unknown, operation: string) {
  logEvent("operation.failed", { operation, code: publicError(error).code })
}
export async function observeRequest(
  _request: Request,
  handle: () => Promise<Response>
) {
  const id = crypto.randomUUID(),
    start = performance.now()
  return requests.run({ requestId: id }, async () => {
    let response: Response
    try {
      response = await handle()
    } catch (error) {
      logError(error, "request")
      response = Response.json(
        { ...publicError(error), requestId: id },
        { status: 500 }
      )
    }
    const headers = new Headers(response.headers)
    headers.set("X-Request-ID", id)
    logEvent("request.completed", {
      status: response.status,
      durationMs: Math.round(performance.now() - start),
    })
    // Preserve Workers-specific upgrade responses.
    if (response.status === 101) return response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}
