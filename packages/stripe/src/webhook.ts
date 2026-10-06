import {
  getStripeConfig,
  requireSecretKey,
  type StripeEnv,
} from "@workspace/stripe/config"
import type { StripeEvent } from "@workspace/stripe/types"

/**
 * Webhook verification, done with WebCrypto so it runs in workerd.
 *
 * A webhook endpoint is a public URL that grants entitlements, so the
 * signature is the only thing standing between it and anyone who can guess
 * the path. Two rules follow, and both are easy to get wrong:
 *
 *  1. Verify against the **raw request body**. `await request.text()` before
 *     parsing — re-serializing the JSON changes bytes and the HMAC will not
 *     match.
 *  2. Never trust the event body over your own records. Look the referenced
 *     object up by id and reconcile; do not grant access because a payload
 *     said to.
 */

export class StripeSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StripeSignatureError"
  }
}

/**
 * Verifies a `Stripe-Signature` header against the raw payload.
 *
 * The timestamp check is what stops a captured request from being replayed
 * later; the comparison is constant-time so a forged signature cannot be
 * refined one byte at a time.
 */
export async function verifyStripeSignature({
  payload,
  header,
  secret,
  toleranceSeconds = 300,
  now = Date.now(),
}: {
  payload: string
  header: string | null
  secret: string | undefined
  toleranceSeconds?: number
  now?: number
}): Promise<boolean> {
  if (!secret) throw new StripeSignatureError("No webhook secret configured")
  if (!header) return false

  const parts = header.split(",").map((part) => part.trim())
  const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2)
  const signatures = parts
    .filter((part) => part.startsWith("v1="))
    .map((part) => part.slice(3))

  if (!timestamp || signatures.length === 0) return false

  const issuedAt = Number(timestamp)
  if (!Number.isFinite(issuedAt)) return false
  if (Math.abs(now / 1000 - issuedAt) > toleranceSeconds) return false

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`)
  )
  const expected = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")

  // Stripe sends several v1 signatures while a secret is being rotated.
  return signatures.some((signature) => constantTimeEqual(signature, expected))
}

function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++)
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return mismatch === 0
}

export type ParsedStripeWebhook<T = Record<string, unknown>> = {
  event: StripeEvent<T>
}

/** Verifies this deployment's webhook secret and credential environment. */
export async function parseStripeWebhook<T = Record<string, unknown>>(
  request: Request,
  env: StripeEnv,
  { toleranceSeconds }: { toleranceSeconds?: number } = {}
): Promise<ParsedStripeWebhook<T>> {
  const payload = await request.text()

  let event: StripeEvent<T>
  try {
    event = JSON.parse(payload) as StripeEvent<T>
  } catch {
    throw new StripeSignatureError("Webhook payload is not valid JSON")
  }

  const config = getStripeConfig(env)
  requireSecretKey(config)

  const valid = await verifyStripeSignature({
    payload,
    header: request.headers.get("stripe-signature"),
    secret: config.webhookSecret,
    toleranceSeconds,
  })
  if (!valid) throw new StripeSignatureError("Invalid Stripe signature")

  if (
    typeof event.livemode !== "boolean" ||
    event.livemode !== config.livemode
  ) {
    throw new StripeSignatureError("Webhook does not belong to this deployment")
  }
  return { event }
}

/**
 * One handler per event type. The payload is only ever typed as an object
 * bag: cast it to the shape the type implies, e.g.
 * `event.data.object as StripeCheckoutSession`.
 */
export type StripeWebhookHandler = (
  event: StripeEvent<Record<string, unknown>>
) => void | Promise<void>

export type StripeWebhookOptions = {
  /** Keyed by event type, e.g. `"checkout.session.completed"`. */
  handlers: Record<string, StripeWebhookHandler>
  /**
   * Returns true only after an event completed successfully. This is a fast
   * duplicate check, not a lock: concurrent deliveries can both run. Handlers
   * must be idempotent, including retries after a failed completion write.
   */
  seen?: (
    event: StripeEvent<Record<string, unknown>>
  ) => Promise<boolean> | boolean
  /** Called after handlers succeed, to record the event id. */
  record?: (event: StripeEvent<Record<string, unknown>>) => Promise<void> | void
  onError?: (
    error: unknown,
    event?: StripeEvent<Record<string, unknown>>
  ) => void
  toleranceSeconds?: number
}

/**
 * Turns a set of handlers into a route handler.
 *
 * ```ts
 * export async function POST(request: Request) {
 *   return handleStripeWebhook(request, env, {
 *     seen: (event) => stripeEventSeen(db, event.id),
 *     record: (event) => recordStripeEvent(db, event),
 *     handlers: {
 *       "checkout.session.completed": async (event) => { … },
 *       "customer.subscription.updated": async (event) => { … },
 *     },
 *   })
 * }
 * ```
 *
 * A handler that throws produces a 500, which makes Stripe retry — that is
 * the behaviour you want for a transient failure, and the reason the
 * idempotency check has to come first.
 */
export async function handleStripeWebhook(
  request: Request,
  env: StripeEnv,
  options: StripeWebhookOptions
): Promise<Response> {
  let parsed: ParsedStripeWebhook
  try {
    parsed = await parseStripeWebhook(request, env, {
      toleranceSeconds: options.toleranceSeconds,
    })
  } catch (error) {
    options.onError?.(error)
    const message =
      error instanceof StripeSignatureError ? error.message : "Bad request"
    return new Response(message, { status: 400 })
  }

  const { event } = parsed

  try {
    if (await options.seen?.(event)) {
      return Response.json({ received: true, ignored: "duplicate" })
    }

    const handler = options.handlers[event.type]
    if (!handler) {
      // Unhandled types still get a 2xx, or Stripe retries them forever and
      // eventually disables the endpoint.
      await options.record?.(event)
      return Response.json({ received: true, ignored: "unhandled_type" })
    }

    await handler(event)
    await options.record?.(event)
    return Response.json({ received: true })
  } catch (error) {
    options.onError?.(error, event)
    return new Response("Webhook handler failed", { status: 500 })
  }
}
