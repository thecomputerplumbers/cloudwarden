import { auth } from "@/lib/auth"

/**
 * Every Better Auth endpoint: sign-in, sign-up, sessions, password reset,
 * and the organization plugin's routes.
 *
 * The handler owns its own responses, including `Set-Cookie`, so the request
 * is passed through untouched rather than being wrapped.
 */
export function GET(request: Request) {
  return auth.handler(request)
}

export function POST(request: Request) {
  return auth.handler(request)
}
