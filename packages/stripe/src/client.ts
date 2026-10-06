import { requireSecretKey, type StripeConfig } from "@workspace/stripe/config"

/**
 * A small Stripe client built on `fetch` and `crypto.subtle`.
 *
 * The official `stripe` package pulls in Node built-ins and its own HTTP
 * agent, which is more than workerd wants to carry. Stripe's REST API is
 * form-encoded and unremarkable, so this talks to it directly: no SDK, no
 * polyfills, and the same code runs in `wrangler dev` and in production.
 */

export class StripeError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly type: string | undefined
  readonly declineCode: string | undefined
  readonly requestId: string | undefined
  readonly raw: unknown

  constructor(
    message: string,
    init: {
      status: number
      code?: string
      type?: string
      declineCode?: string
      requestId?: string
      raw?: unknown
    }
  ) {
    super(message)
    this.name = "StripeError"
    this.status = init.status
    this.code = init.code
    this.type = init.type
    this.declineCode = init.declineCode
    this.requestId = init.requestId
    this.raw = init.raw
  }
}

/** Values Stripe's form encoding understands, nested to any depth. */
export type StripeParamValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined
  | StripeParams
  | StripeParamValue[]

export interface StripeParams {
  [key: string]: StripeParamValue
}

/**
 * Flattens parameters into Stripe's bracket notation:
 * `{ line_items: [{ price: "x" }] }` → `line_items[0][price]=x`.
 *
 * `undefined` and `null` are dropped so optional arguments can be passed
 * through without building the object conditionally. Dates become Unix
 * seconds, which is what every Stripe timestamp field expects.
 */
export function encodeStripeParams(
  params: StripeParams,
  target = new URLSearchParams(),
  prefix?: string
): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    const path = prefix ? `${prefix}[${key}]` : key
    appendParam(target, path, value)
  }
  return target
}

function appendParam(
  target: URLSearchParams,
  path: string,
  value: StripeParamValue
) {
  if (value === undefined || value === null) return

  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      appendParam(target, `${path}[${index}]`, entry)
    )
    return
  }

  if (value instanceof Date) {
    target.set(path, String(Math.floor(value.getTime() / 1000)))
    return
  }

  if (typeof value === "object") {
    encodeStripeParams(value, target, path)
    return
  }

  target.set(path, String(value))
}

export type StripeRequestOptions = {
  method?: "GET" | "POST" | "DELETE"
  params?: StripeParams
  /**
   * Makes a retried POST safe. Stripe keys are scoped to 24 hours, so build
   * one from something stable about the attempt rather than a random value.
   */
  idempotencyKey?: string
  /** Network and 5xx retries. Defaults to 2 (three attempts in total). */
  maxRetries?: number
  signal?: AbortSignal
}

type StripeErrorBody = {
  error?: {
    message?: string
    code?: string
    type?: string
    decline_code?: string
  }
}

const RETRYABLE_STATUS = new Set([409, 429, 500, 502, 503, 504])

export type StripeClient = ReturnType<typeof createStripeClient>

/**
 * ```ts
 * const stripe = createStripeClient(getStripeConfig(env))
 * const customer = await stripe.post<Customer>("customers", { email })
 * ```
 */
export function createStripeClient(
  config: StripeConfig<string>,
  { baseUrl = "https://api.stripe.com/v1" }: { baseUrl?: string } = {}
) {
  const secretKey = requireSecretKey(config)

  async function request<T>(
    path: string,
    options: StripeRequestOptions = {}
  ): Promise<T> {
    const {
      method = "GET",
      params,
      idempotencyKey,
      maxRetries = 2,
      signal,
    } = options

    const body =
      method === "GET" || !params ? undefined : encodeStripeParams(params)
    const query =
      method === "GET" && params
        ? `?${encodeStripeParams(params).toString()}`
        : ""

    const headers: Record<string, string> = {
      Authorization: `Bearer ${secretKey}`,
    }
    if (body) headers["Content-Type"] = "application/x-www-form-urlencoded"
    if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey
    if (config.apiVersion) headers["Stripe-Version"] = config.apiVersion

    let lastError: unknown

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let response: Response
      try {
        response = await fetch(`${baseUrl}/${path}${query}`, {
          method,
          headers,
          body,
          signal,
        })
      } catch (error) {
        // A dropped connection may have reached Stripe anyway, so only retry
        // when the caller gave us an idempotency key or the call is a read.
        lastError = error
        if (attempt < maxRetries && (method === "GET" || idempotencyKey)) {
          await backoff(attempt)
          continue
        }
        throw error
      }

      const payload = (await response.json()) as T & StripeErrorBody

      if (response.ok) return payload

      if (attempt < maxRetries && RETRYABLE_STATUS.has(response.status)) {
        await backoff(attempt)
        continue
      }

      throw new StripeError(
        payload.error?.message ?? `Stripe returned ${response.status}`,
        {
          status: response.status,
          code: payload.error?.code,
          type: payload.error?.type,
          declineCode: payload.error?.decline_code,
          requestId: response.headers.get("request-id") ?? undefined,
          raw: payload,
        }
      )
    }

    throw lastError instanceof Error
      ? lastError
      : new StripeError("Stripe request failed", { status: 0, raw: lastError })
  }

  return {
    config,
    request,
    get: <T>(
      path: string,
      params?: StripeParams,
      options?: StripeRequestOptions
    ) => request<T>(path, { ...options, method: "GET", params }),
    post: <T>(
      path: string,
      params?: StripeParams,
      options?: StripeRequestOptions
    ) => request<T>(path, { ...options, method: "POST", params }),
    delete: <T>(path: string, options?: StripeRequestOptions) =>
      request<T>(path, { ...options, method: "DELETE" }),
  }
}

/** Exponential backoff with jitter, capped so a worker never sits too long. */
function backoff(attempt: number) {
  const base = Math.min(2000, 250 * 2 ** attempt)
  const delay = base / 2 + Math.random() * (base / 2)
  return new Promise((resolve) => setTimeout(resolve, delay))
}
