export type ErrorCode =
  | "INVALID_INPUT"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL"
const statuses: Record<ErrorCode, number> = {
  INVALID_INPUT: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL: 500,
}
export class AppError extends Error {
  code: ErrorCode
  fields?: Record<string, string>
  constructor(
    code: ErrorCode,
    message: string,
    fields?: Record<string, string>
  ) {
    super(message)
    this.name = "AppError"
    this.code = code
    this.fields = fields
  }
  get status() {
    return statuses[this.code]
  }
}
export function publicError(error: unknown) {
  const safe =
    error instanceof AppError
      ? error
      : new AppError("INTERNAL", "Something went wrong. Please try again.")
  return {
    error: safe.message,
    code: safe.code,
    ...(safe.fields ? { fields: safe.fields } : {}),
  }
}
export function errorResponse(error: unknown, requestId?: string) {
  return Response.json(
    { ...publicError(error), ...(requestId ? { requestId } : {}) },
    { status: error instanceof AppError ? error.status : 500 }
  )
}
